"""monitor/web.py – FastAPI app + background refresh thread."""
from __future__ import annotations
import logging
import threading
import time
from dataclasses import asdict
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import pathlib

from .config import Settings
from .model import Snapshot

log = logging.getLogger(__name__)

STATIC_DIR = pathlib.Path(__file__).parent / "static"


# ------------------------------------------------------------------ #
# Snapshot store (background refresh)
# ------------------------------------------------------------------ #

class SnapshotStore:
    def __init__(self, collector, refresh: int):
        self._collector = collector
        self._refresh = refresh
        self._snapshot: Optional[Snapshot] = None
        self._error: Optional[str] = None
        self._updated: Optional[float] = None
        self._lock = threading.Lock()
        self._event = threading.Event()
        t = threading.Thread(target=self._loop, daemon=True)
        t.start()

    def force(self):
        self._event.set()

    def _loop(self):
        while True:
            self._event.clear()
            try:
                snap = self._collector.snapshot()
                with self._lock:
                    self._snapshot = snap
                    self._error = None
                    self._updated = time.time()
            except Exception as exc:
                log.error("snapshot error: %s", exc)
                with self._lock:
                    self._error = str(exc)
                    self._updated = time.time()
            self._event.wait(timeout=self._refresh)

    def payload(self) -> Dict[str, Any]:
        with self._lock:
            if self._snapshot is None:
                return {
                    "ready": False,
                    "error": self._error,
                    "clusters": [],
                    "updated": self._updated,
                }
            snap = self._snapshot
            data = asdict(snap)

            # Enrich clusters with counts + per-deployment replica_state
            for ci, cluster in enumerate(snap.clusters):
                data["clusters"][ci]["counts"] = cluster.counts()
                data["clusters"][ci]["error"] = cluster.error
                for di, dep in enumerate(cluster.deployments):
                    data["clusters"][ci]["deployments"][di]["replica_state"] = dep.replica_state

            return {
                "ready": True,
                "error": self._error,
                "updated": self._updated,
                "mode": snap.mode,
                "clusters": data["clusters"],
            }


# ------------------------------------------------------------------ #
# App factory
# ------------------------------------------------------------------ #

def create_app(settings: Settings, collector) -> FastAPI:
    app = FastAPI(title="Cluster Monitor")
    store = SnapshotStore(collector, settings.refresh)

    @app.get("/api/snapshot")
    def get_snapshot():
        return store.payload()

    @app.get("/api/config")
    def get_config():
        return {
            "demo": settings.demo,
            "amber": settings.amber,
            "red": settings.red,
            "refresh": settings.refresh,
            "clusters": settings.clusters,
        }

    @app.post("/api/refresh")
    def force_refresh():
        store.force()
        return {"ok": True}

    @app.get("/api/deployment/{cluster}/{namespace}/{name}")
    def get_deployment(cluster: str, namespace: str, name: str):
        payload = store.payload()
        for c in payload.get("clusters", []):
            if c["name"] == cluster:
                for d in c.get("deployments", []):
                    if d["namespace"] == namespace and d["name"] == name:
                        return d
        raise HTTPException(status_code=404, detail="Deployment not found")

    # Serve static files
    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.get("/")
    def index():
        idx = STATIC_DIR / "index.html"
        if idx.exists():
            return FileResponse(str(idx))
        return {"message": "Cluster Monitor API running. Static files not found."}

    return app
