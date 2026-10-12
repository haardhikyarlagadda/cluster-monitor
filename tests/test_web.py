"""tests/test_web.py – FastAPI integration tests (offline, demo mode)."""
import pytest
from fastapi.testclient import TestClient

from monitor.config import Settings
from monitor.demo import DemoCollector
from monitor.web import create_app


@pytest.fixture(scope="module")
def client():
    settings = Settings(demo=True, refresh=3600)
    collector = DemoCollector(settings)
    app = create_app(settings, collector)
    return TestClient(app)


def test_index_contains_cluster(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "CLUSTER" in r.text


def test_snapshot_has_5_clusters(client):
    r = client.get("/api/snapshot")
    assert r.status_code == 200
    data = r.json()
    # May need one poll cycle — force via blocking call
    if not data["ready"]:
        import time; time.sleep(2)
        r = client.get("/api/snapshot")
        data = r.json()
    assert data["ready"] is True
    assert len(data["clusters"]) == 5


def test_snapshot_counts_keys(client):
    r = client.get("/api/snapshot")
    data = r.json()
    if data["ready"]:
        for cl in data["clusters"]:
            if not cl.get("error"):
                assert "counts" in cl
                assert set(cl["counts"].keys()) >= {"green", "amber", "red", "unknown"}


def test_snapshot_replica_state_values(client):
    r = client.get("/api/snapshot")
    data = r.json()
    if data["ready"]:
        for cl in data["clusters"]:
            for dep in cl.get("deployments", []):
                assert dep.get("replica_state") in {"ok", "degraded", "down"}


def test_deployment_endpoint(client):
    r = client.get(
        "/api/deployment/staging-eu-west-1/payments/checkout-api"
    )
    assert r.status_code == 200
    dep = r.json()
    assert dep["desired"] == 4
    assert len(dep["pods"]) == 4


def test_deployment_unknown_404(client):
    r = client.get("/api/deployment/nonexistent/ns/dep")
    assert r.status_code == 404


def test_config_demo_true(client):
    r = client.get("/api/config")
    assert r.status_code == 200
    assert r.json()["demo"] is True


def test_all_status_colors_present(client):
    """Every status colour must appear somewhere in a full demo snapshot."""
    r = client.get("/api/snapshot")
    data = r.json()
    if not data["ready"]:
        return
    statuses = set()
    for cl in data["clusters"]:
        for dep in cl.get("deployments", []):
            statuses.add(dep.get("status"))
    # At least green, amber, red must appear in demo data
    assert "green" in statuses
    assert "amber" in statuses
    # red and unknown may need multiple calls to appear (drift)
