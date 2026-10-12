// app.js – Cluster Monitor 3D HUD (Canvas 2D, no dependencies)
"use strict";

// ─── constants ──────────────────────────────────────────────────────────────
const C_CYAN    = "#5fb4c4";
const STATUS_RGB = {
  green:   [56, 160, 104],
  amber:   [204, 156, 52],
  red:     [196, 72, 88],
  unknown: [112, 124, 142],
};
// one neon hue per cluster plane: cyan, magenta, green, orange, blue, yellow, pink
const CLUSTER_HUES = [188, 292, 142, 28, 217, 48, 330];

const CELL_SIZE   = 2.0;   // world units between sphere centres
const PLANE_GAP_X = 6.0;   // gap between planes side by side
const PLANE_GAP_Z = 7.0;   // gap between rows of planes
const PLANE_STEP_Y = -1.6; // each later plane sits slightly higher
const FOV_K       = 1.8;   // lens: higher = flatter perspective (camera sits further back)
const POST_H      = 3.6;   // height of the corner posts
const IDLE_ORBIT_MS = 4000;

// ─── state ───────────────────────────────────────────────────────────────────
let snapshot = null;
let config   = { amber: 60, red: 90, refresh: 15, demo: false,
                 lat_amber_ms: 250, lat_red_ms: 600, err_amber_pct: 0.5, err_red_pct: 2 };
let searchTerm = "";
let alertsOnly = false;
let autoOrbit  = true;
let nsSel      = loadJSON("nsSel", {});
let uiScale    = parseFloat(localStorage.getItem("uiScale") || "1") || 1;

let cam = { yaw: -0.55, pitch: 0.5, dist: 60, tx: 0, ty: 0 };
let homeCam = { ...cam };
let drag = { active: false, shift: false, sx: 0, sy: 0, yaw0: 0, pitch0: 0, tx0: 0, ty0: 0 };
let lastInteract = 0;

let hoveredKey = null;
let selectedKey = null;   // "cluster/ns/dep" or "cluster/ns/dep#podName"
// pods of one red deployment can be "launched" onto a plane above it
let podAnim = { key: null, t0: 0, open: false };
const POD_LAUNCH_H  = 7.5;   // world units the pod plane floats above the deployment's plane
const POD_SPACING   = 1.7;   // world units between launched pod spheres
const POD_R_RING    = 0.12;  // pod sphere radius while circling the deployment
const POD_R_LAUNCH  = 0.5;   // pod sphere radius once launched
let camTween = null;         // { from, to, t0, ms } — smooth camera moves
const podFocus = {};         // red deployment key -> world point to centre on when launching
const POD_ANIM_MS   = 650;
let mouse = { x: 0, y: 0, inside: false };

let layout = [];   // per-cluster plane geometry, rebuilt when data/filters change
let drawn  = [];   // spheres drawn this frame, in paint order (for picking)
let stars  = [];

// mesh traffic (Kuma): arcs between deployments and to external endpoints
const TRAFFIC_MODES = ["focus", "problems", "all", "off"];
const TCP_RGB = [118, 138, 170];
const EXT_ICON = { ingress: "IN", database: "DB", queue: "MQ", storage: "S3", api: "API" };
let trafficMode = TRAFFIC_MODES.includes(localStorage.getItem("trafficMode"))
  ? localStorage.getItem("trafficMode") : "focus";
let trafficIdx = new Map();   // node key -> edges touching it (externals scoped "cluster|ext:name")
let nodePos = {};             // node key -> world position this frame (sphere centre + radius)

const bgCanvas = document.getElementById("canvas-bg");
const fgCanvas = document.getElementById("canvas-fg");
const bgCtx    = bgCanvas.getContext("2d");
const fgCtx    = fgCanvas.getContext("2d");
const tooltip  = document.getElementById("tooltip");
const FONT     = getComputedStyle(document.body).fontFamily;

let W = 0, H = 0, DPR = 1;

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch { return fallback; }
}
function saveLS(key, val) { try { localStorage.setItem(key, val); } catch {} }

// ─── geometry ────────────────────────────────────────────────────────────────
function project(x, y, z) {
  const cosY = Math.cos(cam.yaw),   sinY = Math.sin(cam.yaw);
  const cosP = Math.cos(cam.pitch), sinP = Math.sin(cam.pitch);
  const rx  = x * cosY - z * sinY;
  const rz  = x * sinY + z * cosY;
  const ry2 = y * cosP - rz * sinP;
  const rz2 = y * sinP + rz * cosP;
  const fov = Math.min(W, H) * FOV_K;
  const scale = fov / Math.max(0.5, rz2 + cam.dist);
  return {
    sx: W / 2 + (rx + cam.tx) * scale,
    sy: H / 2 + (ry2 + cam.ty) * scale,
    scale,
    depth: rz2,
  };
}

function gridDims(count) {
  const cols = Math.max(3, Math.ceil(Math.sqrt(count * 1.3)));
  const rows = Math.max(2, Math.ceil(count / cols));
  return { cols, rows };
}

function depKey(dep) { return `${dep.cluster}/${dep.namespace}/${dep.name}`; }

function sphereRadius(desired) {
  return 0.42 + Math.min(desired || 1, 12) * 0.03;
}

// ─── filtering ───────────────────────────────────────────────────────────────
function filterDeps(cl) {
  const deps = cl?.deployments || [];
  const sel = nsSel[cl?.name];
  const q = searchTerm.toLowerCase();
  return deps.filter(d => {
    if (Array.isArray(sel) && !sel.includes(d.namespace)) return false;
    if (alertsOnly && d.status !== "red" && d.status !== "amber") return false;
    if (q && !d.name.toLowerCase().includes(q) && !d.namespace.toLowerCase().includes(q)) return false;
    return true;
  });
}

// ─── layout: planes in a receding diagonal row ───────────────────────────────
function buildLayout() {
  if (!snapshot) { layout = []; return; }
  const planes = snapshot.clusters.map((cl, ci) => {
    const visible = filterDeps(cl);
    const { cols, rows } = gridDims(Math.max((cl.deployments || []).length, 1));
    return {
      ci, cl, visible, cols, rows,
      hue: CLUSTER_HUES[ci % CLUSTER_HUES.length],
      hw: (cols * CELL_SIZE) / 2 + CELL_SIZE * 0.5,
      hd: (rows * CELL_SIZE) / 2 + CELL_SIZE * 0.5,
    };
  });
  // compact grid of planes (2–3 per row); each later plane sits a little higher
  const perRow = Math.max(1, Math.ceil(Math.sqrt(planes.length)));
  const colW = [], rowD = [];
  planes.forEach((p, i) => {
    const c = i % perRow, r = Math.floor(i / perRow);
    colW[c] = Math.max(colW[c] || 0, p.hw * 2);
    rowD[r] = Math.max(rowD[r] || 0, p.hd * 2);
  });
  planes.forEach((p, i) => {
    const c = i % perRow, r = Math.floor(i / perRow);
    const x0 = colW.slice(0, c).reduce((a, b) => a + b + PLANE_GAP_X, 0);
    const z0 = rowD.slice(0, r).reduce((a, b) => a + b + PLANE_GAP_Z, 0);
    p.bx = x0 + colW[c] / 2;
    p.bz = -(z0 + rowD[r] / 2);
    p.by = i * PLANE_STEP_Y;
  });
  // centre the whole arrangement on the origin so orbiting pivots around it
  const minX = Math.min(...planes.map(p => p.bx - p.hw)), maxX = Math.max(...planes.map(p => p.bx + p.hw));
  const minZ = Math.min(...planes.map(p => p.bz - p.hd)), maxZ = Math.max(...planes.map(p => p.bz + p.hd));
  const minY = Math.min(...planes.map(p => p.by)),        maxY = Math.max(...planes.map(p => p.by));
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, cy = (minY + maxY) / 2;
  planes.forEach(p => { p.bx -= cx; p.bz -= cz; p.by -= cy; });

  // traffic: scope external ids per cluster, index edges by node, and park the
  // external endpoints just outside the plane (ingress left, the rest right)
  trafficIdx = new Map();
  planes.forEach(p => {
    const scope = id => id.startsWith("ext:") ? `${p.cl.name}|${id}` : id;
    p.edges = (p.cl.edges || []).map(e => ({ ...e, source: scope(e.source), target: scope(e.target) }));
    for (const e of p.edges) for (const k of [e.source, e.target]) {
      if (!trafficIdx.has(k)) trafficIdx.set(k, []);
      trafficIdx.get(k).push(e);
    }
    const ext = p.cl.externals || [];
    const sinks = ext.filter(e => e.kind !== "ingress");
    p.ext = ext.map(e => {
      const key = scope(e.id);
      if (e.kind === "ingress") return { ...e, key, x: p.bx - p.hw - 1.8, y: p.by - 0.5, z: p.bz };
      const i = sinks.indexOf(e), n = sinks.length;
      return { ...e, key, x: p.bx + p.hw + 1.8, y: p.by - 0.5,
               z: p.bz + (n > 1 ? (i / (n - 1) - 0.5) * p.hd * 1.5 : 0) };
    });
  });
  layout = planes;
  layout.radius = Math.hypot(maxX - minX, maxZ - minZ) / 2 || 10;
}

