import { buildLivePathTopology, normaliseTopology } from "./topology-view.js";

const ids = [
  "incident-list", "fault-domain", "confidence", "confidence-ring", "diagnosis-summary",
  "incident-title", "incident-id", "customer", "target", "location", "connection",
  "metrics", "evidence-list", "action-list", "path", "route-panel", "route-trace",
  "incident-status", "measured-at", "auth-open", "auth-dialog", "auth-form", "auth-token",
  "auth-error", "auth-cancel", "probe-fleet-panel", "probe-fleet", "topology-panel",
  "topology-canvas", "topology-kind", "topology-confidence", "topology-summary"
];
const els = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));

let incidents = [];
let probes = [];
let activeIndex = 0;
let adminToken = sessionStorage.getItem("faultlineAdminToken") || "";

const statusFor = (value, warn, fail) => value >= fail ? "fail" : value >= warn ? "warn" : "pass";
const displayNumber = (value, suffix = "") => Number.isFinite(Number(value)) ? `${Number(value)}${suffix}` : "Not collected";
const escapeHtml = value => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function sourceLabel(incident) {
  if (incident.source === "correlated") return '<b class="source-live">2 VANTAGES</b>';
  if (incident.source === "agent") return '<b class="source-live">ENDPOINT ONLY</b>';
  return "DEMO";
}

function applyAuthState() {
  els["auth-open"].textContent = adminToken ? "Live data unlocked" : "Unlock live data";
  els["auth-open"].classList.toggle("unlocked", Boolean(adminToken));
}

// Panels rendered by other modules (case workspaces) refresh on this event.
function setAdminToken(value) {
  adminToken = value || "";
  if (adminToken) sessionStorage.setItem("faultlineAdminToken", adminToken);
  else sessionStorage.removeItem("faultlineAdminToken");
  applyAuthState();
  window.dispatchEvent(new CustomEvent("faultline-auth-changed"));
}

function renderIncidentStrip() {
  els["incident-list"].innerHTML = incidents.map((incident, index) => `
    <button class="incident-chip ${index === activeIndex ? "active" : ""}" data-index="${index}">
      <span>${sourceLabel(incident)} · ${escapeHtml(incident.id)} · ${escapeHtml(incident.diagnosis.faultDomainLabel)}</span>
      <strong>${escapeHtml(incident.title)}</strong>
    </button>
  `).join("");

  els["incident-list"].querySelectorAll("button").forEach(button => {
    button.addEventListener("click", () => {
      activeIndex = Number(button.dataset.index);
      render();
    });
  });
}

