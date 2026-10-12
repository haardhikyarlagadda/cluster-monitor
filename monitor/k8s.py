"""monitor/k8s.py – Multi-cluster Kubernetes collector."""
from __future__ import annotations
import logging
import os
import shutil
import subprocess
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from statistics import mean
from types import SimpleNamespace
from typing import Dict, List, Optional, Tuple

import yaml

from .config import Settings
from .model import Cluster, Container, Deployment, Pod, Snapshot, classify

log = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
# CPU quantity parser
# ------------------------------------------------------------------ #

def parse_cpu_m(q: Optional[str]) -> Optional[float]:
    """K8s quantity → millicores.  Returns None on junk input."""
    if not q:
        return None
    q = str(q).strip()
    try:
        if q.endswith("m"):
            return float(q[:-1])
        if q.endswith("n"):
            return round(float(q[:-1]) / 1_000_000, 1)
        if q.endswith("u"):
            return round(float(q[:-1]) / 1_000, 1)
        if q.endswith("k"):
            return float(q[:-1]) * 1_000_000
        return float(q) * 1000
    except (ValueError, TypeError):
        return None


_MEM_UNITS = {
    "Ki": 1 / 1024, "Mi": 1.0, "Gi": 1024.0, "Ti": 1024.0 ** 2,
    "k": 1000 / 1024 ** 2, "M": 1000 ** 2 / 1024 ** 2, "G": 1000 ** 3 / 1024 ** 2,
    "T": 1000 ** 4 / 1024 ** 2,
}


def parse_mem_mi(q: Optional[str]) -> Optional[float]:
    """K8s memory quantity → MiB.  Returns None on junk input."""
    if not q:
        return None
    q = str(q).strip()
    try:
        for suffix in ("Ki", "Mi", "Gi", "Ti", "k", "M", "G", "T"):
            if q.endswith(suffix):
                return round(float(q[: -len(suffix)]) * _MEM_UNITS[suffix], 1)
        return round(float(q) / 1024 ** 2, 1)   # plain bytes
    except (ValueError, TypeError):
        return None


# ------------------------------------------------------------------ #
# Proxy helpers
# ------------------------------------------------------------------ #

def _apply_proxy_env(configuration, api_host: str) -> None:
    """Replicate kubectl proxy behaviour: honour NO_PROXY, set config.proxy."""
    proxies = urllib.request.getproxies()
    https_proxy = proxies.get("https") or proxies.get("http")
    if not https_proxy:
        log.debug("[%s] direct (no proxy env)", api_host)
        return
    bypass = urllib.request.proxy_bypass(api_host)
    if bypass:
        log.debug("[%s] direct (NO_PROXY match)", api_host)
        return
    configuration.proxy = https_proxy
    ca = os.environ.get("REQUESTS_CA_BUNDLE")
    if ca:
        configuration.ssl_ca_cert = ca
    log.info("[%s] via proxy %s", api_host, https_proxy)


# ------------------------------------------------------------------ #
# Exec-plugin pre-flight check
# ------------------------------------------------------------------ #

