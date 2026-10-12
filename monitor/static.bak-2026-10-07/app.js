// app.js – Cluster Monitor 3D HUD (Canvas 2D, no dependencies)
"use strict";

// ─── constants ──────────────────────────────────────────────────────────────
const C_BG      = "#0f172a";
const C_GRID    = "#1e293b";
const C_CYAN    = "#38bdf8";
const C_GREEN   = "#10b981";
const C_AMBER   = "#f59e0b";
const C_RED     = "#ef4444";
const C_UNKNOWN = "#64748b";

// Nord / Cold Ice palette for clusters
const CLUSTER_HUES = [199, 217, 187, 262, 172, 38, 340];
const PLANE_GAP_Y = 6.5;   // Vertical separation
const PLANE_STAGGER_X = 3.5; // Step-wise shift X
const PLANE_STAGGER_Z = -4.0; // Step-wise shift Z
const CELL_SIZE = 2.4, R0 = 0.50;
const REFRESH_POLL = 5000;

// ─── state ───────────────────────────────────────────────────────────────────
let snapshot = null;
let config   = { amber: 60, red: 90, refresh: 15, demo: false };
let searchTerm = "";
let alertsOnly = false;
let autoOrbit  = false;
let nsSel      = JSON.parse(localStorage.getItem("nsSel") || "null") || {};
let uiScale    = parseFloat(localStorage.getItem("uiScale") || "1");

// camera
let cam = { yaw: -0.4, pitch: 0.38, dist: 32, tx: 0, ty: 0 };
let drag = { active: false, shift: false, sx: 0, sy: 0, yaw0: 0, pitch0: 0, tx0: 0, ty0: 0 };
let lastInteract = 0;
let orbitTimer = 0;

// hover / selection
let hovered = null;  // {ci, di}
let selected = null; // {ci, di}

// canvas
const bgCanvas = document.getElementById("canvas-bg");
const fgCanvas = document.getElementById("canvas-fg");
const bgCtx    = bgCanvas.getContext("2d");
const fgCtx    = fgCanvas.getContext("2d");

let W = 0, H = 0;
let t = 0;  // frame counter

// ─── geometry helpers ────────────────────────────────────────────────────────
function project(x, y, z) {
  const cosY = Math.cos(cam.yaw),   sinY = Math.sin(cam.yaw);
  const cosP = Math.cos(cam.pitch), sinP = Math.sin(cam.pitch);
  const rx = x * cosY - z * sinY;
  const rz = x * sinY + z * cosY;
  const ry2 = y * cosP - rz * sinP;
  const rz2 = y * sinP + rz * cosP;
  const fov = Math.min(W, H) * 0.9;
  const scale = fov / (rz2 + cam.dist);
  return {
    sx: W / 2 + (rx + cam.tx) * scale,
    sy: H / 2 + (ry2 + cam.ty) * scale,
    scale,
    depth: rz2
  };
}

function gridDims(count) {
  const cols = Math.max(3, Math.ceil(Math.sqrt(count * 1.3)));
  const rows = Math.max(2, Math.ceil(count / cols));
  return { cols, rows };
}

function clusterBasePos(clusterIdx) {
  const total = snapshot?.clusters?.length || 1;
  const offsetIdx = clusterIdx - (total - 1) / 2;
  return {
    bx: offsetIdx * PLANE_STAGGER_X,
    by: -clusterIdx * PLANE_GAP_Y,
    bz: clusterIdx * PLANE_STAGGER_Z,
  };
}

function cellPos(idx, cols, rows, clusterIdx) {
  const col = idx % cols;
  const row = Math.floor(idx / cols);
  const base = clusterBasePos(clusterIdx);
  return {
    cx: base.bx + (col - (cols - 1) / 2) * CELL_SIZE,
    cy: base.by,
    cz: base.bz + (row - (rows - 1) / 2) * CELL_SIZE,
  };
}

