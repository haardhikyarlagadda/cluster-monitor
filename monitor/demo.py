"""monitor/demo.py – Deterministic simulated 5-cluster data."""
from __future__ import annotations
import random
from typing import List, Optional

from .config import Settings
from .demo_traffic import build_traffic
from .model import Cluster, Container, Deployment, Pod, Snapshot, classify

# Base deployment table: (namespace, name, replicas, requests_m, start_cpu, behaviour)
# Tuned to look like a healthy real estate: almost everything idles well under
# its CPU request, with only a handful of warm/hot outliers per cluster.
_BASE: List[tuple] = [
    # payments
    ("payments", "checkout-api",        4, 200, 18.0, "drift"),
    ("payments", "payment-processor",   4, 300, 95.0, "hot"),
    ("payments", "fraud-detector",      3, 250,  9.0, "cold"),
    # orders
    ("orders",   "order-service",       4, 200, 12.0, "drift"),
    ("orders",   "inventory-api",       3, 150,  6.0, "idle"),
    ("orders",   "notification-worker", 2, 100,  3.0, "idle"),
    # web
    ("web",      "frontend",            6, 100, 14.0, "cold"),
    ("web",      "bff-api",             4, 200, 20.0, "drift"),
    ("web",      "cdn-proxy",           2,  50,  2.0, "idle"),
    # platform
    ("platform", "config-server",       2, 100,  4.0, "idle"),
    ("platform", "auth-service",        3, 200, 11.0, "cold"),
    ("platform", "api-gateway",         4, 300, 72.0, "warm"),
    # monitoring
    ("monitoring","prometheus",         1, 500, 25.0, "cold"),
    ("monitoring","grafana",            1, 200,  5.0, "idle"),
    # data
    ("data",     "pipeline-worker",     3, 400, 15.0, "cold"),
    ("data",     "stream-processor",    3, 600, 95.0, "hot"),
    ("data",     "nometrics-job",       2,   0,  0.0, "nometrics"),
    ("data",     "batch-runner",        2, 200,  3.0, "idle"),
]

# Only the primary deployment of a hot/warm service runs hot; its -v2 and
# -canary variants take a fraction of the traffic and stay comfortably green.
_VARIANT_BEHAVIOUR = {"hot": "cold", "warm": "cold"}

_CLUSTER_NAMES_DEFAULT = [
    "dev-eu-west-1",
    "qa-eu-west-1",
    "staging-eu-west-1",
    "prod-eu-west-1",
    "prod-us-east-1",
]

_HEX_CHARS = "0123456789abcdef"


def _pod_name(dep_name: str, rng: random.Random) -> str:
    hex7 = "".join(rng.choices(_HEX_CHARS, k=7))
    digits = "".join(rng.choices("0123456789", k=5))
    return f"{dep_name}-{hex7}-{digits}"


def _node_name(rng: random.Random) -> str:
    x = rng.randint(0, 255)
    y = rng.randint(1, 254)
    return f"ip-10-0-{x}-{y}"


_SIDECAR = "fluent-bit"


def _has_sidecar(dep_name: str) -> bool:
    # stable per deployment: roughly half run a log-shipping sidecar
    return random.Random(f"{dep_name}#sidecar").random() < 0.5


def _split(v: Optional[float], share: float) -> Optional[float]:
    return round(v * share, 1) if v is not None else None


def _make_containers(dep_name: str, phase: str, usage_m, basis_m, mem_usage, mem_basis,
                     restarts: int, rng: random.Random) -> List[Container]:
    """Split a pod's totals across its containers so the per-container rows add up."""
    running = phase == "Running"
    if phase == "CrashLoopBackOff":
        app_state = "Waiting: CrashLoopBackOff"
    elif running:
        app_state = "Running"
    else:
        app_state = "Waiting: ContainerCreating"

    if not _has_sidecar(dep_name):
        return [Container(
            name=dep_name, usage_m=usage_m, basis_m=basis_m,
            cpu_pct=_pct(usage_m, basis_m), mem_usage_mi=mem_usage,
            mem_basis_mi=mem_basis, mem_pct=_pct(mem_usage, mem_basis),
            restarts=restarts, ready=running, state=app_state)]

    # the app takes ~85% of the requests; the sidecar is light and steady
    side_cpu_share = rng.uniform(0.04, 0.12)   # of pod CPU usage
    side_mem_share = rng.uniform(0.06, 0.15)   # of pod memory usage
    app_b, side_b = _split(basis_m, 0.85), _split(basis_m, 0.15)
    app_mb, side_mb = _split(mem_basis, 0.85), _split(mem_basis, 0.15)
    app_u, side_u = _split(usage_m, 1 - side_cpu_share), _split(usage_m, side_cpu_share)
    app_mu, side_mu = _split(mem_usage, 1 - side_mem_share), _split(mem_usage, side_mem_share)
    side_restarts = 1 if restarts and rng.random() < 0.15 else 0
    return [
        Container(name=dep_name, usage_m=app_u, basis_m=app_b, cpu_pct=_pct(app_u, app_b),
                  mem_usage_mi=app_mu, mem_basis_mi=app_mb, mem_pct=_pct(app_mu, app_mb),
                  restarts=restarts - side_restarts, ready=running, state=app_state),
        Container(name=_SIDECAR, usage_m=side_u, basis_m=side_b, cpu_pct=_pct(side_u, side_b),
                  mem_usage_mi=side_mu, mem_basis_mi=side_mb, mem_pct=_pct(side_mu, side_mb),
                  restarts=side_restarts, ready=phase != "Pending",
                  state="Running" if phase != "Pending" else "Waiting: ContainerCreating"),
    ]