def _exec_plugin_check(kubeconfig_path: str, context: str) -> None:
    """Run the exec plugin ourselves so we surface real aws stderr."""
    try:
        with open(kubeconfig_path, encoding="utf-8") as fh:
            kc = yaml.safe_load(fh)
    except Exception:
        return  # can't parse – let the client try anyway

    users = {u["name"]: u.get("user", {}) for u in (kc.get("users") or [])}
    # find which user the context references
    ctx_map = {c["name"]: c.get("context", {}) for c in (kc.get("contexts") or [])}
    user_name = ctx_map.get(context, {}).get("user")
    exec_block = users.get(user_name or "", {}).get("exec")
    if not exec_block:
        return

    cmd = exec_block.get("command", "")
    if not shutil.which(cmd):
        raise RuntimeError(
            f"exec plugin '{cmd}' not found on PATH "
            f"(context={context}, AWS_PROFILE={os.environ.get('AWS_PROFILE')}, "
            f"HTTPS_PROXY={os.environ.get('HTTPS_PROXY')})"
        )

    env = os.environ.copy()
    for kv in exec_block.get("env") or []:
        env[kv["name"]] = kv["value"]

    argv = [cmd] + exec_block.get("args", [])
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=60, env=env)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"exec plugin timed out (argv={argv})")

    if result.returncode != 0:
        stderr = "\n".join(
            l for l in result.stderr.splitlines()
            if "InsecureRequestWarning" not in l and "AWSRequest object" not in l
        )
        raise RuntimeError(
            f"exec plugin failed (rc={result.returncode})\n"
            f"argv={argv}\n"
            f"AWS_PROFILE={env.get('AWS_PROFILE')}\n"
            f"HTTPS_PROXY={env.get('HTTPS_PROXY')}\n"
            f"stderr:\n{stderr}"
        )

    import json
    try:
        token_obj = json.loads(result.stdout)
        if not token_obj.get("status", {}).get("token"):
            raise RuntimeError(
                f"exec plugin returned no token\nstdout={result.stdout[:400]}"
            )
    except json.JSONDecodeError:
        raise RuntimeError(f"exec plugin stdout not JSON: {result.stdout[:200]}")


# ------------------------------------------------------------------ #
# Pod helpers
# ------------------------------------------------------------------ #

def _pod_usage(api) -> Tuple[Dict, bool]:
    """Return {(ns, pod_name): (total_cpu_m, total_mem_mi, {container: (cpu_m, mem_mi)})},
    metrics_available."""
    from kubernetes.client import CustomObjectsApi, ApiException  # type: ignore
    try:
        custom = CustomObjectsApi(api)
        data = custom.list_cluster_custom_object("metrics.k8s.io", "v1beta1", "pods")
        out: Dict[Tuple[str, str], Tuple[float, float, Dict[str, Tuple]]] = {}
        for item in data.get("items", []):
            ns = item["metadata"]["namespace"]
            name = item["metadata"]["name"]
            per = {
                c.get("name"): (parse_cpu_m(c.get("usage", {}).get("cpu")),
                                parse_mem_mi(c.get("usage", {}).get("memory")))
                for c in item.get("containers", [])
            }
            cpu = sum(v[0] or 0 for v in per.values())
            mem = sum(v[1] or 0 for v in per.values())
            out[(ns, name)] = (cpu, mem, per)
        return out, True
    except ApiException:
        return {}, False
    except Exception as exc:
        log.warning("metrics.k8s.io error: %s", exc)
        return {}, False


def _pod_basis(pod_spec, basis: str, resource: str = "cpu") -> Optional[float]:
    """Sum container requests or limits for `resource`; fall back to the other.

    Returns millicores for cpu, MiB for memory.
    """
    parse = parse_cpu_m if resource == "cpu" else parse_mem_mi
    containers = getattr(pod_spec, "containers", []) or []
    keys = [basis, "limits" if basis == "requests" else "requests"]
    for key in keys:
        vals = []
        for c in containers:
            res = getattr(c, "resources", None)
            if res is None:
                continue
            mapping = getattr(res, key, None) or {}
            v = parse(mapping.get(resource) if isinstance(mapping, dict)
                      else getattr(mapping, resource, None))
            if v is not None:
                vals.append(v)
        if vals:
            return sum(vals)
    return None


def _pod_restarts(pod_status) -> int:
    """Sum restart counts across the pod's containers."""
    statuses = getattr(pod_status, "container_statuses", None) or []
    return sum(getattr(cs, "restart_count", 0) or 0 for cs in statuses)


