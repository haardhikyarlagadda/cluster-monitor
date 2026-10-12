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
class Deployment:
    cluster: str
    namespace: str
    name: str
    desired: int
    ready: int
    avg_cpu: Optional[float]   # mean cpu_pct across pods with data
    status: str                # green | amber | red | unknown
    pods: List[Pod] = field(default_factory=list)

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

    def counts(self) -> Dict[str, int]:
        out: Dict[str, int] = {"green": 0, "amber": 0, "red": 0, "unknown": 0}
        for d in self.deployments:
            out[d.status] = out.get(d.status, 0) + 1
        return out


@dataclass
class Snapshot:
    clusters: List[Cluster] = field(default_factory=list)
    mode: str = "demo"   # "kubeconfig" | "in-cluster" | "demo"
