"""monitor/model.py – Pod / Deployment / Cluster / Snapshot dataclasses."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Dict, List, Optional


def classify(avg: Optional[float], amber: float, red: float) -> str:
    if avg is None:
        return "unknown"
    if avg > red:
        return "red"
    if avg > amber:
        return "amber"
    return "green"


def classify_traffic(p95_ms: Optional[float], error_pct: Optional[float],
                     lat_amber: float, lat_red: float, err_amber: float, err_red: float) -> str:
    """Worse of latency and error status; unknown when neither is measured (TCP)."""
    if p95_ms is None and error_pct is None:
        return "unknown"
    rank = {"green": 0, "amber": 1, "red": 2}
    lat = classify(p95_ms, lat_amber, lat_red) if p95_ms is not None else "green"
    err = classify(error_pct, err_amber, err_red) if error_pct is not None else "green"
    return max(lat, err, key=rank.get)


@dataclass
class Container:
    name: str
    usage_m: Optional[float] = None        # millicores actual usage
    basis_m: Optional[float] = None        # millicores request/limit
    cpu_pct: Optional[float] = None
    mem_usage_mi: Optional[float] = None   # MiB working-set usage
    mem_basis_mi: Optional[float] = None   # MiB request/limit
    mem_pct: Optional[float] = None
    restarts: int = 0
    ready: Optional[bool] = None
    state: Optional[str] = None            # Running | Waiting: <reason> | Terminated: <reason>


@dataclass
class Pod:
    name: str
    node: Optional[str]
    phase: Optional[str]
    usage_m: Optional[float]   # millicores actual usage
    basis_m: Optional[float]   # millicores request/limit
    cpu_pct: Optional[float]   # usage/basis * 100 (1 dp)
    mem_usage_mi: Optional[float] = None   # MiB actual working-set usage
    mem_basis_mi: Optional[float] = None   # MiB request/limit
    mem_pct: Optional[float] = None        # usage/basis * 100 (1 dp)
    restarts: int = 0                      # sum of container restart counts
    containers: List[Container] = field(default_factory=list)


@dataclass
class TrafficSummary:
    """Mesh traffic for one deployment (Kuma: envoy_http_downstream_* on self_inbound_dp_*)."""
    in_rps: float = 0.0
    out_rps: float = 0.0
    p50_ms: Optional[float] = None     # inbound latency; None for TCP-only workloads
    p95_ms: Optional[float] = None
    p99_ms: Optional[float] = None
    error_pct: Optional[float] = None  # share of inbound requests answered 5xx
    status: str = "unknown"            # green | amber | red | unknown (from p95 + errors)


@dataclass
class Edge:
    """Traffic from one node to another inside a cluster's mesh.

    Kuma: envoy_cluster_upstream_rq_* labelled kuma_workload (caller) and
    envoy_cluster_name (destination service, mapped back to its deployments).
    Ends are deployment keys ("cluster/ns/name") or external ids ("ext:<name>").
    """
    source: str
    target: str
    protocol: str                      # http | grpc | tcp
    rps: float = 0.0                   # requests/s (http, grpc) or connections/s (tcp)
    kbps: Optional[float] = None       # throughput, tcp only
    p50_ms: Optional[float] = None     # None for tcp: the mesh sees no request boundaries
    p95_ms: Optional[float] = None
    p99_ms: Optional[float] = None
    error_pct: Optional[float] = None
    status: str = "unknown"


@dataclass
class External:
    """Something outside the mesh that traffic enters from or leaves to."""
    id: str                            # "ext:<name>", used as an Edge end
    name: str
    kind: str                          # ingress | database | queue | storage | api


@dataclass
class Deployment:
    cluster: str
    namespace: str
    name: str
    desired: int
    ready: int
    avg_cpu: Optional[float]   # mean cpu_pct across pods with data
    status: str                # green | amber | red | unknown
    pods: List[Pod] = field(default_factory=list)
    traffic: Optional[TrafficSummary] = None

    @property
    def key(self) -> str:
        return f"{self.cluster}/{self.namespace}/{self.name}"

    @property
    def replica_state(self) -> str:
        if self.desired == 0:
            return "ok"
        if self.ready == 0:
            return "down"
        if self.ready < self.desired:
            return "degraded"
        return "ok"


@dataclass
class Cluster:
    name: str
    index: int
    deployments: List[Deployment] = field(default_factory=list)
    metrics_available: bool = True
    error: Optional[str] = None
    edges: List[Edge] = field(default_factory=list)
    externals: List[External] = field(default_factory=list)

    def counts(self) -> Dict[str, int]:
        out: Dict[str, int] = {"green": 0, "amber": 0, "red": 0, "unknown": 0}
        for d in self.deployments:
            out[d.status] = out.get(d.status, 0) + 1
        return out


@dataclass
class Snapshot:
    clusters: List[Cluster] = field(default_factory=list)
    mode: str = "demo"   # "kubeconfig" | "in-cluster" | "demo"
