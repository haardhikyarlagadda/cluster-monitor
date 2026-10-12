# Prompt: per-container breakdown in the pod card

Reusable prompt that adds a containers table to the pod view of the detail card
(each container's CPU, memory, restarts and state). It builds on the pod-launch
feature (`pod-launch.md`), which must already be in place. Paste everything below
the line into an AI coding tool working on a copy of Cluster Monitor.

---

You are working on "Cluster Monitor", a Python/FastAPI app that shows Kubernetes
deployments across multiple EKS clusters as a 3D scene drawn on an HTML canvas
(plain Canvas 2D, no libraries). Clicking a pod opens a pod view in the detail card
(top-right) showing the pod's CPU, MEMORY, RESTARTS, PHASE and NODE. Pods already
carry `usage_m`, `basis_m`, `cpu_pct`, `mem_usage_mi`, `mem_basis_mi`, `mem_pct` and
`restarts` (sum of container restart counts).

Add a per-container breakdown under the pod's stats, end to end.

## 1. Backend

- **Model (`monitor/model.py`):** add a `Container` dataclass with `name`, `usage_m`,
  `basis_m`, `cpu_pct`, `mem_usage_mi`, `mem_basis_mi`, `mem_pct` (all optional),
  `restarts` (int, default 0), `ready` (optional bool) and `state` (optional str:
  `"Running"`, `"Waiting: <reason>"` or `"Terminated: <reason>"`). Add
  `containers: List[Container]` to Pod with an empty-list default so existing code
  keeps working. The JSON API serialises it automatically if it uses `asdict`.
- **k8s collector (`monitor/k8s.py`):**
  - The metrics.k8s.io pod-usage call already returns per-container usage. Keep it:
    return `(cpu_m, mem_mi, {container_name: (cpu_m, mem_mi)})` per pod, and update
    the caller (default `(None, None, {})` when a pod has no metrics).
  - Add a helper that builds one Container per `spec.containers` entry: basis from
    that container's own request (or limit, per the existing `cpu_basis` setting;
    reuse the existing request/limit helper on a one-container spec, e.g. a
    `SimpleNamespace(containers=[c])`); usage from the metrics map by name;
    `restarts`, `ready` and `state` from the matching `status.container_statuses`
    entry by name. Missing metrics or status leave those fields None/0.
  - Pod-level totals stay exactly as before. No extra RBAC is needed.
- **Demo collector (`monitor/demo.py`):** every pod gets an app container named after
  the deployment. About half the deployments (decided stably per deployment name)
  also run a light `fluent-bit` log sidecar. Split the pod's usage, requests and
  restarts across the containers so they add up to the pod totals: app gets ~85% of
  the requests; the sidecar uses 4–12% of the pod's CPU and 6–15% of its memory, and
  occasionally takes one of the restarts. App state: `Running` for running pods,
  `Waiting: CrashLoopBackOff` for crash-looping pods, `Waiting: ContainerCreating`
  for pending ones. IMPORTANT: use a separate RNG seeded per pod
  (e.g. `random.Random(f"{ident}#{i}#containers")`) for the split, so the shared
  demo RNG sequence and all other demo data stay unchanged.
- **Tests:**
  - the k8s container builder maps usage, basis, cpu/mem %, restarts, ready and
    state per container (use fake spec/status objects, e.g. SimpleNamespace);
  - it copes with no metrics and no status;
  - demo pods all have containers, some have two, and container restarts, CPU and
    memory add up to the pod values (allow small rounding differences).

## 2. Frontend (`monitor/static/app.js`, `style.css`)

- In the pod view, below the PHASE/NODE rows and above the
  "‹ ALL PODS OF <deployment>" button, add a "CONTAINERS (n)" label and a table with
  columns CONTAINER, CPU, MEMORY, RESTARTS. One row per container:
  - **Container:** a small state dot (green = Running, amber = running but not
    ready, red = waiting/terminated, grey = unknown) and the name, with the state
    text underneath (append "· not ready" when running but not ready).
  - **CPU / MEMORY:** reuse the existing meter cell (bar + % coloured by status),
    with "used / requested m" and "used / requested Mi" underneath in the dim note
    style.
  - **Restarts:** right-aligned; amber at ≥1, red at ≥5.
- Omit the table entirely when the pod has no containers (e.g. old data).
- Keep the card's existing look (muted colours, monospace font, same table style as
  the deployment pod table). The card may scroll on small screens; that is fine.

Don't break existing features (pod launch, tooltips, search, namespace filter,
alerts-only, auto-orbit, zoom/pan, selection kept across refreshes). Run the test
suite at the end.
