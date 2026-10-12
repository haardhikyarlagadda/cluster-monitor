"""monitor/demo_traffic.py – Simulated Kuma mesh traffic for demo mode.

Produces what the Kuma collector will later read from Prometheus:
  * Edges   – caller -> callee with rps, p50/p95/p99 and 5xx share
              (Kuma: envoy_cluster_upstream_rq_* by kuma_workload / envoy_cluster_name)
  * TrafficSummary per deployment – inbound rps, latency, errors
              (Kuma: envoy_http_downstream_rq_* on self_inbound_dp_*)

Latency is tied to CPU: a CPU-starved deployment answers slower and starts
failing, and the slowdown propagates up to everything that calls it.
"""
from __future__ import annotations
import random
from typing import Dict, List, Optional, Tuple

from .config import Settings
from .model import Cluster, Deployment, Edge, External, TrafficSummary, classify_traffic

# Things outside the mesh: (name, kind)
_EXTERNALS = {
    "ingress":    "ingress",
    "postgres":   "database",
    "kafka":      "queue",
    "s3":         "storage",
    "stripe-api": "api",
}

# Logical calls between services (primary deployment names, "ns/name" or "ext:<name>"):
# (caller, callee, protocol, base requests/s). Calls whose ends don't exist in a
# cluster (e.g. prod-only services) are skipped.
_CALLS: List[Tuple[str, str, str, float]] = [
    ("ext:ingress",                 "web/frontend",                "http", 220),
    ("ext:ingress",                 "platform/api-gateway",        "http", 140),
    ("web/frontend",                "web/bff-api",                 "http", 200),
    ("web/frontend",                "web/cdn-proxy",               "http",  60),
    ("platform/api-gateway",        "web/bff-api",                 "http", 120),
    ("platform/api-gateway",        "platform/auth-service",       "grpc", 140),
    ("platform/api-gateway",        "platform/rate-limiter",       "grpc", 140),
    ("web/bff-api",                 "platform/auth-service",       "grpc", 260),
    ("web/bff-api",                 "payments/checkout-api",       "http",  45),
    ("web/bff-api",                 "orders/order-service",        "http",  90),
    ("web/bff-api",                 "web/search-api",              "http",  70),
    ("web/bff-api",                 "platform/config-server",      "http",   2),
    ("payments/checkout-api",       "payments/payment-processor",  "grpc",  40),
    ("payments/checkout-api",       "orders/order-service",        "http",  38),
    ("payments/checkout-api",       "platform/config-server",      "http",   2),
    ("payments/payment-processor",  "payments/fraud-detector",     "grpc",  40),
    ("payments/payment-processor",  "ext:stripe-api",              "http",  38),
    ("payments/refund-service",     "payments/payment-processor",  "grpc",   6),
    ("orders/order-service",        "orders/inventory-api",        "grpc", 110),
    ("orders/order-service",        "ext:postgres",                "tcp",   80),
    ("orders/order-service",        "ext:kafka",                   "tcp",   30),
    ("orders/order-service",        "platform/config-server",      "http",   2),
    ("orders/inventory-api",        "ext:postgres",                "tcp",   95),
    ("orders/notification-worker",  "ext:kafka",                   "tcp",   25),
    ("orders/delivery-tracker",     "orders/order-service",        "http",  25),
    ("web/search-api",              "data/ml-inference",           "grpc",  65),
    ("data/ml-inference",           "data/feature-store",          "grpc",  65),
    ("data/stream-processor",       "ext:kafka",                   "tcp",   60),
    ("data/pipeline-worker",        "ext:s3",                      "http",  12),
    ("data/batch-runner",           "ext:s3",                      "http",   4),
    ("monitoring/grafana",          "monitoring/prometheus",       "http",   3),
]

# Own processing time (p50, ms) before downstream calls; default 8 ms.
_OWN_MS = {
    "frontend": 15, "bff-api": 22, "cdn-proxy": 4, "search-api": 35, "api-gateway": 5,
    "auth-service": 6, "rate-limiter": 2, "config-server": 3, "checkout-api": 28,
    "payment-processor": 25, "fraud-detector": 15, "refund-service": 18, "order-service": 22,
    "inventory-api": 12, "delivery-tracker": 14, "ml-inference": 55, "feature-store": 9,
    "prometheus": 45, "grafana": 25,
}
_EXT_MS = {"stripe-api": 60.0, "s3": 45.0}      # third parties answer slower

# How a service's traffic splits across its deployment variants
_VARIANT_SHARE = {"": 0.6, "-v2": 0.3, "-canary": 0.1}

# Busier estates carry more traffic
_LOAD = (("prod", 3.0), ("staging", 0.4), ("qa", 0.2), ("dev", 0.1))


def _load_factor(cluster_name: str) -> float:
    return next((k for p, k in _LOAD if cluster_name.startswith(p) or p in cluster_name), 0.5)


def _variants(base_key: str, deps: Dict[str, Deployment]) -> List[Tuple[str, float]]:
    """Existing variants of a service with normalised traffic shares."""
    found = [(base_key + sfx, share) for sfx, share in _VARIANT_SHARE.items() if base_key + sfx in deps]
    total = sum(s for _, s in found)
    return [(k, s / total) for k, s in found] if total else []


def _cpu_penalty(dep: Deployment) -> float:
    """CPU throttling slows a deployment down: 1x below 70% CPU, ~7.6x at 125%."""
    if dep.avg_cpu is None:
        return 1.0
    return 1.0 + max(0.0, dep.avg_cpu - 70.0) / 100.0 * 12.0


