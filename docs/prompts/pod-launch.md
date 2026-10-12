# Prompt: pod launch for red deployments

Reusable prompt that rebuilds the "pod launch" feature (pods of red deployments
circle above the sphere, launch onto their own plane when clicked, and show CPU,
memory and restarts, with a per-container breakdown). Paste everything below the line into an AI coding tool
working on a copy of Cluster Monitor.

---

You are working on "Cluster Monitor", a Python/FastAPI app that shows Kubernetes
deployments across multiple EKS clusters as a 3D scene drawn on an HTML canvas
(plain Canvas 2D, no libraries). Each cluster is a tilted grid plane; each
deployment is a glossy sphere coloured by average CPU vs request
(green ≤60%, amber 60–90%, red >90%, grey = no metrics). Clicking a sphere opens
a detail card (top-right) with a pod table.

Add a "pod launch" feature for RED deployments, end to end (backend + frontend).

## 1. Backend: pods need memory and restart data

- Pod dataclass (`monitor/model.py`): add optional fields with defaults so old code
  keeps working: `mem_usage_mi` (MiB working set), `mem_basis_mi` (MiB request, or
  limit per the existing `cpu_basis` setting), `mem_pct` (usage/basis*100, 1 dp),
  `restarts` (int, sum of container restartCount).
- k8s collector (`monitor/k8s.py`):
  - Add `parse_mem_mi(q)` converting Kubernetes memory quantities to MiB:
    Ki, Mi, Gi, Ti, k, M, G, T, and plain bytes; return None on junk/empty.
  - The metrics.k8s.io pod-usage call already returns per-container usage: sum both
    cpu and memory per pod and return `(cpu_m, mem_mi)`.
  - Generalise the request/limit helper to take a resource (`"cpu"` or `"memory"`).
  - Restarts = sum of `status.container_statuses[*].restart_count` (0 if none).
  - Fill the new Pod fields; no extra RBAC needed.
- Demo collector (if present): give pods realistic memory (request scales with CPU
  request, min 128Mi). Pods of red deployments run 72–96% memory and sometimes
  restart (0–8); healthy pods 18–62% and rarely restart. IMPORTANT: pod names and
  nodes must be stable across refreshes (seed them from cluster/namespace/
  deployment/index), otherwise a selected pod disappears on the next refresh.
- **Per-container breakdown:**
  - Add a `Container` dataclass (`name`, `usage_m`, `basis_m`, `cpu_pct`,
    `mem_usage_mi`, `mem_basis_mi`, `mem_pct`, `restarts`, `ready`, `state`) and a
    `containers: List[Container]` field on Pod (default empty list).
  - k8s: keep the per-container usage from metrics.k8s.io (return
    `(cpu_m, mem_mi, {container_name: (cpu_m, mem_mi)})` per pod). Build one
    Container per `spec.containers` entry: basis from that container's own
    request/limit (reuse the resource helper on a one-container spec), restarts and
    `ready` from the matching `containerStatus` by name, and `state` as `"Running"`,
    `"Waiting: <reason>"` or `"Terminated: <reason>"`. Missing metrics or status
    leave those fields None/0. Pod-level totals stay as before.
  - Demo: every pod has an app container named after the deployment; about half the
    deployments (stable per deployment) also run a light `fluent-bit` sidecar. Split
    the pod's usage, requests and restarts across the containers so they add up to
    the pod totals (app ~85% of requests; sidecar 4–12% of CPU and 6–15% of memory
    usage). Use a separate RNG seeded per pod for the split so the rest of the demo
    data does not change. CrashLoopBackOff pods show the app as
    `Waiting: CrashLoopBackOff`; Pending pods show `Waiting: ContainerCreating`.
- Tests: `parse_mem_mi` units and junk, the restart summing helper, and that demo
  pods carry `mem_pct` in 0–100 with restarts as non-negative ints. For containers:
  the k8s builder maps usage/basis/restarts/ready/state per container and copes with
  no metrics and no status; demo pods all have containers, some have two, and
  container restarts, CPU and memory add up to the pod values.

## 2. Frontend: pods of red deployments

- **Resting state:** every red deployment shows its pods as small spheres
  (world radius ~0.12) circling slowly in a ring just above the big sphere.
  Colour each pod by its own CPU status (non-Running phase = grey). Pods with
  restarts > 0 get a thin amber outer ring.
- **Launch:** clicking a red deployment (or one of its ring pods) animates
  (~650 ms, ease-out) the pods upward from the ring onto their own small grid plane
  ~7.5 world units above the deployment's cluster plane (spacing ~1.7, pod radius
  grows to ~0.5). Draw the pod plane as a translucent dark-red rectangle with a red
  border, a dashed tether line from the deployment sphere up to the plane, and a
  caption "<deployment> · N PODS". Draw launched pods after everything else so they
  are on top. Show each pod's CPU % (integer, no % sign) inside its sphere.
- **Camera:** on launch, smoothly fly (~700 ms) to centre the pod plane and zoom in
  a bit. Offset the target left so the pod plane sits in the visible area beside the
  detail card, not under it; compute the pixel→world conversion at the focus
  point's depth, not at the scene origin. Pause auto-orbit while pods are launched.
  User drag cancels the camera tween; the Home button resets the camera and
  collapses the pods.
- **Collapse:** click the same deployment again, click empty space, close the detail
  card, or press Home. Collapse animates in reverse.
- **Hover tooltip on a pod:** pod name; "namespace / deployment · phase";
  "CPU x% · MEM y% · RESTARTS n" with CPU and MEM coloured by status. The deployment
  tooltip for red deployments adds "click to launch pods".
- **Click a pod:** the detail card switches to a pod view with title
  "cluster › namespace / deployment" and "POD <name>", then rows:
  CPU (big %, plus "Xm used of Ym requested"), MEMORY (big %, plus
  "X Mi used of Y Mi requested"), RESTARTS (green 0, amber ≥1, red ≥5), PHASE,
  NODE. Below those, a "CONTAINERS (n)" table with one row per container:
  name with a state dot (green Running, amber running but not ready, red
  waiting/terminated) and the state text underneath; CPU and MEMORY as meter bar +
  % with "used / requested m" and "used / requested Mi" underneath; RESTARTS
  (amber ≥1, red ≥5). Omit the table when the pod has no containers. End with a
  "‹ ALL PODS OF <deployment>" button back to the deployment view.
  Use a selection key like `cluster/ns/deployment#podName`; keep the selection
  across data refreshes.
- **Deployment detail card:** add MEM (meter bar + %) and RESTARTS columns to the pod
  table; clicking a row opens that pod's view (and launches the pods if the
  deployment is red). Widen the card (~600px) so the new columns fit.
- **Picking:** record launched and ring pods in the per-frame hit list after their
  deployment so pods take click priority over the big sphere.

Keep the existing visual style (muted colours, monospace font, glossy spheres)
and don't break existing features (search, namespace filter, alerts-only,
auto-orbit, zoom/pan). Run the test suite at the end.