// Sphere screen position for a deployment
function sphereScreen(dep, clusterIdx, deployments) {
  const visibleDeps = filterDeps(deployments);
  const di = visibleDeps.indexOf(dep);
  if (di < 0) return null;
  const { cols, rows } = gridDims(visibleDeps.length);
  const pos = cellPos(di, cols, rows, clusterIdx);
  const bob = Math.sin(t / 800 + di * 1.5 + clusterIdx) * 0.15;
  return project(pos.cx, pos.cy - 1.2 + bob, pos.cz);
}

function sphereRadius(desired) {
  return R0 * (0.8 + Math.min(desired, 12) * 0.045);
}

function statusColor(status) {
  if (status === "green")   return C_GREEN;
  if (status === "amber")   return C_AMBER;
  if (status === "red")     return C_RED;
  return C_UNKNOWN;
}

// ─── filtering ────────────────────────────────────────────────────────────────
function filterDeps(deps) {
  if (!deps) return [];
  return deps.filter(d => {
    if (alertsOnly && d.status !== "red" && d.status !== "amber") return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      if (!d.name.toLowerCase().includes(q) && !d.namespace.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

// ─── draw grid plane ─────────────────────────────────────────────────────────
function drawGrid(ctx, clusterIdx, count) {
  const base = clusterBasePos(clusterIdx);
  const { cols, rows } = gridDims(Math.max(count, 1));
  const hw = (cols * CELL_SIZE) / 2 + CELL_SIZE * 0.4;
  const hd = (rows * CELL_SIZE) / 2 + CELL_SIZE * 0.4;
  const hue = CLUSTER_HUES[clusterIdx % CLUSTER_HUES.length];

  // 1. Draw solid dark glass floor slab so lower/upper objects don't bleed through
  const pTL = project(base.bx - hw, base.by, base.bz - hd);
  const pTR = project(base.bx + hw, base.by, base.bz - hd);
  const pBR = project(base.bx + hw, base.by, base.bz + hd);
  const pBL = project(base.bx - hw, base.by, base.bz + hd);

  ctx.beginPath();
  ctx.moveTo(pTL.sx, pTL.sy);
  ctx.lineTo(pTR.sx, pTR.sy);
  ctx.lineTo(pBR.sx, pBR.sy);
  ctx.lineTo(pBL.sx, pBL.sy);
  ctx.closePath();

  // Glassy sci-fi dark floor fill
  ctx.fillStyle = `hsla(${hue}, 40%, 6%, 0.88)`;
  ctx.fill();

  // Glowing floor border edge
  ctx.strokeStyle = `hsla(${hue}, 90%, 55%, 0.8)`;
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // Corner tech markers
  const drawCorner = (p) => {
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, 3, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${hue}, 100%, 65%)`;
    ctx.fill();
  };
  drawCorner(pTL); drawCorner(pTR); drawCorner(pBR); drawCorner(pBL);

  // 2. Interior Grid Lines
  ctx.strokeStyle = `hsla(${hue}, 70%, 45%, 0.25)`;
  ctx.lineWidth = 0.6;

  for (let ix = -cols; ix <= cols; ix++) {
    const x = base.bx + ix * CELL_SIZE * 0.5;
    if (Math.abs(x - base.bx) > hw) continue;
    const p0 = project(x, base.by, base.bz - hd);
    const p1 = project(x, base.by, base.bz + hd);
    ctx.beginPath();
    ctx.moveTo(p0.sx, p0.sy);
    ctx.lineTo(p1.sx, p1.sy);
    ctx.stroke();
  }
  for (let iz = -rows; iz <= rows; iz++) {
    const z = base.bz + iz * CELL_SIZE * 0.5;
    if (Math.abs(z - base.bz) > hd) continue;
    const p0 = project(base.bx - hw, base.by, z);
    const p1 = project(base.bx + hw, base.by, z);
    ctx.beginPath();
    ctx.moveTo(p0.sx, p0.sy);
    ctx.lineTo(p1.sx, p1.sy);
    ctx.stroke();
  }

  // 3. Sci-Fi Cluster Name Tag / Floating Banner
  const labelP = project(base.bx - hw, base.by - 0.2, base.bz + hd + 0.3);
  if (labelP.depth > -cam.dist * 0.9) {
    const fontSize = Math.min(14, Math.max(9, labelP.scale * 4.5));
    const cname = clusterSnap(clusterIdx)?.name || `CLUSTER-${clusterIdx + 1}`;
    const label = (cname.length > 28 ? cname.slice(0, 28) + "…" : cname).toUpperCase();

    // Badge background
    ctx.font = `bold ${fontSize}px "Courier New", monospace`;
    const textWidth = ctx.measureText(label).width;
    
    ctx.fillStyle = `hsla(${hue}, 80%, 12%, 0.9)`;
    ctx.strokeStyle = `hsl(${hue}, 90%, 60%)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(labelP.sx - 4, labelP.sy - fontSize, textWidth + 12, fontSize + 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = `hsl(${hue}, 90%, 75%)`;
    ctx.fillText(label, labelP.sx + 2, labelP.sy - 1);
  }
}

function clusterSnap(idx) {
  return snapshot?.clusters?.[idx] || null;
}

// ─── draw sphere ──────────────────────────────────────────────────────────────
function drawSphere(ctx, dep, ci, di, sp) {
  if (!sp) return;
  const r = sphereRadius(dep.desired) * sp.scale;
  if (r < 1) return;

  const col  = statusColor(dep.status);
  const hue  = CLUSTER_HUES[ci % CLUSTER_HUES.length];
  const isRed = dep.status === "red";
  const pulse = isRed ? (0.55 + 0.45 * Math.sin(t / 180)) : 1;

  // translucent shell
  ctx.beginPath();
  ctx.arc(sp.sx, sp.sy, r * 1.18, 0, Math.PI * 2);
  ctx.fillStyle = `hsla(${hue},60%,40%,${0.18 * pulse})`;
  ctx.fill();

  // glow for red
  if (isRed) {
    const glow = ctx.createRadialGradient(sp.sx, sp.sy, r * 0.2, sp.sx, sp.sy, r * 2.5);
    glow.addColorStop(0, `rgba(255,59,92,${0.3 * pulse})`);
    glow.addColorStop(1, "rgba(255,59,92,0)");
    ctx.beginPath();
    ctx.arc(sp.sx, sp.sy, r * 2.5, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();
  }

  // radial core gradient
  const grad = ctx.createRadialGradient(sp.sx - r * 0.3, sp.sy - r * 0.3, r * 0.05,
                                         sp.sx, sp.sy, r);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.25, col);
  grad.addColorStop(1, `rgba(0,0,0,0.5)`);
  ctx.beginPath();
  ctx.arc(sp.sx, sp.sy, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // hover highlight
  if (hovered && hovered.ci === ci && hovered.di === di) {
    ctx.beginPath();
    ctx.arc(sp.sx, sp.sy, r + 3, 0, Math.PI * 2);
    ctx.strokeStyle = C_CYAN;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // floor ring for replica_state
  if (dep.replica_state === "degraded" || dep.replica_state === "down") {
    const rc = dep.replica_state === "down" ? C_RED : C_AMBER;
    const ry = project(0, clusterY(ci), 0);
    ctx.beginPath();
    ctx.ellipse(sp.sx, sp.sy + r * 0.9, r * 0.7, r * 0.2, 0, 0, Math.PI * 2);
    ctx.strokeStyle = rc;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // percentage text – clamped font size, never larger than sphere
  if (r > 10 && dep.avg_cpu != null) {
    const fs = Math.min(r * 0.5, 14);
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${fs}px Courier New`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(dep.avg_cpu.toFixed(0) + "%", sp.sx, sp.sy);
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

// ─── collect all sphere screen positions for picking ─────────────────────────
function allSpheres() {
  if (!snapshot) return [];
  const out = [];
  snapshot.clusters.forEach((cl, ci) => {
    const deps = filterDeps(cl.deployments);
    deps.forEach((dep, di) => {
      const sp = sphereScreen(dep, ci, cl.deployments);
      if (sp) out.push({ ci, di: cl.deployments.indexOf(dep), sp, dep });
    });
  });
  // Sort far → near (depth descending)
  out.sort((a, b) => b.sp.depth - a.sp.depth);
  return out;
}

// ─── render loop ─────────────────────────────────────────────────────────────
function render() {
  t++;

  if (autoOrbit) {
    const idle = Date.now() - lastInteract;
    if (idle > 4000) {
      cam.yaw += 0.0012;
    }
  }

  resize();

  // bg: grids
  bgCtx.clearRect(0, 0, W, H);
  bgCtx.fillStyle = C_BG;
  bgCtx.fillRect(0, 0, W, H);

  if (snapshot) {
    snapshot.clusters.forEach((cl, ci) => {
      const deps = filterDeps(cl.deployments);
      drawGrid(bgCtx, ci, deps.length);
    });
  }

  // fg: spheres
  fgCtx.clearRect(0, 0, W, H);
  const spheres = allSpheres();
  spheres.forEach(({ ci, di, sp, dep }) => {
    drawSphere(fgCtx, dep, ci, di, sp);
  });

  requestAnimationFrame(render);
}

// ─── resize ──────────────────────────────────────────────────────────────────
function resize() {
  const wrap = document.getElementById("canvas-wrap");
  const nw = wrap.clientWidth, nh = wrap.clientHeight;
  if (nw !== W || nh !== H) {
    W = nw; H = nh;
    bgCanvas.width  = fgCanvas.width  = W;
    bgCanvas.height = fgCanvas.height = H;
  }
}

// ─── picking ─────────────────────────────────────────────────────────────────
function pick(mx, my) {
  const spheres = allSpheres();
  for (const { ci, di, sp, dep } of [...spheres].reverse()) {
    const r = sphereRadius(dep.desired) * sp.scale;
    const dx = mx - sp.sx, dy = my - sp.sy;
    if (dx * dx + dy * dy <= r * r) return { ci, di };
  }
  return null;
}

// ─── mouse events ────────────────────────────────────────────────────────────
fgCanvas.addEventListener("mousedown", e => {
  drag.active = true;
  drag.shift  = e.shiftKey;
  drag.sx = e.clientX; drag.sy = e.clientY;
  drag.yaw0 = cam.yaw; drag.pitch0 = cam.pitch;
  drag.tx0 = cam.tx;   drag.ty0 = cam.ty;
  lastInteract = Date.now();
});

window.addEventListener("mousemove", e => {
  if (drag.active) {
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (drag.shift) {
      cam.tx = drag.tx0 + dx / (Math.min(W, H) * 0.9 / cam.dist);
      cam.ty = drag.ty0 + dy / (Math.min(W, H) * 0.9 / cam.dist);
    } else {
      cam.yaw   = drag.yaw0   + dx * 0.006;
      cam.pitch = drag.pitch0 + dy * 0.006;
      cam.pitch = Math.max(-1.2, Math.min(1.2, cam.pitch));
    }
    lastInteract = Date.now();
  } else {
    const rect = fgCanvas.getBoundingClientRect();
    hovered = pick(e.clientX - rect.left, e.clientY - rect.top);
    fgCanvas.style.cursor = hovered ? "pointer" : "crosshair";
  }
});

window.addEventListener("mouseup", e => {
  if (drag.active) {
    const dx = Math.abs(e.clientX - drag.sx), dy = Math.abs(e.clientY - drag.sy);
    drag.active = false;
    if (dx < 4 && dy < 4) {
      const rect = fgCanvas.getBoundingClientRect();
      const hit = pick(e.clientX - rect.left, e.clientY - rect.top);
      if (hit) {
        selected = hit;
        showDetail(hit.ci, hit.di);
      }
    }
  }
});

fgCanvas.addEventListener("wheel", e => {
  e.preventDefault();
  const factor = e.deltaY > 0 ? 1.05 : 0.95;
  cam.dist = Math.max(5, Math.min(60, cam.dist * factor));
  lastInteract = Date.now();
}, { passive: false });

// ─── detail panel ────────────────────────────────────────────────────────────
function showDetail(ci, di) {
  const cl  = snapshot?.clusters?.[ci];
  const dep = cl?.deployments?.[di];
  if (!dep) return;

  document.getElementById("detail").classList.remove("hidden");
  const col = statusColor(dep.status);
  const cpuText = dep.avg_cpu != null ? dep.avg_cpu.toFixed(1) + "%" : "N/A";

  let podRows = "";
  for (const p of (dep.pods || [])) {
    const pct = p.cpu_pct != null ? p.cpu_pct.toFixed(1) + "%" : "—";
    const mw  = p.cpu_pct != null ? Math.min(60, p.cpu_pct * 0.6) : 0;
    const mc  = statusColor(p.cpu_pct != null
      ? (p.cpu_pct > config.red ? "red" : p.cpu_pct > config.amber ? "amber" : "green")
      : "unknown");
    podRows += `<tr>
      <td>${p.name.substring(0, 28)}</td>
      <td>${p.node?.replace("ip-","") || "—"}</td>
      <td>${p.phase || "—"}</td>
      <td>${p.usage_m != null ? p.usage_m + "m" : "—"}</td>
      <td>${p.basis_m != null ? p.basis_m + "m" : "—"}</td>
      <td><span class="meter-bar" style="width:${mw}px;background:${mc}"></span> ${pct}</td>
    </tr>`;
  }

  document.getElementById("detail-content").innerHTML = `
    <div class="detail-title">${cl.name} &middot; ${dep.namespace} / ${dep.name}</div>
    <div class="detail-cpu" style="color:${col}">${cpuText}</div>
    <div class="detail-sub">${dep.ready}/${dep.desired} replicas ready &nbsp;|&nbsp; ${dep.replica_state}</div>
    <div class="detail-sub">${(dep.pods||[]).filter(p=>p.cpu_pct!=null).length} pods with metrics</div>
    <table class="detail-table">
      <thead><tr><th>Pod</th><th>Node</th><th>Phase</th><th>Usage</th><th>Basis</th><th>CPU%</th></tr></thead>
      <tbody>${podRows}</tbody>
    </table>`;
}

document.getElementById("detail-close").addEventListener("click", () => {
  document.getElementById("detail").classList.add("hidden");
  selected = null;
});

// ─── roster ──────────────────────────────────────────────────────────────────
function updateRoster() {
  if (!snapshot) return;
  const roster = document.getElementById("roster");
  roster.innerHTML = "";
  snapshot.clusters.forEach((cl, ci) => {
    const counts = cl.counts || { green: 0, amber: 0, red: 0, unknown: 0 };
    const total  = (cl.deployments || []).length;
    const row = document.createElement("div");
    row.className = "roster-row" + (selected?.ci === ci ? " active" : "");

    const hue = CLUSTER_HUES[ci % CLUSTER_HUES.length];
    const totalSegs = counts.green + counts.amber + counts.red + counts.unknown || 1;
    const pct = n => (n / totalSegs * 100).toFixed(1) + "%";

    row.innerHTML = `
      <div class="roster-name" style="color:hsl(${hue},80%,65%)">${cl.name}</div>
      ${cl.error ? `<div class="roster-error">&#9888; ${cl.error.substring(0,40)}</div>` : `
      <div class="roster-counts">
        <span class="green">${counts.green}&#9679;</span>
        <span class="amber">${counts.amber}&#9679;</span>
        <span class="red">${counts.red}&#9679;</span>
        <span class="unknown">${counts.unknown}&#9679;</span>
        <span style="color:var(--c-dim)">${total} deps</span>
      </div>
      <div class="health-bar">
        <div class="hb-seg hb-green"  style="width:${pct(counts.green)}"></div>
        <div class="hb-seg hb-amber"  style="width:${pct(counts.amber)}"></div>
        <div class="hb-seg hb-red"    style="width:${pct(counts.red)}"></div>
        <div class="hb-seg hb-unknown"style="width:${pct(counts.unknown)}"></div>
      </div>`}`;

    row.addEventListener("click", () => {
      // Animate camera toward this cluster's plane
      const pos = clusterBasePos(ci);
      cam.yaw = -0.3;
      cam.pitch = 0.4;
      cam.tx = -pos.bx;
      cam.ty = -pos.by * 0.8;
      cam.dist = 24;
    });
    roster.appendChild(row);
  });
}

// ─── footer ──────────────────────────────────────────────────────────────────
function updateFooter() {
  if (!snapshot) return;
  let g = 0, a = 0, r = 0, u = 0, total = 0;
  snapshot.clusters.forEach(cl => {
    (cl.deployments || []).forEach(d => {
      total++;
      if (d.status === "green") g++;
      else if (d.status === "amber") a++;
      else if (d.status === "red") r++;
      else u++;
    });
  });
  document.getElementById("footer-totals").innerHTML =
    `<span class="green">${g}&#9679;</span> <span class="amber">${a}&#9679;</span> <span class="red">${r}&#9679;</span> <span class="unknown">${u}&#9679;</span> of ${total} deployments`;
  document.getElementById("footer-mode").textContent =
    `mode: ${snapshot.mode}`;
  if (snapshot.updated) {
    const d = new Date(snapshot.updated * 1000);
    document.getElementById("footer-updated").textContent =
      `updated: ${d.toLocaleTimeString()}`;
  }
}

// ─── namespace panel ─────────────────────────────────────────────────────────
function buildNsPanel() {
  if (!snapshot) return;
  const inner = document.getElementById("ns-panel-inner");
  inner.innerHTML = "";

  const allNs = {};
  snapshot.clusters.forEach(cl => {
    (cl.deployments || []).forEach(d => {
      if (!allNs[cl.name]) allNs[cl.name] = new Set();
      allNs[cl.name].add(d.namespace);
    });
  });

  for (const [cname, nsSet] of Object.entries(allNs)) {
    const title = document.createElement("div");
    title.className = "ns-cluster-title";
    title.textContent = cname;
    inner.appendChild(title);

    const ctrl = document.createElement("div");
    ctrl.className = "ns-ctrl-row";
    ctrl.innerHTML = `<button class="ctl-btn" data-c="${cname}" data-a="all">ALL</button>
                      <button class="ctl-btn" data-c="${cname}" data-a="none">NONE</button>`;
    inner.appendChild(ctrl);

    for (const ns of [...nsSet].sort()) {
      const sel = nsSel[cname];
      const checked = !sel || sel.includes(ns);
      const row = document.createElement("div");
      row.className = "ns-row";
      row.innerHTML = `<input type="checkbox" data-c="${cname}" data-ns="${ns}" ${checked ? "checked" : ""}> ${ns}`;
      inner.appendChild(row);
    }
  }

  inner.addEventListener("change", e => {
    const cb = e.target;
    if (cb.dataset.ns) {
      const c = cb.dataset.c;
      if (!nsSel[c]) nsSel[c] = [...allNs[c]];
      if (cb.checked) {
        if (!nsSel[c].includes(cb.dataset.ns)) nsSel[c].push(cb.dataset.ns);
      } else {
        nsSel[c] = nsSel[c].filter(n => n !== cb.dataset.ns);
      }
      localStorage.setItem("nsSel", JSON.stringify(nsSel));
      updateNsBadge();
    }
  });

  inner.addEventListener("click", e => {
    const btn = e.target.closest("[data-a]");
    if (!btn) return;
    const c = btn.dataset.c, action = btn.dataset.a;
    nsSel[c] = action === "all" ? null : [];
    if (action === "none") nsSel[c] = [];
    localStorage.setItem("nsSel", JSON.stringify(nsSel));
    buildNsPanel();
    updateNsBadge();
  });
}

function updateNsBadge() {
  const anyFiltered = Object.values(nsSel).some(v => v !== null && v.length >= 0);
  document.getElementById("ns-badge").textContent = anyFiltered ? "SEL" : "ALL";
}

// ─── API polling ─────────────────────────────────────────────────────────────
async function fetchSnapshot() {
  try {
    const r = await fetch("/api/snapshot");
    const data = await r.json();
    if (data.ready) {
      const firstLoad = snapshot === null;
      snapshot = data;
      document.getElementById("error-banner").classList.add("hidden");
      // Auto-fit camera on first load based on real cluster count
      if (firstLoad && data.clusters?.length) {
        const n = data.clusters.length;
        cam.dist = Math.max(32, 22 + n * 4.0);
        cam.yaw = -0.45;
        cam.pitch = 0.42;
        cam.tx = 0;
        cam.ty = ((n - 1) * PLANE_GAP_Y * 0.3);
      }

      // check for unreachable clusters
      const errs = (data.clusters || []).filter(c => c.error);
      if (errs.length) {
        const banner = document.getElementById("error-banner");
        banner.textContent = "⚠ " + errs.map(c => c.name + ": " + c.error).join(" | ");
        banner.classList.remove("hidden");
      }
    }
    updateRoster();
    updateFooter();
    buildNsPanel();
    updateNsBadge();

    // update SIM tag
    if (data.mode === "demo") {
      document.getElementById("sim-tag").classList.remove("hidden");
    }
  } catch (e) {
    console.error("snapshot fetch error", e);
  }
}

async function fetchConfig() {
  try {
    const r = await fetch("/api/config");
    config = await r.json();
    document.getElementById("leg-amber").textContent = config.amber;
    document.getElementById("leg-red").textContent   = config.red;
    document.getElementById("leg-red2").textContent  = config.red;
  } catch (e) {}
}

// ─── controls ────────────────────────────────────────────────────────────────
document.getElementById("btn-alerts").addEventListener("click", e => {
  alertsOnly = !alertsOnly;
  e.currentTarget.classList.toggle("active", alertsOnly);
});

document.getElementById("btn-orbit").addEventListener("click", e => {
  autoOrbit = !autoOrbit;
  e.currentTarget.classList.toggle("active", autoOrbit);
  lastInteract = Date.now();
});

document.getElementById("btn-refresh").addEventListener("click", async () => {
  await fetch("/api/refresh", { method: "POST" });
  await fetchSnapshot();
});

document.getElementById("btn-home").addEventListener("click", () => {
  const n = snapshot?.clusters?.length || 5;
  cam = {
    yaw: -0.45,
    pitch: 0.42,
    dist: Math.max(32, 22 + n * 4.0),
    tx: 0,
    ty: ((n - 1) * PLANE_GAP_Y * 0.3)
  };
});

document.getElementById("btn-ns").addEventListener("click", () => {
  document.getElementById("ns-panel").classList.toggle("hidden");
});

document.getElementById("search").addEventListener("input", e => {
  searchTerm = e.target.value.trim();
});

document.getElementById("btn-scale-down").addEventListener("click", () => {
  uiScale = Math.max(0.7, uiScale - 0.1);
  document.documentElement.style.setProperty("--ui-scale", uiScale);
  localStorage.setItem("uiScale", uiScale);
});

document.getElementById("btn-scale-up").addEventListener("click", () => {
  uiScale = Math.min(1.6, uiScale + 0.1);
  document.documentElement.style.setProperty("--ui-scale", uiScale);
  localStorage.setItem("uiScale", uiScale);
});

// Apply saved UI scale
document.documentElement.style.setProperty("--ui-scale", uiScale);

// ─── init ─────────────────────────────────────────────────────────────────────
(async () => {
  await fetchConfig();
  await fetchSnapshot();
  setInterval(fetchSnapshot, (config.refresh || 15) * 1000);
  render();
})();