def _pct(used: Optional[float], basis: Optional[float]) -> Optional[float]:
    return round(used / basis * 100, 1) if used is not None and basis else None


def _evolve_cpu(cpu: float, behaviour: str, rng: random.Random) -> float:
    if behaviour == "hot":
        return rng.uniform(90.5, 130.0)
    if behaviour == "warm":
        return rng.uniform(61.0, 89.0)
    if behaviour == "cold":
        return rng.uniform(5.0, 35.0)
    if behaviour == "idle":
        return rng.uniform(0.3, 8.0)
    if behaviour == "nometrics":
        return 0.0
    # drift: slow random walk that stays in the healthy band
    delta = rng.uniform(-4, 4)
    if rng.random() < 0.05:
        delta += 10
    return max(1.0, min(50.0, cpu + delta))


class DemoCollector:
    """Deterministic demo collector – evolves state on each call."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._rng = random.Random(42)
        self._cpu_state: dict = {}   # (cluster_idx, ns, name, variant) -> current_cpu
        self._call_count = 0
        self._cluster_names = settings.clusters or _CLUSTER_NAMES_DEFAULT

    def snapshot(self) -> Snapshot:
        self._call_count += 1
        clusters = []
        for idx, cname in enumerate(self._cluster_names):
            # 3% chance cluster 1 is unreachable
            if idx == 1 and self._rng.random() < 0.03:
                clusters.append(Cluster(
                    name=cname, index=idx,
                    error="dial tcp: i/o timeout (simulated)",
                    metrics_available=False,
                ))
                continue
            clusters.append(self._build_cluster(idx, cname))
        return Snapshot(clusters=clusters, mode="demo")

    def _build_cluster(self, idx: int, cname: str) -> Cluster:
        s = self.settings
        rng = random.Random(42 + idx * 1000 + self._call_count)

        # Namespace filter
        ns_allow = set(s.namespaces) if s.namespaces else None

        deployments: List[Deployment] = []
        rows = list(_BASE)

        # prod clusters: add 6 extras, double replicas
        is_prod = "prod" in cname
        is_dev = cname.startswith("dev")
        is_qa = cname.startswith("qa")

        if is_prod:
            rows += [
                ("payments", "refund-service",    4, 200, 70.0, "drift"),
                ("orders",   "delivery-tracker",  4, 150, 45.0, "cold"),
                ("web",      "search-api",         4, 200, 66.0, "warm"),
                ("platform", "rate-limiter",       3, 100, 33.0, "cold"),
                ("data",     "ml-inference",       4, 800, 92.0, "hot"),
                ("data",     "feature-store",      2, 300, 55.0, "drift"),
            ]

        for (ns, name, replicas, requests_m, start_cpu, behaviour) in rows:
            if ns_allow and ns not in ns_allow:
                continue
            if is_dev and ns in ("data", "monitoring"):
                continue
            if is_qa and ns == "data":
                continue
            # one "no metrics" deployment in staging only, as a rare grey sphere
            if behaviour == "nometrics" and not cname.startswith("staging"):
                continue

            variants = [(name, replicas, requests_m, start_cpu, 1.0)]
            variants += [(f"{name}-v2",     replicas,     requests_m, start_cpu * 0.8,  1.0)]
            variants += [(f"{name}-canary", max(1, replicas // 2), requests_m, start_cpu * 1.15, 0.5)]
            if behaviour == "nometrics":
                variants = variants[:1]

            for vname, vreplicas, vreqs_m, vcpu_start, _ in variants:
                vbehaviour = behaviour if vname == name else _VARIANT_BEHAVIOUR.get(behaviour, behaviour)
                if vbehaviour != behaviour:
                    vcpu_start = 15.0
                if is_dev:
                    vreplicas = max(1, vreplicas // 2)
                if is_prod:
                    vreplicas = vreplicas * 2

                state_key = (idx, ns, vname)
                current_cpu = self._cpu_state.get(state_key, vcpu_start)
                current_cpu = _evolve_cpu(current_cpu, vbehaviour, rng)
                self._cpu_state[state_key] = current_cpu

                if vbehaviour == "nometrics":
                    avg_cpu = None
                    status = "unknown"
                    ready = vreplicas
                    pods = _make_pods(f"{cname}/{ns}/{vname}", vreplicas, vreplicas, vreqs_m, None, rng)
                elif vbehaviour == "degraded":
                    avg_cpu = round(current_cpu, 1)
                    status = classify(avg_cpu, s.amber, s.red)
                    ready = max(0, vreplicas - 1)
                    pods = _make_pods(f"{cname}/{ns}/{vname}", vreplicas, ready, vreqs_m, current_cpu, rng,
                                      has_pending=True)
                elif vbehaviour == "down":
                    avg_cpu = None
                    status = "unknown"
                    ready = 0
                    pods = _make_pods(f"{cname}/{ns}/{vname}", vreplicas, 0, vreqs_m, None, rng,
                                      phase="CrashLoopBackOff")
                else:
                    avg_cpu = round(current_cpu, 1)
                    status = classify(avg_cpu, s.amber, s.red)
                    ready = vreplicas
                    pods = _make_pods(f"{cname}/{ns}/{vname}", vreplicas, vreplicas, vreqs_m, current_cpu, rng,
                                      hot=(status == "red"))

                deployments.append(Deployment(
                    cluster=cname,
                    namespace=ns,
                    name=vname,
                    desired=vreplicas,
                    ready=ready,
                    avg_cpu=avg_cpu,
                    status=status,
                    pods=pods,
                ))

        cluster = Cluster(name=cname, index=idx, deployments=deployments,
                          metrics_available=True)
        # own rng, so the deployment/pod sequence above is unchanged by traffic
        build_traffic(cluster, s, random.Random(f"traffic#{idx}#{self._call_count}"))
        return cluster


def _make_pods(ident: str, desired: int, ready: int, requests_m: float,
               avg_cpu: Optional[float], rng: random.Random,
               has_pending: bool = False, phase: Optional[str] = None,
               hot: bool = False) -> List[Pod]:
    dep_name = ident.rsplit("/", 1)[-1]
    pods = []
    # memory request scales with the CPU request (min 128Mi)
    mem_basis: Optional[float] = float(max(128, int(requests_m * 2))) if requests_m else None
    for i in range(desired):
        if phase:
            p_phase = phase
        elif has_pending and i == desired - 1:
            p_phase = "Pending"
        elif i < ready:
            p_phase = "Running"
        else:
            p_phase = "Pending"

        usage_m: Optional[float] = None
        basis_m: Optional[float] = requests_m if requests_m else None
        cpu_pct: Optional[float] = None

        if avg_cpu is not None and requests_m > 0 and p_phase == "Running":
            spread = rng.uniform(-5, 5)
            usage_m = round(max(0, (avg_cpu + spread) / 100 * requests_m), 1)
            cpu_pct = round(usage_m / requests_m * 100, 1) if requests_m else None

        mem_usage: Optional[float] = None
        mem_pct: Optional[float] = None
        if mem_basis and p_phase == "Running" and avg_cpu is not None:
            mem_pct = round(rng.uniform(72.0, 96.0) if hot else rng.uniform(18.0, 62.0), 1)
            mem_usage = round(mem_basis * mem_pct / 100, 1)

        # hot pods get OOM-killed / probe-restarted now and then; healthy ones rarely
        if hot:
            restarts = rng.choice([0, 0, 1, 2, 3, 5, 8])
        else:
            restarts = 1 if rng.random() < 0.03 else 0

        pods.append(Pod(
            # names and nodes stay stable across refreshes, like real pods
            name=_pod_name(dep_name, random.Random(f"{ident}#{i}")),
            node=_node_name(random.Random(f"{ident}#{i}#node")),
            phase=p_phase,
            usage_m=usage_m,
            basis_m=basis_m,
            cpu_pct=cpu_pct,
            mem_usage_mi=mem_usage,
            mem_basis_mi=mem_basis,
            mem_pct=mem_pct,
            restarts=restarts,
            containers=_make_containers(dep_name, p_phase, usage_m, basis_m, mem_usage,
                                        mem_basis, restarts,
                                        # own rng so the shared sequence (and the rest of the demo) is unchanged
                                        random.Random(f"{ident}#{i}#containers")),
        ))
    return pods