function relativeSeen(value) {
  if (!value) return "Never";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function renderProbeFleet() {
  // The fleet is a destination in its own right, so it explains why it is empty
  // instead of disappearing when the credential is missing.
  if (!adminToken) {
    els["probe-fleet"].innerHTML = `<div class="fl-state" data-tone="locked">
      <div class="fl-state-icon" aria-hidden="true">◌</div>
      <p class="fl-state-title">Fleet health is locked</p>
      <p class="fl-state-body">Registered probe identities and heartbeat health require the Faultline admin credential.</p>
      <div class="fl-state-actions"><button class="fl-btn fl-btn-primary" data-action="unlock">Unlock live data</button></div>
    </div>`;
    return;
  }

  if (!probes.length) {
    els["probe-fleet"].innerHTML = `<div class="fl-state">
      <div class="fl-state-icon" aria-hidden="true">◎</div>
      <p class="fl-state-title">No registered probes</p>
      <p class="fl-state-body">A probe is a persistent, authenticated vantage point. Register the first remote worker from the CLI to correlate endpoint evidence against a second viewpoint.</p>
    </div>`;
    return;
  }

  els["probe-fleet"].innerHTML = probes.map(probe => `
    <article class="probe-tile">
      <div class="probe-tile-head">
        <div>
          <h4>${escapeHtml(probe.name)}</h4>
          <p>${escapeHtml(probe.location || probe.id)}</p>
        </div>
        <span class="probe-health ${escapeHtml(probe.health)}">${escapeHtml(probe.health)}</span>
      </div>
      <div class="probe-meta">
        <div><small>Probe ID</small><strong>${escapeHtml(probe.id)}</strong></div>
        <div><small>Last seen</small><strong>${escapeHtml(relativeSeen(probe.lastSeenAt))}</strong></div>
        <div><small>Runtime</small><strong>${escapeHtml(probe.runtime?.platform || "Not reported")}</strong></div>
        <div><small>Version</small><strong>${escapeHtml(probe.runtime?.version || "Not reported")}</strong></div>
      </div>
    </article>
  `).join("");
}

function topologyGlyph(type) {
  return {
    laptop: "▰",
    endpoint: "▰",
    router: "⌁",
    gateway: "⌁",
    "access-point": "◉",
    access_point: "◉",
    "mesh-node": "◈",
    mesh: "◈",
    switch: "▦",
    printer: "▤",
    server: "▥",
    nas: "▥",
    phone: "▯",
    tablet: "▭",
    internet: "◎",
    boundary: "◎",
    transit: "⇄",
    service: "▣",
    unknown: "◇"
  }[type] || "◇";
}

function topologyNodeSubtitle(node) {
  if (node.role === "transit" || node.role === "target") {
    const owner = node.asn != null ? `AS${node.asn}` : null;
    const rtt = typeof node.rttMs === "number" ? `${node.rttMs} ms` : null;
    return [owner, node.ip, rtt].filter(Boolean).join(" · ") || "public network";
  }
  if (node.role === "boundary") return "External network boundary";
  if (node.ip) return node.ip;
  if (node.ssid) return node.ssid;
  return node.type?.replaceAll("-", " ") || "Network device";
}

function topologyTooltip(node) {
  return [
    node.label,
    `Type: ${node.type || "unknown"}`,
    `Confidence: ${node.confidence || "unknown"}`,
    node.ip ? `IP: ${node.ip}` : null,
    node.mac ? `MAC: ${node.mac}` : null,
    node.connection ? `Connection: ${node.connection}` : null,
    node.evidence ? `Evidence: ${node.evidence}` : null,
    node.ownerEvidence === "routing-metadata" ? "Owner label: public routing metadata, not proof of fault ownership" : null,
    node.prefix ? `Prefix: ${node.prefix}` : null,
    node.inferenceReason || null
  ].filter(Boolean).join("\n");
}

function isAffectedTopologyLink(link, topology, domain) {
  const path = topology.affectedPath || [];
  const position = path.indexOf(link.source);
  const onPath = position >= 0 && path[position + 1] === link.target;
  if (!onPath) return "";

  if (domain === "local_network" && link.target !== "internet") return "fault";
  if (domain === "upstream" && link.target === "internet") return "fault";
  if (domain === "access_path") return "affected";
  return domain === "healthy" ? "" : "affected";
}

function topologyNodeFault(node, domain) {
  if (domain === "local_network" && ["endpoint", "access", "gateway"].includes(node.role)) return true;
  if (domain === "upstream" && node.role === "boundary") return true;
  return false;
}

function topologyPositions(topology, width, height) {
  const positions = new Map();
  const clampX = value => Math.max(75, Math.min(width - 75, value));
  const clampY = value => Math.max(55, Math.min(height - 55, value));

  // Lay the primary path out by role so both collector schemas position correctly.
  for (const [role, fraction] of [["endpoint", .10], ["access", .26], ["gateway", .42], ["boundary", .58]]) {
    const node = topology.nodes.find(item => item.role === role);
    if (node) positions.set(node.id, { x: clampX(width * fraction), y: clampY(height * .43) });
  }

  // Public path segments and the target service continue along the same lane.
  const transit = topology.nodes.filter(node => node.role === "transit");
  const targetNode = topology.nodes.find(node => node.role === "target");
  const tail = [...transit, ...(targetNode ? [targetNode] : [])];
  tail.forEach((node, index) => {
    const fraction = .62 + ((index + 1) / (tail.length + 1)) * .34;
    positions.set(node.id, { x: clampX(width * fraction), y: clampY(height * .43) });
  });

  const neighbours = topology.nodes.filter(node => node.role === "neighbour");
  neighbours.forEach((node, index) => {
    const count = Math.max(neighbours.length, 1);
    const spread = Math.min(Math.PI * .9, Math.PI * .22 * Math.max(count - 1, 1));
    const start = Math.PI / 2 - spread / 2;
    const angle = count === 1 ? Math.PI / 2 : start + (spread * index / (count - 1));
    positions.set(node.id, {
      x: clampX(width * .57 + Math.cos(angle) * Math.min(260, width * .27)),
      y: clampY(height * .5 + Math.sin(angle) * Math.min(145, height * .32))
    });
  });

  topology.nodes.forEach((node, index) => {
    if (!positions.has(node.id)) {
      positions.set(node.id, {
        x: clampX(width * .3 + (index % 4) * 150),
        y: clampY(75 + Math.floor(index / 4) * 105)
      });
    }
  });

  return positions;
}

// A completed live diagnostic takes over the map with the real measured path.
let liveTopology = null;
let liveFaultDomain = null;

window.addEventListener("faultline-live-result", event => {
  try {
    const built = buildLivePathTopology(event.detail);
    if (built?.nodes?.length) {
      liveTopology = built;
      liveFaultDomain = event.detail?.deterministic?.diagnosis?.faultDomain || null;
      drawTopology(liveTopology, liveFaultDomain, true);
    }
  } catch {
    liveTopology = null;
  }
});

function renderTopology(incident) {
  // Once a live diagnostic has produced a real path, keep showing it rather
  // than reverting to a demo incident's synthetic topology.
  if (liveTopology) {
    drawTopology(liveTopology, liveFaultDomain, true);
    return;
  }
  const collected = incident.telemetry?.topology;
  els["topology-panel"].hidden = !collected?.nodes?.length;
  if (!collected?.nodes?.length) {
    els["topology-canvas"].replaceChildren();
    return;
  }
  drawTopology(normaliseTopology(collected), incident.diagnosis.faultDomain, false);
}

function drawTopology(topology, faultDomain, isLive) {
  els["topology-panel"].hidden = false;
  els["topology-kind"].textContent = topology.kind || "unknown";
  els["topology-confidence"].textContent = isLive ? "live measured path" : `${topology.confidence || "low"} confidence`;
  // Confidence is a status, not a decoration: measured paths read as observed,
  // inferred ones carry the confidence the inference engine actually reported.
  els["topology-confidence"].className = "fl-badge";
  els["topology-confidence"].dataset.status = isLive
    ? "info"
    : ({ high: "ok", medium: "warn", low: "idle" }[topology.confidence] || "idle");
  els["topology-summary"].textContent = isLive
    ? `${topology.summary || "Live path collected."} Solid links are OBSERVED hops; dashed links are INFERRED; owner labels are public routing metadata.`
    : `${topology.summary || "Topology evidence collected."} Passive discovery only; dashed links are inferred.`;

  const canvas = els["topology-canvas"];
  canvas.replaceChildren();
  const grid = document.createElement("div");
  grid.className = "topology-grid";
  canvas.append(grid);

  const width = Math.max(canvas.clientWidth, 720);
  const height = Math.max(canvas.clientHeight, 390);
  const positions = topologyPositions(topology, width, height);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.classList.add("topology-links");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  canvas.append(svg);

  const lineById = new Map();
  for (const link of topology.links || []) {
    const line = document.createElementNS(ns, "line");
    const affected = isAffectedTopologyLink(link, topology, faultDomain);
    line.setAttribute("class", `topology-link ${link.observed ? "" : "inferred"} ${affected}`.trim());
    line.dataset.source = link.source;
    line.dataset.target = link.target;
    const title = document.createElementNS(ns, "title");
    title.textContent = `${link.type || "relationship"} · ${link.confidence || "unknown"} confidence\n${link.reason || ""}`;
    line.append(title);
    svg.append(line);
    lineById.set(link.id, line);
  }

  const nodeEls = new Map();
  for (const node of topology.nodes) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = `topology-node ${node.role || ""}${topologyNodeFault(node, faultDomain) ? " local-fault" : ""}`;
    element.title = topologyTooltip(node);

    const icon = document.createElement("span");
    icon.className = "topology-icon";
    icon.textContent = topologyGlyph(node.type);

    const copy = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = node.label || node.id;
    const subtitle = document.createElement("small");
    subtitle.textContent = topologyNodeSubtitle(node);
    copy.append(label, subtitle);

    const confidence = document.createElement("i");
    confidence.className = `topology-confidence ${node.confidence || "low"}`;
    confidence.title = `${node.confidence || "low"} confidence`;

    element.append(icon, copy, confidence);
    canvas.append(element);
    nodeEls.set(node.id, element);
  }

  const placeNodes = () => {
    for (const [id, element] of nodeEls.entries()) {
      const point = positions.get(id);
      if (!point) continue;
      element.style.left = `${point.x}px`;
      element.style.top = `${point.y}px`;
    }
    for (const link of topology.links || []) {
      const line = lineById.get(link.id);
      const source = positions.get(link.source);
      const target = positions.get(link.target);
      if (!line || !source || !target) continue;
      line.setAttribute("x1", source.x);
      line.setAttribute("y1", source.y);
      line.setAttribute("x2", target.x);
      line.setAttribute("y2", target.y);
    }
  };

  placeNodes();

  for (const [id, element] of nodeEls.entries()) {
    element.addEventListener("pointerdown", event => {
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      const rect = canvas.getBoundingClientRect();
      const move = moveEvent => {
        const x = Math.max(72, Math.min(width - 72, (moveEvent.clientX - rect.left) * (width / rect.width)));
        const y = Math.max(48, Math.min(height - 48, (moveEvent.clientY - rect.top) * (height / rect.height)));
        positions.set(id, { x, y });
        placeNodes();
      };
      const end = () => {
        element.removeEventListener("pointermove", move);
        element.removeEventListener("pointerup", end);
        element.removeEventListener("pointercancel", end);
      };
      element.addEventListener("pointermove", move);
      element.addEventListener("pointerup", end);
      element.addEventListener("pointercancel", end);
    });
  }
}

