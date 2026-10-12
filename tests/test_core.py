"""tests/test_core.py – offline unit tests for model + k8s helpers."""
import pytest
from monitor.model import classify, Deployment, Pod, Cluster
from monitor.k8s import parse_cpu_m, parse_mem_mi, _pod_restarts, _pod_containers


# ─── parse_cpu_m ─────────────────────────────────────────────────────────────

def test_parse_cpu_m_millis():
    assert parse_cpu_m("250m") == 250.0

def test_parse_cpu_m_whole():
    assert parse_cpu_m("1") == 1000.0

def test_parse_cpu_m_nano():
    assert parse_cpu_m("12345678n") == pytest.approx(12.3, abs=0.2)

def test_parse_cpu_m_none():
    assert parse_cpu_m(None) is None

def test_parse_cpu_m_junk():
    assert parse_cpu_m("banana") is None

def test_parse_cpu_m_micro():
    assert parse_cpu_m("500u") == pytest.approx(0.5, abs=0.01)



# ─── parse_mem_mi ────────────────────────────────────────────────────────────

def test_parse_mem_mi_mebi():
    assert parse_mem_mi("512Mi") == 512.0

def test_parse_mem_mi_gibi():
    assert parse_mem_mi("2Gi") == 2048.0

def test_parse_mem_mi_kibi():
    assert parse_mem_mi("204800Ki") == 200.0

def test_parse_mem_mi_bytes():
    assert parse_mem_mi("1048576") == 1.0

def test_parse_mem_mi_decimal_mega():
    assert parse_mem_mi("100M") == pytest.approx(95.4, abs=0.1)

def test_parse_mem_mi_none_and_junk():
    assert parse_mem_mi(None) is None
    assert parse_mem_mi("lots") is None


# ─── restarts ────────────────────────────────────────────────────────────────

class _CS:
    def __init__(self, n): self.restart_count = n

class _Status:
    def __init__(self, counts): self.container_statuses = [_CS(n) for n in counts]

def test_pod_restarts_sums_containers():
    assert _pod_restarts(_Status([2, 3])) == 5

def test_pod_restarts_no_statuses():
    assert _pod_restarts(_Status([])) == 0
    assert _pod_restarts(None) == 0


# ─── demo pods carry memory + restarts ───────────────────────────────────────

def test_demo_pods_have_memory_and_restarts():
    from monitor.config import Settings
    from monitor.demo import DemoCollector
    snap = DemoCollector(Settings(demo=True)).snapshot()
    pods = [p for c in snap.clusters for d in c.deployments for p in d.pods]
    with_mem = [p for p in pods if p.mem_pct is not None]
    assert with_mem, "expected running pods with memory metrics"
    for p in with_mem:
        assert p.mem_usage_mi is not None and p.mem_basis_mi
        assert 0 <= p.mem_pct <= 100
    assert all(isinstance(p.restarts, int) and p.restarts >= 0 for p in pods)
    red_pods = [p for c in snap.clusters for d in c.deployments if d.status == "red" for p in d.pods]
    assert red_pods, "demo should include at least one red deployment"


# ─── per-container breakdown ─────────────────────────────────────────────────

from types import SimpleNamespace as _NS

def _ctr(name, cpu, mem):
    return _NS(name=name, resources=_NS(requests={"cpu": cpu, "memory": mem}, limits=None))

def test_pod_containers_maps_usage_basis_and_status():
    spec = _NS(containers=[_ctr("app", "200m", "256Mi"), _ctr("fluent-bit", "50m", "64Mi")])
    status = _NS(container_statuses=[
        _NS(name="app", restart_count=4, ready=False,
            state=_NS(running=None, waiting=_NS(reason="CrashLoopBackOff"), terminated=None)),
        _NS(name="fluent-bit", restart_count=0, ready=True,
            state=_NS(running=_NS(), waiting=None, terminated=None)),
    ])
    per = {"app": (150.0, 128.0), "fluent-bit": (5.0, 16.0)}
    app, side = _pod_containers(spec, status, per, "requests")
    assert (app.name, app.usage_m, app.basis_m, app.cpu_pct) == ("app", 150.0, 200.0, 75.0)
    assert (app.mem_pct, app.restarts, app.ready) == (50.0, 4, False)
    assert app.state == "Waiting: CrashLoopBackOff"
    assert (side.cpu_pct, side.mem_pct, side.state) == (10.0, 25.0, "Running")

def test_pod_containers_without_metrics_or_status():
    spec = _NS(containers=[_ctr("app", "100m", "128Mi")])
    (c,) = _pod_containers(spec, None, {}, "requests")
    assert c.usage_m is None and c.cpu_pct is None and c.basis_m == 100.0
    assert c.restarts == 0 and c.state is None

def test_demo_containers_add_up_to_pod():
    from monitor.config import Settings
    from monitor.demo import DemoCollector
    snap = DemoCollector(Settings(demo=True)).snapshot()
    pods = [p for c in snap.clusters for d in c.deployments for p in d.pods]
    assert all(p.containers for p in pods)
    assert any(len(p.containers) == 2 for p in pods), "expected some pods with a sidecar"
    for p in pods:
        assert sum(c.restarts for c in p.containers) == p.restarts
        if p.usage_m is not None:
            assert abs(sum(c.usage_m for c in p.containers) - p.usage_m) < 0.25
        if p.mem_usage_mi is not None:
            assert abs(sum(c.mem_usage_mi for c in p.containers) - p.mem_usage_mi) < 0.25


# ─── classify ────────────────────────────────────────────────────────────────

def test_classify_green_boundary():
    assert classify(60.0, 60, 90) == "green"

def test_classify_amber_boundary():
    assert classify(60.1, 60, 90) == "amber"

def test_classify_red_boundary():
    assert classify(90.1, 60, 90) == "red"

def test_classify_none():
    assert classify(None, 60, 90) == "unknown"

def test_classify_zero():
    assert classify(0.0, 60, 90) == "green"


# ─── replica_state ───────────────────────────────────────────────────────────

def _dep(**kw):
    defaults = dict(cluster="c", namespace="ns", name="d",
                    desired=3, ready=3, avg_cpu=10.0, status="green")
    defaults.update(kw)
    return Deployment(**defaults)

def test_replica_state_ok():
    assert _dep(desired=3, ready=3).replica_state == "ok"

def test_replica_state_desired_zero():
    assert _dep(desired=0, ready=0).replica_state == "ok"

def test_replica_state_down():
    assert _dep(desired=3, ready=0).replica_state == "down"

def test_replica_state_degraded():
    assert _dep(desired=3, ready=2).replica_state == "degraded"


# ─── Cluster.counts ──────────────────────────────────────────────────────────

def test_cluster_counts():
    deps = [
        _dep(status="green"),
        _dep(status="green"),
        _dep(status="amber"),
        _dep(status="red"),
        _dep(status="unknown"),
    ]
    c = Cluster(name="x", index=0, deployments=deps)
    counts = c.counts()
    assert counts == {"green": 2, "amber": 1, "red": 1, "unknown": 1}