def _container_state(cs) -> Optional[str]:
    """'Running', 'Waiting: CrashLoopBackOff', 'Terminated: OOMKilled', …"""
    st = getattr(cs, "state", None)
    if st is None:
        return None
    if getattr(st, "running", None):
        return "Running"
    for kind in ("waiting", "terminated"):
        sub = getattr(st, kind, None)
        if sub:
            reason = getattr(sub, "reason", None)
            return f"{kind.capitalize()}: {reason}" if reason else kind.capitalize()
    return None


def _pct(used: Optional[float], basis: Optional[float]) -> Optional[float]:
    return round(used / basis * 100, 1) if used is not None and basis else None


def _pod_containers(pod_spec, pod_status, per_usage: Dict[str, Tuple],
                    basis: str) -> List[Container]:
    """One Container per spec container: usage from metrics, basis from its own
    requests/limits, restarts/state from its containerStatus."""
    statuses = {getattr(cs, "name", None): cs
                for cs in (getattr(pod_status, "container_statuses", None) or [])}
    out: List[Container] = []
    for c in getattr(pod_spec, "containers", []) or []:
        one = SimpleNamespace(containers=[c])   # reuse _pod_basis per container
        cpu_b = _pod_basis(one, basis)
        mem_b = _pod_basis(one, basis, "memory")
        cpu_u, mem_u = per_usage.get(c.name, (None, None))
        cs = statuses.get(c.name)
        out.append(Container(
            name=c.name,
            usage_m=cpu_u, basis_m=cpu_b, cpu_pct=_pct(cpu_u, cpu_b),
            mem_usage_mi=mem_u, mem_basis_mi=mem_b, mem_pct=_pct(mem_u, mem_b),
            restarts=(getattr(cs, "restart_count", 0) or 0) if cs else 0,
            ready=getattr(cs, "ready", None) if cs else None,
            state=_container_state(cs) if cs else None,
        ))
    return out


# ------------------------------------------------------------------ #
# Per-cluster collection
# ------------------------------------------------------------------ #

def collect_cluster(api, idx: int, settings: Settings, name: str) -> Cluster:
    from kubernetes.client import AppsV1Api, CoreV1Api  # type: ignore

    apps = AppsV1Api(api)
    core = CoreV1Api(api)

    try:
        usage_map, metrics_ok = _pod_usage(api)

        # List deployments
        ns_list = settings.namespaces or [None]
        raw_deps = []
        for ns in ns_list:
            if ns:
                raw_deps += apps.list_namespaced_deployment(ns).items
            else:
                raw_deps += apps.list_deployment_for_all_namespaces().items

        # List pods
        raw_pods = []
        for ns in ns_list:
            if ns:
                raw_pods += core.list_namespaced_pod(ns).items
            else:
                raw_pods += core.list_pod_for_all_namespaces().items

        # Group pods by (ns, labels) for label matching
        deployments = []
        for dep in sorted(raw_deps, key=lambda d: (d.metadata.namespace, d.metadata.name)):
            dep_ns = dep.metadata.namespace
            sel = dep.spec.selector.match_labels or {}

            matched: List[Pod] = []
            for p in raw_pods:
                if p.metadata.namespace != dep_ns:
                    continue
                plabels = p.metadata.labels or {}
                if all(plabels.get(k) == v for k, v in sel.items()):
                    usage_m, mem_mi, per_usage = usage_map.get((dep_ns, p.metadata.name), (None, None, {}))
                    basis_m = _pod_basis(p.spec, settings.cpu_basis)
                    mem_basis = _pod_basis(p.spec, settings.cpu_basis, "memory")
                    cpu_pct: Optional[float] = None
                    if usage_m is not None and basis_m:
                        cpu_pct = round(usage_m / basis_m * 100, 1)
                    mem_pct: Optional[float] = None
                    if mem_mi is not None and mem_basis:
                        mem_pct = round(mem_mi / mem_basis * 100, 1)
                    matched.append(Pod(
                        name=p.metadata.name,
                        node=p.spec.node_name,
                        phase=p.status.phase,
                        usage_m=usage_m,
                        basis_m=basis_m,
                        cpu_pct=cpu_pct,
                        mem_usage_mi=mem_mi,
                        mem_basis_mi=mem_basis,
                        mem_pct=mem_pct,
                        restarts=_pod_restarts(p.status),
                        containers=_pod_containers(p.spec, p.status, per_usage, settings.cpu_basis),
                    ))

            pcts = [pod.cpu_pct for pod in matched if pod.cpu_pct is not None]
            avg = round(mean(pcts), 1) if pcts else None
            deployments.append(Deployment(
                cluster=name,
                namespace=dep_ns,
                name=dep.metadata.name,
                desired=dep.spec.replicas or 0,
                ready=dep.status.ready_replicas or 0,
                avg_cpu=avg,
                status=classify(avg, settings.amber, settings.red),
                pods=matched,
            ))

        return Cluster(name=name, index=idx, deployments=deployments,
                       metrics_available=metrics_ok)

    except Exception as exc:
        log.error("cluster %s error: %s", name, exc)
        return Cluster(name=name, index=idx, error=str(exc), metrics_available=False)