function renderRoute(incident) {
  const hops = incident.telemetry?.pathTrace || [];
  els["route-panel"].hidden = hops.length === 0;
  if (!hops.length) {
    els["route-trace"].innerHTML = "";
    return;
  }

  els["route-trace"].innerHTML = hops.map(hop => `
    <div class="route-hop ${hop.timedOut ? "timeout" : ""}">
      <small>HOP ${escapeHtml(hop.hop)}</small>
      <strong>${escapeHtml(hop.ip || "No response")}</strong>
      <span>${hop.averageRttMs == null ? "timeout" : `${escapeHtml(hop.averageRttMs)} ms`}</span>
    </div>
  `).join("");
}

function render() {
  const incident = incidents[activeIndex];
  if (!incident) return;
  const result = incident.diagnosis;
  const m = incident.metrics;

  renderIncidentStrip();
  renderProbeFleet();
  els["fault-domain"].textContent = result.faultDomainLabel;
  els.confidence.textContent = `${result.confidence}%`;
  els["confidence-ring"].style.setProperty("--confidence", `${result.confidence}%`);
  els["diagnosis-summary"].textContent = result.summary;
  els["incident-title"].textContent = incident.title;
  els["incident-id"].textContent = incident.id;
  els.customer.textContent = incident.customer;
  els.target.textContent = incident.target;
  els.location.textContent = incident.location;
  els.connection.textContent = incident.connection;

  const twoVantages = incident.vantages?.remoteProbe === true || incident.source === "correlated";
  els["incident-status"].textContent = incident.source === "demo" ? "Demo incident" : twoVantages ? "2 vantage points" : "Endpoint only";
  els["incident-status"].dataset.status = incident.source === "demo" ? "idle" : "info";
  els["measured-at"].textContent = incident.updatedAt || incident.collectedAt
    ? new Date(incident.updatedAt || incident.collectedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "demo data";

  const path = [
    { label: "Endpoint", value: incident.connection, status: m.gatewayLoss >= 5 ? "fail" : "pass" },
    { label: "Gateway", value: `${m.gatewayLatencyMs} ms`, status: statusFor(m.gatewayLoss, 2, 5) },
    { label: "DNS", value: m.dnsResolved ? "Resolved" : "Failed", status: m.dnsResolved ? "pass" : "fail" },
    { label: "Internet path", value: `${m.upstreamLoss}% loss`, status: statusFor(m.upstreamLoss, 2, 5) },
    { label: "Target", value: m.targetReachable ? "Reachable" : "Unreachable", status: m.targetReachable ? "pass" : "fail" }
  ];
  els.path.innerHTML = path.map(node => `
    <div class="path-node ${node.status}"><small>${escapeHtml(node.label)}</small><strong>${escapeHtml(node.value)}</strong></div>
  `).join("");

  const metrics = [
    ["Gateway latency", `${m.gatewayLatencyMs} ms`, statusFor(m.gatewayLatencyMs, 25, 40)],
    ["Local packet loss", `${m.gatewayLoss}%`, statusFor(m.gatewayLoss, 2, 5)],
    ["Upstream packet loss", `${m.upstreamLoss}%`, statusFor(m.upstreamLoss, 2, 5)],
    ["Jitter", `${m.jitterMs} ms`, statusFor(m.jitterMs, 30, 50)]
  ];

  if (m.dnsLookupMs != null) metrics.push(["DNS lookup", displayNumber(m.dnsLookupMs, " ms"), statusFor(m.dnsLookupMs, 300, 1000)]);
  if (m.wifiSignalPct != null) metrics.push(["Wi-Fi signal", `${m.wifiSignalPct}%`, m.wifiSignalPct < 35 ? "fail" : m.wifiSignalPct < 55 ? "warn" : "pass"]);
  if (m.targetTcpMs != null) metrics.push(["Target TCP", `${m.targetTcpMs} ms`, m.targetReachable ? "pass" : "fail"]);

  const probeValue = m.externalProbeHealthy == null
    ? "Awaiting probe"
    : `${m.externalProbeHealthy ? "Reachable" : "Unreachable"}${m.externalProbeLatencyMs != null ? ` · ${Number(m.externalProbeLatencyMs).toFixed(0)} ms` : ""}`;
  metrics.push([
    "Remote vantage",
    probeValue,
    m.externalProbeHealthy == null ? "neutral" : m.externalProbeHealthy ? "pass" : "fail"
  ]);

  els.metrics.innerHTML = metrics.map(([label, value, status]) => `
    <div class="metric ${status}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><em>${status === "pass" ? "healthy" : status === "warn" ? "elevated" : status === "neutral" ? "pending" : "degraded"}</em></div>
  `).join("");

  els["evidence-list"].innerHTML = result.evidence.map(item => `
    <div class="evidence-row ${item.status}">
      <span class="evidence-dot"></span>
      <strong>${escapeHtml(item.label)}</strong>
      <p>${escapeHtml(item.detail)}</p>
      <span class="evidence-value">${escapeHtml(item.value || "")}</span>
    </div>
  `).join("");

  els["action-list"].innerHTML = result.actions.map(action => `<li>${escapeHtml(action)}</li>`).join("");
  renderTopology(incident);
  renderRoute(incident);

  document.getElementById("diagnosis-panel")?.setAttribute(
    "data-status",
    m.targetReachable === false || m.dnsResolved === false ? "crit"
      : (m.upstreamLoss ?? 0) >= 2 || (m.gatewayLoss ?? 0) >= 2 ? "warn" : "ok"
  );
  window.dispatchEvent(new CustomEvent("faultline-incident", { detail: { incident, incidents, probes } }));
}

async function fetchJson(path, token = "") {
  const response = await fetch(path, {
    cache: "no-store",
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function loadIncidents({ initial = false } = {}) {
  const activeId = incidents[activeIndex]?.id;
  let next;

  if (adminToken) {
    try {
      [next, probes] = await Promise.all([
        fetchJson("/api/incidents", adminToken),
        fetchJson("/api/probes", adminToken)
      ]);
    } catch (error) {
      if (error.status !== 401) throw error;
      probes = [];
      setAdminToken("");
      next = await fetchJson("/api/demo-incidents");
    }
  } else {
    probes = [];
    next = await fetchJson("/api/demo-incidents");
  }

  const newestLive = next.find(incident => incident.source === "agent" || incident.source === "correlated");
  const isNewLive = newestLive && !incidents.some(incident => incident.id === newestLive.id);
  incidents = next;

  if (initial) activeIndex = 0;
  else if (isNewLive) activeIndex = incidents.findIndex(incident => incident.id === newestLive.id);
  else if (activeId) activeIndex = Math.max(0, incidents.findIndex(incident => incident.id === activeId));

  render();
}

els["auth-open"].addEventListener("click", () => {
  els["auth-error"].textContent = "";
  els["auth-token"].value = "";
  els["auth-dialog"].showModal();
  els["auth-token"].focus();
});

els["auth-cancel"].addEventListener("click", () => els["auth-dialog"].close());

els["auth-form"].addEventListener("submit", async event => {
  event.preventDefault();
  const candidate = els["auth-token"].value.trim();
  if (!candidate) {
    els["auth-error"].textContent = "Enter the Faultline admin token.";
    return;
  }

  els["auth-error"].textContent = "Checking credential…";
  try {
    [incidents, probes] = await Promise.all([
      fetchJson("/api/incidents", candidate),
      fetchJson("/api/probes", candidate)
    ]);
    activeIndex = 0;
    setAdminToken(candidate);
    render();
    els["auth-dialog"].close();
  } catch (error) {
    els["auth-error"].textContent = error.status === 401 ? "That admin token was rejected." : error.message;
  }
});

async function init() {
  try {
    applyAuthState();
    await loadIncidents({ initial: true });
    setInterval(() => loadIncidents().catch(() => {}), 4_000);
  } catch (error) {
    document.body.innerHTML = `<main class="fatal"><h1>Faultline</h1><p>Unable to load diagnostics: ${escapeHtml(error.message)}</p></main>`;
  }
}

init();
