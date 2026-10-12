"""monitor/config.py – Settings dataclass + CLI/env parsing."""
from __future__ import annotations
import argparse
import os
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class Settings:
    demo: bool = False
    kubeconfig: Optional[str] = None
    clusters: List[str] = field(default_factory=list)
    namespaces: List[str] = field(default_factory=list)
    cpu_basis: str = "requests"   # "requests" | "limits"
    refresh: int = 15
    amber: float = 60.0
    red: float = 90.0
    port: int = 8081
    web: bool = True

    # ------------------------------------------------------------------ #
    @classmethod
    def from_cli(cls, argv: Optional[List[str]] = None) -> "Settings":
        p = argparse.ArgumentParser(description="Cluster Monitor")
        p.add_argument("--demo",        action="store_true",
                       default=_bool_env("DEMO_MODE", False))
        p.add_argument("--kubeconfig",  default=os.environ.get("KUBECONFIG"))
        p.add_argument("--clusters",    default=os.environ.get("CLUSTERS", ""),
                       help="Comma-separated kubeconfig context names")
        p.add_argument("--namespaces",  default=os.environ.get("NAMESPACES", ""),
                       help="Comma-separated namespace allow-list (empty=all)")
        p.add_argument("--cpu-basis",   default=os.environ.get("CPU_BASIS", "requests"),
                       choices=["requests", "limits"])
        p.add_argument("--refresh",     type=int,
                       default=int(os.environ.get("REFRESH_SECONDS", "15")))
        p.add_argument("--amber",       type=float,
                       default=float(os.environ.get("AMBER_THRESHOLD", "60")))
        p.add_argument("--red",         type=float,
                       default=float(os.environ.get("RED_THRESHOLD", "90")))
        p.add_argument("--web",         action="store_true", default=True)
        p.add_argument("--port",        type=int,
                       default=int(os.environ.get("PORT", "8081")))

        args = p.parse_args(argv)
        return cls(
            demo=args.demo,
            kubeconfig=args.kubeconfig or None,
            clusters=[c.strip() for c in args.clusters.split(",") if c.strip()],
            namespaces=[n.strip() for n in args.namespaces.split(",") if n.strip()],
            cpu_basis=args.cpu_basis,
            refresh=args.refresh,
            amber=args.amber,
            red=args.red,
            port=args.port,
            web=args.web,
        )


def _bool_env(key: str, default: bool) -> bool:
    val = os.environ.get(key, "").lower()
    if val in ("1", "true", "yes"):
        return True
    if val in ("0", "false", "no"):
        return False
    return default