# ------------------------------------------------------------------ #
# Collector
# ------------------------------------------------------------------ #

class Collector:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._clients: Optional[Dict[str, object]] = None
        self._mode = "kubeconfig"

    def _connect(self) -> Dict[str, object]:
        from kubernetes import config as kconfig, client as kclient  # type: ignore
        from kubernetes.config.config_exception import ConfigException  # type: ignore

        clients: Dict[str, object] = {}
        s = self.settings

        # Try in-cluster first
        try:
            kconfig.load_incluster_config()
            self._mode = "in-cluster"
            api = kclient.ApiClient()
            for name in s.clusters or ["in-cluster"]:
                clients[name] = api
            return clients
        except ConfigException:
            pass

        self._mode = "kubeconfig"
        kc_path = (
            s.kubeconfig
            or os.environ.get("KUBECONFIG")
            or os.path.expanduser("~/.kube/config")
        )

        all_contexts, _ = kconfig.list_kube_config_contexts(config_file=kc_path)
        available = [c["name"] for c in all_contexts]
        targets = s.clusters or available

        for name in targets:
            if name not in available:
                clients[name] = RuntimeError(
                    f"Context '{name}' not found. Available: {available}"
                )
                continue
            try:
                _exec_plugin_check(kc_path, name)
                cfg = kclient.Configuration()
                kconfig.load_kube_config(
                    config_file=kc_path, context=name, client_configuration=cfg
                )
                _apply_proxy_env(cfg, cfg.host)
                clients[name] = kclient.ApiClient(configuration=cfg)
            except Exception as exc:
                clients[name] = exc

        return clients

    def snapshot(self) -> Snapshot:
        if self._clients is None:
            self._clients = self._connect()

        clusters = []
        errors_only = {k: v for k, v in self._clients.items() if isinstance(v, Exception)}
        good = {k: v for k, v in self._clients.items() if not isinstance(v, Exception)}

        # Error-only clusters get empty error objects immediately
        for idx, (name, exc) in enumerate(errors_only.items()):
            clusters.append(Cluster(name=name, index=idx, error=str(exc),
                                    metrics_available=False))

        base_idx = len(errors_only)
        with ThreadPoolExecutor(max_workers=len(good) or 1) as pool:
            futs = {
                pool.submit(collect_cluster, api, base_idx + i, self.settings, name): name
                for i, (name, api) in enumerate(good.items())
            }
            results = {}
            for fut in as_completed(futs):
                name = futs[fut]
                try:
                    results[name] = fut.result()
                except Exception as exc:
                    results[name] = Cluster(name=name, index=0, error=str(exc))

        # Preserve order
        for i, name in enumerate(good.keys()):
            c = results.get(name, Cluster(name=name, index=base_idx + i))
            c.index = base_idx + i
            clusters.append(c)

        return Snapshot(clusters=clusters, mode=self._mode)