def build_traffic(cluster: Cluster, settings: Settings, rng: random.Random) -> None:
    """Fill cluster.edges, cluster.externals and each deployment's traffic summary."""
    name = cluster.name
    deps = {f"{d.namespace}/{d.name}": d for d in cluster.deployments if d.status != "unknown"}
    load = _load_factor(name)

    # resolve logical calls to concrete endpoints that exist here
    calls = []
    used_ext = set()
    for src, dst, proto, rps in _CALLS:
        s_ends = [(src, 1.0)] if src.startswith("ext:") else _variants(src, deps)
        d_ends = [(dst, 1.0)] if dst.startswith("ext:") else _variants(dst, deps)
        if not s_ends or not d_ends:
            continue
        calls.append((s_ends, d_ends, proto, rps * load))
        used_ext.update(e for e in (src, dst) if e.startswith("ext:"))

    # per-deployment own error rate and latency, then add the synchronous
    # downstream path (memoised; the call graph has no cycles)
    own_err = {}
    for key, d in deps.items():
        hot = d.avg_cpu is not None and d.avg_cpu > settings.red
        own_err[key] = rng.uniform(1.5, 4.5) if hot else rng.uniform(0.0, 0.12)

    # downstream[caller] = [(callee, callee share, protocol, rps the caller sends to that service)]
    downstream: Dict[str, List[Tuple[str, float, str, float]]] = {}
    in_rps: Dict[str, float] = {}
    for s_ends, d_ends, proto, rps in calls:
        for s, s_share in s_ends:
            for d, d_share in d_ends:
                downstream.setdefault(s, []).append((d, d_share, proto, rps * s_share))
                if proto != "tcp":
                    in_rps[d] = in_rps.get(d, 0.0) + rps * s_share * d_share

    memo: Dict[str, Tuple[float, float]] = {}

    def node_latency(key: str) -> Tuple[float, float]:
        """(p50 ms, error %) as seen by a caller of this node."""
        if key in memo:
            return memo[key]
        if key.startswith("ext:"):
            base = _EXT_MS.get(key[4:])
            res = (base * rng.uniform(0.85, 1.25), rng.uniform(0.0, 0.2)) if base else (2.0, 0.0)
            memo[key] = res
            return res
        d = deps[key]
        p50 = _OWN_MS.get(d.name.replace("-canary", "").replace("-v2", ""), 8) * _cpu_penalty(d)
        err = own_err[key]
        # synchronous downstream calls add their latency, weighted by how many of
        # this node's requests make that call (a worker with no inbound: every run)
        mine = in_rps.get(key, 0.0)
        for tgt, share, proto, sent in downstream.get(key, []):
            per_req = min(1.0, sent / mine) if mine else 1.0
            if proto == "tcp":
                p50 += 0.8 * per_req * share    # a quick DB / queue round trip
                continue
            t50, terr = node_latency(tgt)
            p50 += t50 * share * per_req
            err += terr * share * per_req * 0.5  # half of downstream failures surface upstream
        memo[key] = (p50 * rng.uniform(0.9, 1.1), min(err, 25.0))
        return memo[key]

    def spread(p50: float) -> Tuple[float, float, float]:
        p95 = p50 * rng.uniform(2.0, 2.6)
        return round(p50, 1), round(p95, 1), round(p95 * rng.uniform(1.6, 2.1), 1)

    def tclass(p95, err):
        return classify_traffic(p95, err, settings.lat_amber_ms, settings.lat_red_ms,
                                settings.err_amber_pct, settings.err_red_pct)

    # concrete edges
    edges: List[Edge] = []
    for s_ends, d_ends, proto, rps in calls:
        for s, s_share in s_ends:
            for d, d_share in d_ends:
                e_rps = round(rps * s_share * d_share * rng.uniform(0.9, 1.1), 2)
                if e_rps < 0.05:
                    continue
                src_key = s if s.startswith("ext:") else f"{name}/{s}"
                dst_key = d if d.startswith("ext:") else f"{name}/{d}"
                if proto == "tcp":
                    edges.append(Edge(source=src_key, target=dst_key, protocol=proto,
                                      rps=round(e_rps * 0.05, 2),          # tcp: new connections/s
                                      kbps=round(e_rps * rng.uniform(4, 9), 1)))
                    continue
                t50, terr = node_latency(d)
                p50, p95, p99 = spread(t50 + 1.0)                        # + network hop
                err = round(terr * rng.uniform(0.8, 1.2), 2)
                edges.append(Edge(source=src_key, target=dst_key, protocol=proto, rps=e_rps,
                                  p50_ms=p50, p95_ms=p95, p99_ms=p99, error_pct=err,
                                  status=tclass(p95, err)))

    # per-deployment summaries from the edges
    for key, d in deps.items():
        full = f"{name}/{key}"
        inbound = [e for e in edges if e.target == full]
        outbound = [e for e in edges if e.source == full]
        req_in = [e for e in inbound if e.protocol != "tcp"]
        summary = TrafficSummary(in_rps=round(sum(e.rps for e in req_in), 1),
                                 out_rps=round(sum(e.rps for e in outbound if e.protocol != "tcp"), 1))
        if req_in:
            p50, _ = node_latency(key)
            summary.p50_ms, summary.p95_ms, summary.p99_ms = spread(p50)
            tot = sum(e.rps for e in req_in)
            summary.error_pct = round(sum(e.error_pct * e.rps for e in req_in) / tot, 2)
            summary.status = tclass(summary.p95_ms, summary.error_pct)
        d.traffic = summary

    cluster.edges = edges
    cluster.externals = [External(id=e, name=e[4:], kind=_EXTERNALS[e[4:]]) for e in sorted(used_ext)]
