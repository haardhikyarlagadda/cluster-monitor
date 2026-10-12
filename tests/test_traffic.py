"""tests/test_traffic.py – simulated Kuma mesh traffic (demo mode)."""
import pytest
from fastapi.testclient import TestClient

from monitor.config import Settings
from monitor.demo import DemoCollector
from monitor.model import classify_traffic
from monitor.web import create_app


@pytest.fixture(scope="module")
def snap():
    return DemoCollector(Settings(demo=True)).snapshot()


def _healthy(snap):
    return [c for c in snap.clusters if not c.error]


def test_classify_traffic_worst_of_latency_and_errors():
    t = dict(lat_amber=250, lat_red=600, err_amber=0.5, err_red=2)
    assert classify_traffic(100, 0.1, **t) == "green"
    assert classify_traffic(300, 0.1, **t) == "amber"
    assert classify_traffic(100, 3.0, **t) == "red"
    assert classify_traffic(700, 0.6, **t) == "red"
    assert classify_traffic(None, None, **t) == "unknown"


def test_every_edge_end_exists(snap):
    for c in _healthy(snap):
        nodes = {f"{d.cluster}/{d.namespace}/{d.name}" for d in c.deployments}
        nodes |= {x.id for x in c.externals}
        assert c.edges, c.name
        for e in c.edges:
            assert e.source in nodes and e.target in nodes, (e.source, e.target)
            assert e.rps > 0


def test_request_edges_have_ordered_latency_and_tcp_has_none(snap):
    for c in _healthy(snap):
        for e in c.edges:
            if e.protocol == "tcp":
                assert e.p95_ms is None and e.kbps and e.status == "unknown"
            else:
                assert 0 < e.p50_ms <= e.p95_ms <= e.p99_ms
                assert e.error_pct is not None and e.status in ("green", "amber", "red")


def test_inbound_rps_matches_edges(snap):
    for c in _healthy(snap):
        for d in c.deployments:
            if not d.traffic:
                continue
            key = f"{d.cluster}/{d.namespace}/{d.name}"
            total = sum(e.rps for e in c.edges if e.target == key and e.protocol != "tcp")
            assert d.traffic.in_rps == pytest.approx(total, abs=0.15)


def test_cpu_starved_deployments_fail_requests(snap):
    s = Settings(demo=True)
    hot = [d for c in _healthy(snap) for d in c.deployments
           if d.avg_cpu and d.avg_cpu > s.red and d.traffic and d.traffic.p95_ms is not None]
    assert hot, "demo should have at least one red deployment receiving traffic"
    assert all(d.traffic.error_pct >= 1.0 for d in hot)


def test_externals_include_ingress_and_are_unique(snap):
    for c in _healthy(snap):
        ids = [x.id for x in c.externals]
        assert "ext:ingress" in ids
        assert len(ids) == len(set(ids))


def test_api_exposes_traffic_and_thresholds():
    s = Settings(demo=True, refresh=3600)
    client = TestClient(create_app(s, DemoCollector(s)))
    cfg = client.get("/api/config").json()
    assert cfg["lat_amber_ms"] == 250 and cfg["lat_red_ms"] == 600
    import time
    for _ in range(20):
        data = client.get("/api/snapshot").json()
        if data["ready"]:
            break
        time.sleep(0.2)
    healthy = [c for c in data["clusters"] if not c.get("error")]
    assert healthy and all("edges" in c and "externals" in c for c in healthy)
    dep = next(d for c in healthy for d in c["deployments"] if d.get("traffic"))
    assert {"in_rps", "p95_ms", "error_pct", "status"} <= dep["traffic"].keys()
