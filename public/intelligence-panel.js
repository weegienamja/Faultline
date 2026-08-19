import "./cases-panel.js";
import { analyseEvidencePatterns } from "./evidence-patterns.js";

const strip = document.getElementById("incident-list");
const lowerGrid = document.querySelector('[data-mount="intelligence"]') || document.querySelector(".lower-grid");
let data = [];
let analysis = null;
let refreshTimer = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function installStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .intelligence-panel { margin-top: 13px; }
    .intelligence-head { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; flex-wrap:wrap; }
    .intelligence-badges { display:flex; gap:6px; flex-wrap:wrap; }
    .intelligence-badge { border:1px solid var(--fl-ok-line); color:var(--accent); background:var(--accent-soft); border-radius:999px; padding:5px 8px; font-size:8px; letter-spacing:.09em; text-transform:uppercase; }
    .intelligence-badge.neutral { border-color:var(--border); color:var(--muted); background:rgba(255,255,255,.015); }
    .intelligence-summary { margin:10px 0 0; color:#b8c8c3; line-height:1.55; font-size:12px; max-width:850px; }
    .intelligence-layout { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(260px,.9fr); gap:12px; margin-top:16px; }
    .pattern-card, .similar-card { border:1px solid var(--border-soft); border-radius:11px; background:rgba(255,255,255,.012); padding:14px; }
    .pattern-card h4, .similar-card h4 { margin:0 0 8px; font-size:12px; }
    .pattern-meta { color:var(--muted); font-size:10px; margin-bottom:10px; }
    .pattern-features { display:flex; flex-wrap:wrap; gap:6px; }
    .pattern-feature { border:1px solid var(--fl-ok-line); border-radius:999px; padding:5px 8px; color:#bcd0ca; font-size:9px; background:var(--fl-ok-soft); }
    .similar-list { display:grid; gap:7px; }
    .similar-row { border-top:1px solid var(--border-soft); padding-top:8px; display:grid; grid-template-columns:1fr auto; gap:8px; }
    .similar-row:first-child { border-top:0; padding-top:0; }
    .similar-row strong { font-size:10px; display:block; }
    .similar-row small { color:var(--muted); font-size:9px; line-height:1.4; display:block; margin-top:3px; }
    .similar-score { color:var(--accent); font-size:13px; font-weight:780; white-space:nowrap; }
    .intelligence-method { margin-top:10px; color:var(--fl-text-3); font-size:9px; line-height:1.5; }
    .intelligence-empty { color:var(--muted); font-size:11px; line-height:1.5; }
    @media(max-width:760px) { .intelligence-layout { grid-template-columns:1fr; } }
  `;
  document.head.appendChild(style);
}

function createPanel() {
  const panel = document.createElement("section");
  panel.className = "panel intelligence-panel";
  panel.id = "incident-intelligence";
  panel.innerHTML = `
    <div class="intelligence-head">
      <div>
        <span class="section-label">DATA SCIENCE · INCIDENT INTELLIGENCE</span>
        <h3 style="margin:4px 0 0">Related evidence patterns</h3>
      </div>
      <div class="intelligence-badges">
        <span class="intelligence-badge">DBSCAN</span>
        <span class="intelligence-badge neutral">unsupervised</span>
      </div>
    </div>
    <p class="intelligence-summary" id="intelligence-summary">Analysing the currently visible diagnostics…</p>
    <div class="intelligence-layout">
      <article class="pattern-card" id="pattern-card"></article>
      <article class="similar-card" id="similar-card"></article>
    </div>
    <p class="intelligence-method" id="intelligence-method"></p>
  `;
  if (lowerGrid?.dataset?.mount) lowerGrid.appendChild(panel);
  else lowerGrid?.parentNode?.insertBefore(panel, lowerGrid);
  return panel;
}

installStyles();
const panel = createPanel();
const summary = panel.querySelector("#intelligence-summary");
const patternCard = panel.querySelector("#pattern-card");
const similarCard = panel.querySelector("#similar-card");
const method = panel.querySelector("#intelligence-method");

async function fetchVisibleIncidents() {
  const token = sessionStorage.getItem("faultlineAdminToken") || "";
  if (token) {
    const live = await fetch("/api/incidents", {
      cache: "no-store",
      headers: { authorization: `Bearer ${token}` }
    });
    if (live.ok) return live.json();
  }
  const demo = await fetch("/api/demo-incidents", { cache: "no-store" });
  if (!demo.ok) throw new Error(`Faultline returned HTTP ${demo.status}.`);
  return demo.json();
}

function activeIndex() {
  const active = strip?.querySelector("button.active");
  return active ? Number(active.dataset.index || 0) : 0;
}

function render() {
  if (!analysis || !data.length) {
    summary.textContent = "Not enough incident evidence is available for pattern analysis.";
    patternCard.innerHTML = '<p class="intelligence-empty">At least several diagnostics are needed before density-based clustering is meaningful.</p>';
    similarCard.innerHTML = '<p class="intelligence-empty">No related incidents available.</p>';
    method.textContent = "";
    return;
  }

  const incident = data[Math.min(activeIndex(), data.length - 1)];
  const insight = analysis.incidents[incident.id];
  const cluster = insight?.clusterId ? analysis.clusters.find(item => item.id === insight.clusterId) : null;

  if (cluster) {
    summary.textContent = `${cluster.size} diagnostics form ${cluster.id}, a dense group with a similar measured evidence signature. This does not change the deterministic fault-domain result.`;
    patternCard.innerHTML = `
      <h4>${escapeHtml(cluster.id)} · ${cluster.size} related diagnostics</h4>
      <div class="pattern-meta">Current case: ${escapeHtml(incident.id)} · cluster discovered without labelled training data</div>
      <div class="pattern-features">
        ${cluster.commonCharacteristics.map(item => `<span class="pattern-feature">${escapeHtml(item.label)}</span>`).join("") || '<span class="intelligence-empty">No single human-readable characteristic is shared across every member.</span>'}
      </div>
    `;
  } else {
    summary.textContent = `${incident.id} is currently treated as an outlier rather than part of a dense incident pattern. Similarity scores are still available for comparison.`;
    patternCard.innerHTML = `
      <h4>No dense cluster for this incident</h4>
      <p class="intelligence-empty">DBSCAN marked this evidence pattern as noise at the current density threshold. That is a valid analytical result rather than forcing every case into a group.</p>
    `;
  }

  const neighbours = insight?.neighbours || [];
  similarCard.innerHTML = `
    <h4>Most similar diagnostics</h4>
    <div class="similar-list">
      ${neighbours.length ? neighbours.map(item => `
        <div class="similar-row">
          <div>
            <strong>${escapeHtml(item.id)} · ${escapeHtml(item.title)}</strong>
            <small>${escapeHtml(item.reasons.join(" · ") || "Similarity comes from the combined standardised feature vector.")}</small>
          </div>
          <span class="similar-score">${item.similarity.toFixed(1)}%</span>
        </div>
      `).join("") : '<p class="intelligence-empty">No comparison incidents are available.</p>'}
    </div>
  `;

  method.textContent = `${analysis.method.name}: ε=${analysis.method.epsilon}, minPts=${analysis.method.minPoints}. ${analysis.featureSpace.incidentCount} visible incidents analysed using standardised numerical telemetry, binary network states and one-hot Connectivity Contract outcomes. Fault domain is not used to fit clusters.`;
}

async function refresh() {
  try {
    data = await fetchVisibleIncidents();
    analysis = analyseEvidencePatterns(data);
    render();
  } catch (error) {
    summary.textContent = `Incident intelligence unavailable: ${error.message}`;
    patternCard.innerHTML = "";
    similarCard.innerHTML = "";
    method.textContent = "";
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 80);
}

strip?.addEventListener("click", event => {
  if (!event.target.closest("button[data-index]")) return;
  setTimeout(render, 0);
});

if (strip) {
  new MutationObserver(scheduleRefresh).observe(strip, { childList: true, subtree: true });
}

refresh();