function cellWorld(p, idx) {
  const col = idx % p.cols, row = Math.floor(idx / p.cols);
  return {
    x: p.bx + (col - (p.cols - 1) / 2) * CELL_SIZE,
    z: p.bz + (row - (p.rows - 1) / 2) * CELL_SIZE,
  };
}

// ─── colour helpers ──────────────────────────────────────────────────────────
function rgba(rgb, a) { return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`; }
function mix(rgb, to, k) { return rgb.map((v, i) => Math.round(v + (to[i] - v) * k)); }
function statusOf(pct) {
  if (pct == null) return "unknown";
  return pct > config.red ? "red" : pct > config.amber ? "amber" : "green";
}

// ─── background (gradient + stars) ───────────────────────────────────────────
function drawBackground() {
  const g = bgCtx.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.45, Math.max(W, H) * 0.75);
  g.addColorStop(0, "#1a2736");
  g.addColorStop(1, "#0a1018");
  bgCtx.fillStyle = g;
  bgCtx.fillRect(0, 0, W, H);
  if (!stars.length) {
    for (let i = 0; i < 160; i++) stars.push([Math.random(), Math.random(), Math.random()]);
  }
  for (const [u, v, b] of stars) {
    bgCtx.fillStyle = `rgba(210,225,240,${0.08 + b * 0.25})`;
    bgCtx.fillRect(u * W, v * H, b > 0.85 ? 2 : 1.2, b > 0.85 ? 2 : 1.2);
  }
}

// ─── plane ───────────────────────────────────────────────────────────────────
function drawPlane(ctx, p) {
  const { bx, by, bz, hw, hd, hue } = p;
  const c = [
    project(bx - hw, by, bz - hd), project(bx + hw, by, bz - hd),
    project(bx + hw, by, bz + hd), project(bx - hw, by, bz + hd),
  ];

  // translucent tinted floor
  ctx.beginPath();
  c.forEach((q, i) => i ? ctx.lineTo(q.sx, q.sy) : ctx.moveTo(q.sx, q.sy));
  ctx.closePath();
  ctx.fillStyle = `hsla(${hue}, 40%, 30%, 0.10)`;
  ctx.fill();

  // grid: minor every half cell, major every cell
  const line = (x0, z0, x1, z1) => {
    const a = project(x0, by, z0), b = project(x1, by, z1);
    ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
  };
  const step = CELL_SIZE / 2;
  ctx.lineWidth = 0.6;
  for (let x = -hw + step; x < hw - 1e-6; x += step) {
    const major = Math.abs(((x + hw) / CELL_SIZE) % 1) < 1e-6;
    ctx.strokeStyle = `hsla(${hue}, 40%, 55%, ${major ? 0.24 : 0.08})`;
    line(bx + x, bz - hd, bx + x, bz + hd);
  }
  for (let z = -hd + step; z < hd - 1e-6; z += step) {
    const major = Math.abs(((z + hd) / CELL_SIZE) % 1) < 1e-6;
    ctx.strokeStyle = `hsla(${hue}, 40%, 55%, ${major ? 0.24 : 0.08})`;
    line(bx - hw, bz + z, bx + hw, bz + z);
  }

  // corner posts fading upward
  for (const [x, z] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) {
    const a = project(bx + x, by, bz + z), b = project(bx + x, by - POST_H, bz + z);
    const g = ctx.createLinearGradient(a.sx, a.sy, b.sx, b.sy);
    g.addColorStop(0, `hsla(${hue}, 45%, 62%, 0.35)`);
    g.addColorStop(1, `hsla(${hue}, 45%, 62%, 0)`);
    ctx.strokeStyle = g; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
  }

  // bright neon border
  ctx.save();
  ctx.shadowColor = `hsla(${hue}, 60%, 50%, 0.35)`;
  ctx.shadowBlur = 4;
  ctx.strokeStyle = `hsla(${hue}, 50%, 56%, 0.85)`;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  c.forEach((q, i) => i ? ctx.lineTo(q.sx, q.sy) : ctx.moveTo(q.sx, q.sy));
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

// ─── sphere ──────────────────────────────────────────────────────────────────
function drawSphere(ctx, item, now) {
  const { dep, sp, floor, r } = item;
  const base = STATUS_RGB[dep.status] || STATUS_RGB.unknown;
  const key = item.key;

  // contact shadow on the plane
  ctx.beginPath();
  ctx.ellipse(floor.sx, floor.sy, r * 0.95, r * Math.max(0.18, Math.sin(cam.pitch) * 0.45), 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.38)";
  ctx.fill();

  // alert target rings for red
  if (dep.status === "red") {
    const pulse = 0.55 + 0.45 * Math.sin(now / 220);
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(196,72,88,${0.55 * pulse + 0.15})`;
    ctx.beginPath(); ctx.arc(sp.sx, sp.sy, r * 1.5, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = `rgba(200,120,70,${0.35 * pulse})`;
    ctx.beginPath(); ctx.arc(sp.sx, sp.sy, r * 1.75, 0, Math.PI * 2); ctx.stroke();
  }

  // dotted ring: inbound mesh traffic is slow or failing
  const ts = dep.traffic && dep.traffic.status;
  if (trafficMode !== "off" && (ts === "amber" || ts === "red")) {
    ctx.save();
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = rgba(STATUS_RGB[ts], 0.8);
    ctx.beginPath(); ctx.arc(sp.sx, sp.sy, r * 1.95, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // soft halo ring
  ctx.beginPath();
  ctx.arc(sp.sx, sp.sy, r * 1.22, 0, Math.PI * 2);
  ctx.fillStyle = rgba(base, 0.05);
  ctx.fill();
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = rgba(mix(base, [255, 255, 255], 0.2), 0.35);
  ctx.stroke();

  // glossy body
  const g = ctx.createRadialGradient(sp.sx - r * 0.35, sp.sy - r * 0.4, r * 0.05, sp.sx, sp.sy, r);
  g.addColorStop(0, rgba(mix(base, [255, 255, 255], 0.38), 0.95));
  g.addColorStop(0.45, rgba(base, 0.88));
  g.addColorStop(1, rgba(mix(base, [0, 0, 0], 0.6), 0.92));
  ctx.beginPath();
  ctx.arc(sp.sx, sp.sy, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(mix(base, [255, 255, 255], 0.25), 0.4);
  ctx.stroke();

  // CPU number (no % sign, like the reference)
  if (r > 6 && dep.avg_cpu != null) {
    const fs = Math.max(7, Math.min(r * 0.85, 16));
    ctx.font = `bold ${fs}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = dep.status === "red" ? "rgba(255,236,238,0.9)" : rgba(mix(base, [0, 0, 0], 0.72), 0.95);
    ctx.fillText(Math.round(dep.avg_cpu).toString(), sp.sx, sp.sy + 0.5);
  }

  // hover / selection rings
  if (key === hoveredKey || key === selectedKey) {
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = key === selectedKey ? "#ffffff" : C_CYAN;
    ctx.setLineDash(key === selectedKey ? [4, 3] : []);
    ctx.beginPath(); ctx.arc(sp.sx, sp.sy, r * 1.38, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ─── pods of red deployments ──────────────────────────────────────────────────
function podKey(dep, pod) { return `${depKey(dep)}#${pod.name}`; }

function podStatus(pod) {
  if (pod.phase && pod.phase !== "Running") return "unknown";
  return statusOf(pod.cpu_pct);
}

function easeOut(x) { return 1 - Math.pow(1 - x, 3); }

// 0 = resting in the ring above the sphere, 1 = fully launched onto the pod plane
function podProgress(key, now) {
  if (podAnim.key !== key) return 0;
  const x = Math.min(1, Math.max(0, (now - podAnim.t0) / POD_ANIM_MS));
  if (podAnim.open) return easeOut(x);
  if (x >= 1) { podAnim.key = null; return 0; }
  return 1 - easeOut(x);
}

function launchPods(key, focus) {
  podAnim = { key, t0: performance.now(), open: true };
  if (focus) flyTo(focus.x, focus.y, focus.z, Math.min(cam.dist, Math.max(22, layout.radius * 0.9)));
}

// screen-space offsets (cam.tx/ty) that put world point (x,y,z) at the centre of the view
function centreOffsets(x, y, z) {
  const cosY = Math.cos(cam.yaw), sinY = Math.sin(cam.yaw);
  const cosP = Math.cos(cam.pitch), sinP = Math.sin(cam.pitch);
  const rx = x * cosY - z * sinY;
  const rz = x * sinY + z * cosY;
  return { tx: -rx, ty: -(y * cosP - rz * sinP), depth: y * sinP + rz * cosP };
}

function flyTo(x, y, z, dist) {
  const c = centreOffsets(x, y, z);
  // keep the focus point clear of the detail card on the right: aim at the
  // middle of the visible area instead of the middle of the canvas
  const card = document.getElementById("detail");
  const cardW = card.classList.contains("hidden") ? 0 : card.offsetWidth + 18;
  const k = Math.min(W, H) * FOV_K / Math.max(0.5, c.depth + dist);   // px per world unit at the focus point
  camTween = { from: { tx: cam.tx, ty: cam.ty, dist: cam.dist },
               to: { tx: c.tx - (cardW / 2) / k, ty: c.ty, dist }, t0: performance.now(), ms: 700 };
}

function stepCamTween(now) {
  if (!camTween) return;
  const k = easeOut(Math.min(1, (now - camTween.t0) / camTween.ms));
  for (const f of ["tx", "ty", "dist"]) cam[f] = camTween.from[f] + (camTween.to[f] - camTween.from[f]) * k;
  if (k >= 1) camTween = null;
}
function collapsePods() {
  if (podAnim.key && podAnim.open) podAnim = { key: podAnim.key, t0: performance.now(), open: false };
}

function podRingWorld(it, i, n, now) {
  const a = (i / n) * Math.PI * 2 + now / 2600;
  const rr = it.rw * 0.85 + 0.2;
  return { x: it.wx + Math.cos(a) * rr, y: it.wy - it.rw - 0.42, z: it.wz + Math.sin(a) * rr };
}

function podPlaneDims(n) {
  const cols = Math.max(2, Math.ceil(Math.sqrt(n)));
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}

function podPlaneWorld(it, i, n) {
  const { cols, rows } = podPlaneDims(n);
  const c = i % cols, r = Math.floor(i / cols);
  return {
    x: it.wx + (c - (cols - 1) / 2) * POD_SPACING,
    y: it.plane.by - POD_LAUNCH_H,
    z: it.wz + (r - (rows - 1) / 2) * POD_SPACING,
  };
}

function drawPodSphere(ctx, sp, r, pod, showLabel) {
  const base = STATUS_RGB[podStatus(pod)] || STATUS_RGB.unknown;
  const g = ctx.createRadialGradient(sp.sx - r * 0.35, sp.sy - r * 0.4, r * 0.05, sp.sx, sp.sy, r);
  g.addColorStop(0, rgba(mix(base, [255, 255, 255], 0.4), 0.95));
  g.addColorStop(0.5, rgba(base, 0.9));
  g.addColorStop(1, rgba(mix(base, [0, 0, 0], 0.6), 0.92));
  ctx.beginPath();
  ctx.arc(sp.sx, sp.sy, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(mix(base, [255, 255, 255], 0.3), 0.5);
  ctx.stroke();
  if ((pod.restarts || 0) > 0) {          // restart marker: thin amber ring
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "rgba(204,156,52,0.85)";
    ctx.beginPath(); ctx.arc(sp.sx, sp.sy, r * 1.3, 0, Math.PI * 2); ctx.stroke();
  }
  if (showLabel && r > 7 && pod.cpu_pct != null) {
    ctx.font = `bold ${Math.max(7, Math.min(r * 0.8, 13))}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = podStatus(pod) === "red" ? "rgba(255,236,238,0.9)" : rgba(mix(base, [0, 0, 0], 0.72), 0.95);
    ctx.fillText(Math.round(pod.cpu_pct).toString(), sp.sx, sp.sy + 0.5);
  }
}

function markPodSelection(ctx, key, sp, r) {
  if (key !== hoveredKey && key !== selectedKey) return;
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = key === selectedKey ? "#ffffff" : C_CYAN;
  ctx.setLineDash(key === selectedKey ? [3, 3] : []);
  ctx.beginPath(); ctx.arc(sp.sx, sp.sy, r * 1.55, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
}

// small pod spheres circling just above a red deployment
function drawPodRing(ctx, it, now) {
  const pods = it.dep.pods, n = pods.length;
  const ring = pods.map((pod, i) => {
    const w = podRingWorld(it, i, n, now);
    return { pod, sp: project(w.x, w.y, w.z) };
  }).sort((a, b) => b.sp.depth - a.sp.depth);
  for (const { pod, sp } of ring) {
    const r = POD_R_RING * sp.scale;
    if (r < 0.6) continue;
    drawPodSphere(ctx, sp, r, pod, false);
    const key = podKey(it.dep, pod);
    markPodSelection(ctx, key, sp, r);
    drawn.push({ kind: "pod", dep: it.dep, pod, key, depItemKey: it.key, sp, r });
  }
}

// pods lifted onto their own plane above the deployment, tethered to it
function drawLaunchedPods(ctx, it, prog, now) {
  const pods = it.dep.pods, n = pods.length;
  const { cols, rows } = podPlaneDims(n);
  const cy = it.plane.by - POD_LAUNCH_H * prog;
  const hw = (cols * POD_SPACING) / 2, hd = (rows * POD_SPACING) / 2;

  // tether from the deployment sphere to the pod plane
  const top = project(it.wx, it.wy - it.rw, it.wz), mid = project(it.wx, cy, it.wz);
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = `rgba(196,72,88,${0.5 * prog})`;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(top.sx, top.sy); ctx.lineTo(mid.sx, mid.sy); ctx.stroke();
  ctx.restore();

  // the pod plane itself
  const corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, z]) => project(it.wx + x, cy, it.wz + z));
  ctx.beginPath();
  corners.forEach((q, i) => i ? ctx.lineTo(q.sx, q.sy) : ctx.moveTo(q.sx, q.sy));
  ctx.closePath();
  ctx.fillStyle = `rgba(60,20,28,${0.35 * prog})`;
  ctx.fill();
  ctx.strokeStyle = `rgba(196,72,88,${0.75 * prog})`;
  ctx.lineWidth = 1.3;
  ctx.stroke();

  // plane caption
  if (prog > 0.6) {
    const lab = project(it.wx - hw, cy, it.wz + hd);
    ctx.font = `bold ${10.5 * uiScale}px ${FONT}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = `rgba(222,170,176,${prog})`;
    ctx.fillText(`${it.dep.name} · ${n} PODS`, lab.sx, lab.sy + 4);
  }

  const placed = pods.map((pod, i) => {
    const a = podRingWorld(it, i, n, now), b = podPlaneWorld(it, i, n);
    const rw = POD_R_RING + (POD_R_LAUNCH - POD_R_RING) * prog;
    const w = { x: a.x + (b.x - a.x) * prog, y: a.y + (b.y - a.y) * prog, z: a.z + (b.z - a.z) * prog };
    const sp = project(w.x, w.y - rw, w.z);
    return { pod, sp, r: rw * sp.scale };
  }).sort((a, b) => b.sp.depth - a.sp.depth);

  for (const { pod, sp, r } of placed) {
    if (r < 0.6) continue;
    drawPodSphere(ctx, sp, r, pod, prog > 0.8);
    const key = podKey(it.dep, pod);
    markPodSelection(ctx, key, sp, r);
    drawn.push({ kind: "pod", dep: it.dep, pod, key, depItemKey: it.key, sp, r });
  }
}

// ─── mesh traffic: external endpoints + arcs ─────────────────────────────────
function trafficRGB(status) { return status === "green" || status === "amber" || status === "red" ? STATUS_RGB[status] : TCP_RGB; }
function fmtRps(v) { return v == null ? "—" : v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(0) : v.toFixed(1); }
function fmtMs(v)  { return v == null ? "—" : v >= 1000 ? (v / 1000).toFixed(2) + " s" : Math.round(v) + " ms"; }
function fmtKbps(v) { return v == null ? "—" : v >= 1024 ? (v / 1024).toFixed(1) + " MB/s" : Math.round(v) + " kB/s"; }
function latRGB(ms) {
  if (ms == null) return null;
  return ms > (config.lat_red_ms ?? 600) ? STATUS_RGB.red : ms > (config.lat_amber_ms ?? 250) ? STATUS_RGB.amber : STATUS_RGB.green;
}
function errRGB(pct) {
  if (pct == null) return null;
  return pct >= (config.err_red_pct ?? 2) ? STATUS_RGB.red : pct >= (config.err_amber_pct ?? 0.5) ? STATUS_RGB.amber : STATUS_RGB.green;
}

function drawExternals(ctx, p) {
  for (const x of p.ext || []) {
    nodePos[x.key] = { x: x.x, y: x.y, z: x.z, r: 0.35 };
    const sp = project(x.x, x.y, x.z);
    if (sp.depth < -cam.dist + 1) continue;
    const s = Math.max(6, 0.55 * sp.scale);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(sp.sx, sp.sy - s); ctx.lineTo(sp.sx + s, sp.sy); ctx.lineTo(sp.sx, sp.sy + s); ctx.lineTo(sp.sx - s, sp.sy);
    ctx.closePath();
    ctx.fillStyle = "rgba(16,26,40,0.92)";
    ctx.fill();
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = `hsla(${p.hue}, 35%, 66%, 0.85)`;
    ctx.stroke();
    ctx.font = `bold ${Math.max(7, Math.min(s * 0.62, 12))}px ${FONT}`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = `hsl(${p.hue}, 35%, 74%)`;
    ctx.fillText(EXT_ICON[x.kind] || "EXT", sp.sx, sp.sy + 0.5);
    ctx.font = `bold ${10 * uiScale}px ${FONT}`;
    ctx.textBaseline = "top";
    ctx.shadowColor = "rgba(0,0,0,0.85)"; ctx.shadowBlur = 3;
    ctx.fillStyle = `hsla(${p.hue}, 25%, 72%, 0.8)`;
    ctx.fillText(x.name, sp.sx, sp.sy + s + 3);
    ctx.restore();
  }
}

// which edges to draw: the selected / hovered deployment's own traffic always;
// "problems" adds every slow or failing edge, "all" adds everything (faint)
function edgesToDraw() {
  const sel = selectedKey ? selectedKey.split("#")[0] : null;
  const hov = hoveredKey && !hoveredKey.includes("#") ? hoveredKey : null;
  const picked = new Map();
  if (trafficMode === "problems" || trafficMode === "all") {
    for (const p of layout) for (const e of p.edges || []) {
      if (trafficMode === "all" || e.status === "amber" || e.status === "red") picked.set(e, "bg");
    }
  }
  for (const [k, kind] of [[hov, "hover"], [sel, "focus"]]) {
    if (k) for (const e of trafficIdx.get(k) || []) picked.set(e, kind);
  }
  const rank = { bg: 0, hover: 1, focus: 2 };
  return [...picked].map(([e, kind]) => ({ e, kind })).sort((a, b) => rank[a.kind] - rank[b.kind]);
}

// quadratic arc in world space, lifted above the planes (negative y is up)
function arcPoint(a, b, h, t) {
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, my = Math.min(a.y, b.y) - h, u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * mx + t * t * b.x,
           y: u * u * a.y + 2 * u * t * my + t * t * b.y,
           z: u * u * a.z + 2 * u * t * mz + t * t * b.z };
}

function drawEdge(ctx, { e, kind }, now, withLabel) {
  const a0 = nodePos[e.source], b0 = nodePos[e.target];
  if (!a0 || !b0) return;
  const a = { x: a0.x, y: a0.y - a0.r, z: a0.z }, b = { x: b0.x, y: b0.y - b0.r, z: b0.z };
  const h = 0.8 + Math.hypot(b.x - a.x, b.z - a.z) * 0.22;
  const at = t => { const w = arcPoint(a, b, h, t); return project(w.x, w.y, w.z); };
  const tcp = e.protocol === "tcp";
  const rgb = tcp ? TCP_RGB : trafficRGB(e.status);
  const hot = e.status === "red" || e.status === "amber";
  const alpha = kind === "focus" ? 0.9 : kind === "hover" ? 0.6 : tcp ? 0.12 : e.status === "red" ? 0.7 : e.status === "amber" ? 0.5 : 0.15;
  const width = Math.min(4.5, 0.8 + Math.log10(e.rps + 1) * 1.2) * (kind === "focus" ? 1.15 : kind === "bg" ? 0.8 : 1);

  const pts = [];
  for (let i = 0; i <= 24; i++) pts.push(at(i / 24));
  ctx.save();
  if (tcp) ctx.setLineDash([4, 4]);
  if (kind === "focus" && hot) { ctx.shadowColor = rgba(rgb, 0.6); ctx.shadowBlur = 6; }
  ctx.strokeStyle = rgba(rgb, alpha);
  ctx.lineWidth = width;
  ctx.beginPath();
  pts.forEach((q, i) => i ? ctx.lineTo(q.sx, q.sy) : ctx.moveTo(q.sx, q.sy));
  ctx.stroke();
  ctx.restore();

  // arrowhead near the target shows direction
  const q1 = at(0.86), q2 = at(0.95);
  const ang = Math.atan2(q2.sy - q1.sy, q2.sx - q1.sx), s = 4 + width * 1.2;
  ctx.fillStyle = rgba(rgb, Math.min(1, alpha + 0.1));
  ctx.beginPath();
  ctx.moveTo(q2.sx, q2.sy);
  ctx.lineTo(q2.sx - s * Math.cos(ang - 0.45), q2.sy - s * Math.sin(ang - 0.45));
  ctx.lineTo(q2.sx - s * Math.cos(ang + 0.45), q2.sy - s * Math.sin(ang + 0.45));
  ctx.closePath();
  ctx.fill();

  // moving dots: more and faster on busier edges
  if (kind !== "bg" || hot) {
    const n = Math.max(1, Math.min(5, Math.round(Math.log2(e.rps + 1) / 2)));
    const dur = 2800 - Math.min(1800, e.rps * 4);
    ctx.fillStyle = rgba(mix(rgb, [255, 255, 255], 0.55), Math.min(1, alpha + 0.15));
    for (let k = 0; k < n; k++) {
      const q = at(((now / dur) + k / n) % 1);
      ctx.beginPath(); ctx.arc(q.sx, q.sy, kind === "bg" ? 1.6 : 2.3, 0, Math.PI * 2); ctx.fill();
    }
  }

  if (withLabel) {
    const m = at(0.5);
    const text = tcp ? `TCP ${fmtKbps(e.kbps)}`
      : `${fmtRps(e.rps)} rps · p95 ${fmtMs(e.p95_ms)}` + (e.error_pct >= (config.err_amber_pct ?? 0.5) ? ` · ${e.error_pct.toFixed(1)}% 5xx` : "");
    ctx.save();
    ctx.font = `bold ${10 * uiScale}px ${FONT}`;
    if (!labelFits(m.sx, m.sy - 4, ctx.measureText(text).width, 12 * uiScale)) { ctx.restore(); return; }
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = 4;
    ctx.fillStyle = rgba(mix(rgb, [255, 255, 255], 0.35), 0.95);
    ctx.fillText(text, m.sx, m.sy - 4);
    ctx.restore();
  }
}

function drawTraffic(ctx, now) {
  const items = edgesToDraw();
  // label only the busiest edges of the focused deployment, to keep it readable
  const labelled = new Set(items.filter(i => i.kind === "focus").sort((a, b) => b.e.rps - a.e.rps).slice(0, 8).map(i => i.e));
  labelBoxes = [];
  for (const it of items) drawEdge(ctx, it, now, labelled.has(it.e));
}
let labelBoxes = [];   // screen rects of arc labels placed this frame
function labelFits(x, y, w, h) {
  const box = { x: x - w / 2 - 3, y: y - h - 2, w: w + 6, h: h + 4 };
  if (labelBoxes.some(b => box.x < b.x + b.w && b.x < box.x + box.w && box.y < b.y + b.h && b.y < box.y + box.h)) return false;
  labelBoxes.push(box);
  return true;
}

// ─── plane label: "│cluster-name / N DEPLOYMENTS · g/a/r/u" ─────────────────
function drawLabel(ctx, p) {
  const a = project(p.bx - p.hw * 0.55, p.by - 0.05, p.bz + p.hd * 0.55);
  if (a.depth < -cam.dist + 1) return;
  const f1 = 13 * uiScale, f2 = 10.5 * uiScale;
  const n = p.cl.counts || {};
  const total = (p.cl.deployments || []).length;
  const line2 = p.cl.error
    ? `⚠ ${p.cl.error}`.slice(0, 60)
    : `${total} DEPLOYMENTS · ${n.green || 0}/${n.amber || 0}/${n.red || 0}/${n.unknown || 0}`;

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = 4;
  ctx.fillStyle = `hsla(${p.hue}, 45%, 62%, 0.6)`;
  ctx.fillRect(a.sx, a.sy - f1 - 4, 2, f1 + f2 + 8);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `bold ${f1}px ${FONT}`;
  ctx.fillStyle = `hsl(${p.hue}, 45%, 68%)`;
  ctx.fillText(p.cl.name, a.sx + 8, a.sy);
  ctx.font = `bold ${f2}px ${FONT}`;
  ctx.fillStyle = p.cl.error ? "#c9707e" : `hsla(${p.hue}, 30%, 70%, 0.75)`;
  ctx.fillText(line2, a.sx + 8, a.sy + f2 + 3);
  ctx.restore();
}

// ─── frame ───────────────────────────────────────────────────────────────────
function render(now) {
  if (autoOrbit && !drag.active && Date.now() - lastInteract > IDLE_ORBIT_MS) cam.yaw += 0.0011;
  resize();
  fgCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
  fgCtx.clearRect(0, 0, W, H);
  drawn = [];
  nodePos = {};
  const overlay = [];
  if (podAnim.open) lastInteract = Date.now();   // hold auto-orbit while pods are launched
  stepCamTween(now);

  if (layout.length) {
    // painter's order: farthest plane first, each with its own spheres
    const order = layout
      .map(p => ({ p, d: project(p.bx, p.by, p.bz).depth }))
      .sort((a, b) => b.d - a.d);

    for (const { p } of order) {
      drawPlane(fgCtx, p);
      const items = p.visible.map((dep, i) => {
        const w = cellWorld(p, i);
        const rw = sphereRadius(dep.desired);
        const bob = Math.sin(now / 900 + i * 1.7 + p.ci) * 0.06;
        const sp = project(w.x, p.by - rw - 0.05 + bob, w.z);
        return { dep, key: depKey(dep), sp, floor: project(w.x, p.by, w.z), r: rw * sp.scale,
                 wx: w.x, wy: p.by - rw - 0.05 + bob, wz: w.z, rw, plane: p };
      }).sort((a, b) => b.sp.depth - a.sp.depth);
      for (const it of items) {
        nodePos[it.key] = { x: it.wx, y: it.wy, z: it.wz, r: it.rw };
        if (it.r < 0.8) continue;
        drawSphere(fgCtx, it, now);
        drawn.push(it);
        if (it.dep.status === "red" && (it.dep.pods || []).length) {
          podFocus[it.key] = { x: it.wx, y: it.plane.by - POD_LAUNCH_H * 0.6, z: it.wz };
          const prog = podProgress(it.key, now);
          if (prog > 0) overlay.push({ it, prog });
          else drawPodRing(fgCtx, it, now);
        }
      }
    }
    if (trafficMode !== "off") {
      for (const { p } of order) drawExternals(fgCtx, p);
      drawTraffic(fgCtx, now);
    }
    for (const { p } of order) drawLabel(fgCtx, p);
    for (const { it, prog } of overlay) drawLaunchedPods(fgCtx, it, prog, now);
  }

  updateTooltip();
  requestAnimationFrame(render);
}

function resize() {
  const wrap = document.getElementById("canvas-wrap");
  const nw = wrap.clientWidth, nh = wrap.clientHeight, dpr = window.devicePixelRatio || 1;
  if (nw !== W || nh !== H || dpr !== DPR) {
    W = nw; H = nh; DPR = dpr;
    for (const cv of [bgCanvas, fgCanvas]) { cv.width = W * DPR; cv.height = H * DPR; }
    bgCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    drawBackground();
  }
}

// ─── picking / hover tooltip ─────────────────────────────────────────────────
function pick(mx, my) {
  for (let i = drawn.length - 1; i >= 0; i--) {
    const { sp, r } = drawn[i];
    const dx = mx - sp.sx, dy = my - sp.sy;
    if (dx * dx + dy * dy <= (r * 1.15) ** 2) return drawn[i];
  }
  return null;
}

function findDep(key) {
  const [dk, podName] = String(key).split("#");
  for (const cl of snapshot?.clusters || []) {
    for (const d of cl.deployments || []) {
      if (depKey(d) !== dk) continue;
      const pod = podName ? (d.pods || []).find(p => p.name === podName) : null;
      if (podName && !pod) return null;
      return { cl, dep: d, pod };
    }
  }
  return null;
}

function fmtPct(v) { return v != null ? v.toFixed(1) + "%" : "N/A"; }

function updateTooltip() {
  if (!mouse.inside || drag.active) { tooltip.classList.add("hidden"); return; }
  const hit = pick(mouse.x, mouse.y);
  hoveredKey = hit ? hit.key : null;
  fgCanvas.style.cursor = hit ? "pointer" : (drag.active ? "grabbing" : "grab");
  if (!hit) { tooltip.classList.add("hidden"); return; }
  const d = hit.dep;
  if (hit.kind === "pod") {
    const pd = hit.pod;
    const cc = rgba(STATUS_RGB[statusOf(pd.cpu_pct)], 1), mc = rgba(STATUS_RGB[statusOf(pd.mem_pct)], 1);
    tooltip.innerHTML =
      `<div class="tt-name">${esc(pd.name)}</div>` +
      `<div class="tt-cluster">${esc(d.namespace)} / ${esc(d.name)} · ${esc(pd.phase || "—")}</div>` +
      `<div class="tt-meta">CPU <span style="color:${cc}">${fmtPct(pd.cpu_pct)}</span> · MEM <span style="color:${mc}">${fmtPct(pd.mem_pct)}</span> · RESTARTS ${pd.restarts || 0}</div>`;
  } else {
    const cpu = d.avg_cpu != null ? d.avg_cpu.toFixed(1) + "%" : "N/A";
    const col = rgba(STATUS_RGB[d.status] || STATUS_RGB.unknown, 1);
    tooltip.innerHTML =
      `<div class="tt-name">${esc(d.namespace)} / ${esc(d.name)}</div>` +
      `<div class="tt-cluster">${esc(d.cluster)}</div>` +
      `<div class="tt-meta">AVG CPU <span style="color:${col}">${cpu}</span> · ${d.ready}/${d.desired} READY` +
      (d.status === "red" && (d.pods || []).length ? ` · <span style="color:${col}">click to launch pods</span>` : "") + `</div>` +
      trafficTooltip(d.traffic);
  }
  tooltip.classList.remove("hidden");
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  let x = mouse.x + 16, y = mouse.y + 18;
  if (x + tw > W - 8) x = mouse.x - tw - 12;
  if (y + th > H - 8) y = mouse.y - th - 12;
  tooltip.style.left = x + "px";
  tooltip.style.top  = y + "px";
}

function trafficTooltip(t) {
  if (!t || trafficMode === "off" || !(t.in_rps || t.out_rps)) return "";
  if (t.p95_ms == null) return `<div class="tt-meta">MESH OUT ${fmtRps(t.out_rps)} rps</div>`;
  const lc = rgba(latRGB(t.p95_ms), 1), ec = rgba(errRGB(t.error_pct) || STATUS_RGB.green, 1);
  return `<div class="tt-meta">MESH IN ${fmtRps(t.in_rps)} rps · p95 <span style="color:${lc}">${fmtMs(t.p95_ms)}</span>` +
         ` · <span style="color:${ec}">${t.error_pct.toFixed(2)}% 5xx</span></div>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ─── mouse ───────────────────────────────────────────────────────────────────
fgCanvas.addEventListener("mousedown", e => {
  camTween = null;
  drag = { active: true, shift: e.shiftKey, sx: e.clientX, sy: e.clientY,
           yaw0: cam.yaw, pitch0: cam.pitch, tx0: cam.tx, ty0: cam.ty };
  lastInteract = Date.now();
});

fgCanvas.addEventListener("mouseleave", () => { mouse.inside = false; });

window.addEventListener("mousemove", e => {
  const rect = fgCanvas.getBoundingClientRect();
  mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top,
            inside: e.target === fgCanvas };
  if (!drag.active) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (drag.shift) {
    const k = Math.min(W, H) * FOV_K / cam.dist;
    cam.tx = drag.tx0 + dx / k;
    cam.ty = drag.ty0 + dy / k;
  } else {
    cam.yaw   = drag.yaw0 + dx * 0.006;
    cam.pitch = Math.max(0.05, Math.min(1.35, drag.pitch0 + dy * 0.006));
  }
  lastInteract = Date.now();
});

window.addEventListener("mouseup", e => {
  if (!drag.active) return;
  const moved = Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy);
  drag.active = false;
  if (moved < 5 && e.target === fgCanvas) {
    const rect = fgCanvas.getBoundingClientRect();
    const hit = pick(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) { collapsePods(); return; }
    // open the card first so the camera fly-in can leave room for it
    selectedKey = hit.key;
    showDetail();
    if (hit.kind === "pod") {
      if (!(podAnim.open && podAnim.key === hit.depItemKey)) launchPods(hit.depItemKey, podFocus[hit.depItemKey]);
    } else if (hit.dep.status === "red" && (hit.dep.pods || []).length) {
      if (podAnim.open && podAnim.key === hit.key) collapsePods();
      else launchPods(hit.key, podFocus[hit.key]);
    } else if (trafficMode !== "off" && (trafficIdx.get(hit.key) || []).length) {
      collapsePods();
      const pos = nodePos[hit.key];   // bring its callers and callees into view
      if (pos) flyTo(pos.x, pos.y - 2, pos.z, Math.min(cam.dist, Math.max(26, layout.radius * 1.0)));
    }
  }
});

fgCanvas.addEventListener("wheel", e => {
  e.preventDefault();
  cam.dist = Math.max(10, Math.min(600, cam.dist * (e.deltaY > 0 ? 1.07 : 0.93)));
  lastInteract = Date.now();
}, { passive: false });

// ─── detail card ─────────────────────────────────────────────────────────────
function showDetail() {
  const found = selectedKey && findDep(selectedKey);
  const panel = document.getElementById("detail");
  if (!found) { panel.classList.add("hidden"); return; }
  const { cl, dep, pod } = found;
  if (pod) { showPodDetail(cl, dep, pod); panel.classList.remove("hidden"); return; }
  const col = rgba(STATUS_RGB[dep.status] || STATUS_RGB.unknown, 1);
  const cpuText = dep.avg_cpu != null ? dep.avg_cpu.toFixed(1) + "%" : "N/A";
  const pods = dep.pods || [];
  const withMetrics = pods.filter(p => p.cpu_pct != null).length;
  const stateCol = { ok: STATUS_RGB.green, degraded: STATUS_RGB.amber, down: STATUS_RGB.red }[dep.replica_state] || STATUS_RGB.unknown;

  const rows = pods.map(p => {
    const rs = p.restarts || 0;
    const rc = rs >= 5 ? rgba(STATUS_RGB.red, 1) : rs > 0 ? rgba(STATUS_RGB.amber, 1) : "inherit";
    return `<tr class="pod-row" data-pod="${esc(p.name)}">
      <td class="pod" title="${esc(p.name)}">${esc(p.name)}</td>
      <td>${esc(p.phase || "—")}</td>
      <td class="num">${p.usage_m != null ? p.usage_m.toFixed(1) : "—"}</td>
      <td class="num">${p.basis_m != null ? Math.round(p.basis_m) : "—"}</td>
      <td>${meterCell(p.cpu_pct)}</td>
      <td>${meterCell(p.mem_pct)}</td>
      <td class="num" style="color:${rc}">${rs}</td>
    </tr>`;
  }).join("");

  document.getElementById("detail-content").innerHTML = `
    <div class="detail-title">${esc(cl.name)} &rsaquo; ${esc(dep.namespace)} / ${esc(dep.name)}</div>
    <div class="detail-grid">
      <div class="detail-label">AVG CPU</div>
      <div class="detail-cpu" style="color:${col}">${cpuText}</div>
      <div class="detail-label">REPLICAS</div>
      <div class="detail-val">${dep.ready} / ${dep.desired} ready<span class="state-dot" style="background:${rgba(stateCol, 1)}"></span><span style="color:${rgba(stateCol, 1)}">${esc(dep.replica_state.toUpperCase())}</span></div>
      <div class="detail-label">PODS W/ METRICS</div>
      <div class="detail-val">${withMetrics} / ${pods.length}</div>
    </div>
    ${trafficSection(dep)}
    <div class="detail-label section-label">PODS (${pods.length})</div>
    <table class="detail-table">
      <thead><tr><th>POD</th><th>PHASE</th><th class="num">USE m</th><th class="num">REQ m</th><th>CPU</th><th>MEM</th><th class="num">RESTARTS</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  panel.classList.remove("hidden");
}

// ─── detail card: mesh traffic ───────────────────────────────────────────────
function trafficSection(dep) {
  const t = dep.traffic, key = depKey(dep);
  const edges = trafficIdx.get(key) || [];
  if (!t || !edges.length) return "";
  const byRate = (a, b) => (b.protocol === "tcp" ? b.kbps / 50 : b.rps) - (a.protocol === "tcp" ? a.kbps / 50 : a.rps);
  const inbound = edges.filter(e => e.target === key).sort(byRate);
  const outbound = edges.filter(e => e.source === key).sort(byRate);
  const lc = t.p95_ms != null ? rgba(latRGB(t.p95_ms), 1) : "inherit";
  const ec = errRGB(t.error_pct);
  const lat = t.p95_ms != null
    ? `${fmtMs(t.p50_ms)} / <span style="color:${lc}">${fmtMs(t.p95_ms)}</span> / ${fmtMs(t.p99_ms)}`
    : `<span class="detail-note">no inbound requests</span>`;
  return `<div class="detail-label section-label">MESH TRAFFIC</div>
    <div class="detail-grid traffic-grid">
      <div class="detail-label">INBOUND</div><div class="detail-val">${fmtRps(t.in_rps)} req/s</div>
      <div class="detail-label">P50 / P95 / P99</div><div class="detail-val">${lat}</div>
      <div class="detail-label">5xx ERRORS</div>
      <div class="detail-val" style="color:${ec ? rgba(ec, 1) : "inherit"}">${t.error_pct != null ? t.error_pct.toFixed(2) + "%" : "—"}</div>
      <div class="detail-label">OUTBOUND</div><div class="detail-val">${fmtRps(t.out_rps)} req/s</div>
    </div>
    ${peerTable("CALLED BY", "CALLER", inbound, "source")}
    ${peerTable("CALLS", "DESTINATION", outbound, "target")}`;
}

function peerTable(title, col, edges, end) {
  if (!edges.length) return "";
  const rows = edges.slice(0, 12).map(e => {
    const peer = e[end], ext = peer.includes("|ext:");
    const name = ext ? `${peer.split("|ext:")[1]} (external)` : peer.split("/").slice(1).join(" / ");
    const tcp = e.protocol === "tcp";
    const lc = tcp ? rgba(TCP_RGB, 1) : rgba(latRGB(e.p95_ms), 1);
    const ec = errRGB(e.error_pct);
    return `<tr class="${ext ? "" : "peer-row"}" data-key="${esc(peer)}">
      <td class="pod" title="${esc(name)}">${esc(name)}</td>
      <td>${esc(e.protocol.toUpperCase())}</td>
      <td class="num">${tcp ? fmtKbps(e.kbps) : fmtRps(e.rps) + " rps"}</td>
      <td class="num" style="color:${lc}">${tcp ? "—" : fmtMs(e.p95_ms)}</td>
      <td class="num" style="color:${ec ? rgba(ec, 1) : "inherit"}">${e.error_pct != null ? e.error_pct.toFixed(2) + "%" : "—"}</td>
    </tr>`;
  }).join("");
  const more = edges.length > 12 ? ` · top 12 of ${edges.length}` : "";
  return `<div class="detail-label section-label">${title} (${edges.length}${more})</div>
    <table class="detail-table traffic-table">
      <thead><tr><th>${col}</th><th>PROTO</th><th class="num">RATE</th><th class="num">P95</th><th class="num">5xx</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// clicking a caller / destination row jumps to that deployment
document.getElementById("detail-content").addEventListener("click", e => {
  const row = e.target.closest(".peer-row");
  if (!row) return;
  const key = row.dataset.key;
  if (!findDep(key)) return;
  collapsePods();
  selectedKey = key;
  showDetail();
  const pos = nodePos[key];
  if (pos) flyTo(pos.x, pos.y, pos.z, cam.dist);
});

function meterCell(pct) {
  const c = rgba(STATUS_RGB[statusOf(pct)], 1);
  const w = pct != null ? Math.min(100, pct) : 0;
  return `<span class="meter"><span style="width:${w}%;background:${c}"></span></span><span style="color:${c}">${pct != null ? pct.toFixed(1) + "%" : "—"}</span>`;
}

function containerTable(containers) {
  if (!containers.length) return "";
  const fmt = (v, d = 1) => v != null ? Number(v).toFixed(d) : "—";
  const rows = containers.map(c => {
    const rs = c.restarts || 0;
    const rc = rs >= 5 ? rgba(STATUS_RGB.red, 1) : rs > 0 ? rgba(STATUS_RGB.amber, 1) : "inherit";
    const sc = c.state === "Running" ? (c.ready === false ? STATUS_RGB.amber : STATUS_RGB.green)
             : c.state ? STATUS_RGB.red : STATUS_RGB.unknown;
    return `<tr>
      <td class="pod" title="${esc(c.name)}"><span class="state-dot" style="margin-left:0;background:${rgba(sc, 1)}"></span>${esc(c.name)}
        <div class="detail-note">${esc(c.state || "—")}${c.ready === false && c.state === "Running" ? " · not ready" : ""}</div></td>
      <td>${meterCell(c.cpu_pct)}<div class="detail-note">${fmt(c.usage_m)} / ${fmt(c.basis_m, 0)} m</div></td>
      <td>${meterCell(c.mem_pct)}<div class="detail-note">${fmt(c.mem_usage_mi)} / ${fmt(c.mem_basis_mi, 0)} Mi</div></td>
      <td class="num" style="color:${rc}">${rs}</td>
    </tr>`;
  }).join("");
  return `<div class="detail-label section-label">CONTAINERS (${containers.length})</div>
    <table class="detail-table container-table">
      <thead><tr><th>CONTAINER</th><th>CPU</th><th>MEMORY</th><th class="num">RESTARTS</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function showPodDetail(cl, dep, pod) {
  const cc = rgba(STATUS_RGB[statusOf(pod.cpu_pct)], 1);
  const mc = rgba(STATUS_RGB[statusOf(pod.mem_pct)], 1);
  const rs = pod.restarts || 0;
  const rc = rs >= 5 ? rgba(STATUS_RGB.red, 1) : rs > 0 ? rgba(STATUS_RGB.amber, 1) : rgba(STATUS_RGB.green, 1);
  const fmt = (v, d = 1) => v != null ? Number(v).toFixed(d) : "—";
  document.getElementById("detail-content").innerHTML = `
    <div class="detail-title">${esc(cl.name)} &rsaquo; ${esc(dep.namespace)} / ${esc(dep.name)}</div>
    <div class="detail-sub-title">POD ${esc(pod.name)}</div>
    <div class="detail-grid">
      <div class="detail-label">CPU</div>
      <div><span class="detail-cpu" style="color:${cc}">${fmtPct(pod.cpu_pct)}</span>
        <div class="detail-note">${fmt(pod.usage_m)}m used of ${fmt(pod.basis_m, 0)}m requested</div></div>
      <div class="detail-label">MEMORY</div>
      <div><span class="detail-cpu" style="color:${mc}">${fmtPct(pod.mem_pct)}</span>
        <div class="detail-note">${fmt(pod.mem_usage_mi)} Mi used of ${fmt(pod.mem_basis_mi, 0)} Mi requested</div></div>
      <div class="detail-label">RESTARTS</div>
      <div class="detail-cpu" style="color:${rc}">${rs}</div>
      <div class="detail-label">PHASE</div>
      <div class="detail-val">${esc(pod.phase || "—")}</div>
      <div class="detail-label">NODE</div>
      <div class="detail-val">${esc(pod.node || "—")}</div>
    </div>
    ${containerTable(pod.containers || [])}
    <button class="ctl-btn back-btn" id="detail-back">&lsaquo; ALL PODS OF ${esc(dep.name)}</button>`;
  document.getElementById("detail-back").addEventListener("click", () => {
    selectedKey = depKey(dep);
    showDetail();
  });
}

// clicking a pod row in the deployment card opens that pod
document.getElementById("detail-content").addEventListener("click", e => {
  const row = e.target.closest(".pod-row");
  if (!row || !selectedKey || selectedKey.includes("#")) return;
  const found = findDep(selectedKey);
  if (!found) return;
  if (found.dep.status === "red" && !(podAnim.open && podAnim.key === selectedKey)) launchPods(selectedKey, podFocus[selectedKey]);
  selectedKey = `${selectedKey}#${row.dataset.pod}`;
  showDetail();
});

document.getElementById("detail-close").addEventListener("click", () => {
  document.getElementById("detail").classList.add("hidden");
  selectedKey = null;
  collapsePods();
});

// ─── footer ──────────────────────────────────────────────────────────────────
function updateFooter() {
  if (!snapshot) return;
  let g = 0, a = 0, r = 0, u = 0, total = 0;
  snapshot.clusters.forEach(cl => (cl.deployments || []).forEach(d => {
    total++;
    if (d.status === "green") g++; else if (d.status === "amber") a++;
    else if (d.status === "red") r++; else u++;
  }));
  document.getElementById("footer-totals").innerHTML =
    `<span class="green">${g}&#9679;</span> <span class="amber">${a}&#9679;</span> <span class="red">${r}&#9679;</span> <span class="unknown">${u}&#9679;</span> of ${total} deployments`;
  document.getElementById("footer-mode").textContent = `mode: ${snapshot.mode}`;
  if (snapshot.updated) {
    document.getElementById("footer-updated").textContent =
      `updated: ${new Date(snapshot.updated * 1000).toLocaleTimeString()}`;
  }
}

// ─── namespace panel ─────────────────────────────────────────────────────────
const nsInner = document.getElementById("ns-panel-inner");
let allNs = {};

function buildNsPanel() {
  if (!snapshot) return;
  allNs = {};
  snapshot.clusters.forEach(cl => (cl.deployments || []).forEach(d => {
    (allNs[cl.name] ||= new Set()).add(d.namespace);
  }));
  nsInner.innerHTML = "";
  for (const [cname, nsSet] of Object.entries(allNs)) {
    const title = document.createElement("div");
    title.className = "ns-cluster-title";
    title.textContent = cname;
    nsInner.appendChild(title);
    const ctrl = document.createElement("div");
    ctrl.className = "ns-ctrl-row";
    ctrl.innerHTML = `<button class="ctl-btn" data-c="${esc(cname)}" data-a="all">ALL</button>
                      <button class="ctl-btn" data-c="${esc(cname)}" data-a="none">NONE</button>`;
    nsInner.appendChild(ctrl);
    for (const ns of [...nsSet].sort()) {
      const sel = nsSel[cname];
      const row = document.createElement("label");
      row.className = "ns-row";
      row.innerHTML = `<input type="checkbox" data-c="${esc(cname)}" data-ns="${esc(ns)}" ${!Array.isArray(sel) || sel.includes(ns) ? "checked" : ""}> ${esc(ns)}`;
      nsInner.appendChild(row);
    }
  }
}

nsInner.addEventListener("change", e => {
  const cb = e.target;
  if (!cb.dataset.ns) return;
  const c = cb.dataset.c;
  if (!Array.isArray(nsSel[c])) nsSel[c] = [...(allNs[c] || [])];
  nsSel[c] = cb.checked ? [...new Set([...nsSel[c], cb.dataset.ns])] : nsSel[c].filter(n => n !== cb.dataset.ns);
  if (allNs[c] && nsSel[c].length === allNs[c].size) nsSel[c] = null;
  nsChanged();
});

nsInner.addEventListener("click", e => {
  const btn = e.target.closest("[data-a]");
  if (!btn) return;
  nsSel[btn.dataset.c] = btn.dataset.a === "all" ? null : [];
  buildNsPanel();
  nsChanged();
});

function nsChanged() {
  saveLS("nsSel", JSON.stringify(nsSel));
  updateNsBadge();
  buildLayout();
}

function updateNsBadge() {
  const custom = Object.values(nsSel).some(v => Array.isArray(v));
  document.getElementById("ns-badge").textContent = custom ? "CUSTOM" : "ALL";
}

// ─── camera fit ──────────────────────────────────────────────────────────────
function fitCamera() {
  const R = layout.radius || 20;
  homeCam = { yaw: -0.55, pitch: 0.55, dist: Math.max(40, R * 2.6), tx: 0, ty: 0 };
  cam = { ...homeCam };
}

// ─── API polling ─────────────────────────────────────────────────────────────
async function fetchSnapshot() {
  try {
    const data = await (await fetch("/api/snapshot")).json();
    if (data.ready) {
      const first = snapshot === null;
      snapshot = data;
      buildLayout();
      if (first) fitCamera();
      const errs = (data.clusters || []).filter(c => c.error);
      const banner = document.getElementById("error-banner");
      banner.textContent = errs.length ? "⚠ " + errs.map(c => c.name + ": " + c.error).join(" | ") : "";
      banner.classList.toggle("hidden", !errs.length);
      if (!document.getElementById("detail").classList.contains("hidden")) showDetail();
    }
    updateFooter();
    if (document.getElementById("ns-panel").classList.contains("hidden")) buildNsPanel();
    updateNsBadge();
    document.getElementById("sim-tag").classList.toggle("hidden", data.mode !== "demo");
  } catch (e) {
    console.error("snapshot fetch error", e);
  }
}

async function fetchConfig() {
  try {
    config = await (await fetch("/api/config")).json();
    document.getElementById("leg-amber").textContent  = config.amber;
    document.getElementById("leg-amber2").textContent = config.amber;
    document.getElementById("leg-red").textContent    = config.red;
    document.getElementById("leg-red2").textContent   = config.red;
    document.getElementById("leg-lat-amber").textContent = config.lat_amber_ms ?? 250;
    document.getElementById("leg-lat-red").textContent   = config.lat_red_ms ?? 600;
  } catch (e) {}
}

// ─── controls ────────────────────────────────────────────────────────────────
document.getElementById("chk-alerts").addEventListener("change", e => {
  alertsOnly = e.target.checked;
  buildLayout();
});

function setTrafficMode(mode) {
  trafficMode = mode;
  saveLS("trafficMode", mode);
  document.getElementById("traffic-mode").textContent = mode.toUpperCase();
  document.getElementById("btn-traffic").classList.toggle("on", mode !== "off");
  document.getElementById("leg-traffic").classList.toggle("hidden", mode === "off");
  if (!document.getElementById("detail").classList.contains("hidden")) showDetail();
}
const nextTrafficMode = () => setTrafficMode(TRAFFIC_MODES[(TRAFFIC_MODES.indexOf(trafficMode) + 1) % TRAFFIC_MODES.length]);
document.getElementById("btn-traffic").addEventListener("click", nextTrafficMode);
window.addEventListener("keydown", e => {
  if ((e.key === "t" || e.key === "T") && !e.ctrlKey && !e.metaKey && !e.altKey
      && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) nextTrafficMode();
});
setTrafficMode(trafficMode);

document.getElementById("chk-orbit").addEventListener("change", e => {
  autoOrbit = e.target.checked;
  lastInteract = 0;
});

document.getElementById("btn-refresh").addEventListener("click", async () => {
  await fetch("/api/refresh", { method: "POST" });
  await fetchSnapshot();
});

document.getElementById("btn-home").addEventListener("click", () => { camTween = null; collapsePods(); cam = { ...homeCam }; });

document.getElementById("btn-ns").addEventListener("click", () => {
  const panel = document.getElementById("ns-panel");
  if (panel.classList.contains("hidden")) buildNsPanel();
  panel.classList.toggle("hidden");
});

document.getElementById("search").addEventListener("input", e => {
  searchTerm = e.target.value.trim();
  buildLayout();
});

function setScale(v) {
  uiScale = Math.round(Math.max(0.7, Math.min(1.6, v)) * 10) / 10;
  document.documentElement.style.setProperty("--ui-scale", uiScale);
  saveLS("uiScale", uiScale);
}
document.getElementById("btn-scale-down").addEventListener("click", () => setScale(uiScale - 0.1));
document.getElementById("btn-scale-up").addEventListener("click", () => setScale(uiScale + 0.1));
setScale(uiScale);

// ─── init ────────────────────────────────────────────────────────────────────
(async () => {
  await fetchConfig();
  await fetchSnapshot();
  setInterval(fetchSnapshot, Math.max(3, config.refresh || 15) * 1000);
  requestAnimationFrame(render);
})();
