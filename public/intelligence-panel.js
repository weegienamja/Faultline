import "./cases-panel.js";
import { analyseEvidencePatterns } from "./evidence-patterns.js";
import { words } from "./shell.js";

/** Why this surface is unavailable, phrased for the runtime it is in. */
function lockedMessage(what) {
  return words.lockedBody(what);
}

const strip = document.getElementById("incident-list");
const lowerGrid = document.querySelector('[data-mount="intelligence"]') || document.querySelector(".lower-grid");
let data = [];
let analysis = null;
let locked = false;
let refreshTimer = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function createPanel() {
  const panel = document.createElement("section");
  panel.className = "panel intelligence-panel";
  panel.id = "incident-intelligence";
  panel.innerHTML = `
    <div class="intelligence-head">
      <div>
        <span class="section-label">DATA SCIENCE · INCIDENT INTELLIGENCE</span>
        <h2 class="fl-panel-title fl-mt-1">Related evidence patterns</h2>
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

const panel = createPanel();
const summary = panel.querySelector("#intelligence-summary");
const patternCard = panel.querySelector("#pattern-card");
const similarCard = panel.querySelector("#similar-card");
const method = panel.querySelector("#intelligence-method");

/**
 * The diagnostics this analysis runs over.
 *
 * Real collected runs, and nothing else. This used to fall back to a fixed set
 * of hand-written incidents whenever the credential was missing or rejected,
 * which meant the clustering on screen was frequently describing fabricated
 * data while presenting itself as evidence analysis. Clustering nothing is an
 * honest result; clustering invented incidents is not.
 */
async function fetchVisibleIncidents() {
  const token = sessionStorage.getItem("faultlineAdminToken") || "";
  if (!token) return { locked: true, incidents: [] };

  const live = await fetch("/api/incidents", {
    cache: "no-store",
    headers: { authorization: `Bearer ${token}` }
  });
  if (live.status === 401) return { locked: true, incidents: [] };
  if (!live.ok) throw new Error(`Faultline returned HTTP ${live.status}.`);
  return { locked: false, incidents: await live.json() };
}

function activeIndex() {
  const active = strip?.querySelector("button.active");
  return active ? Number(active.dataset.index || 0) : 0;
}

// Two different questions, two different thresholds.
//
//   MIN_COMPARE  pairwise similarity needs a pair, and nothing more. Two
//                diagnostics produce a real, useful comparison.
//   MIN_POINTS   DBSCAN needs this many neighbours before calling anything a
//                dense group, so below it there is no cluster to report.
//
// Collapsing the two into one threshold meant that at exactly two diagnostics
// the panel withheld a similarity score it could already compute, and said
// similarity needed two incidents while two were sitting in front of it.
const MIN_COMPARE = 2;
const MIN_POINTS = 3;

function render() {
  if (locked) {
    summary.textContent = lockedMessage("Pattern analysis over collected diagnostics");
    patternCard.innerHTML = `<p class="intelligence-empty">${lockedMessage("Cross-incident pattern analysis")}</p>`;
    similarCard.innerHTML = "";
    method.textContent = "";
    return;
  }

  if (!data.length) {
    summary.textContent = "No diagnostics have been collected yet, so there is nothing to compare.";
    patternCard.innerHTML = `<p class="intelligence-empty">Run a live diagnostic or capture a Flight Recorder incident. Patterns appear once this installation has collected its own evidence — Faultline does not analyse sample data.</p>`;
    similarCard.innerHTML = "";
    method.textContent = "";
    return;
  }

  if (!analysis || data.length < MIN_COMPARE) {
    summary.textContent = "One diagnostic collected. There is nothing to compare it with yet.";
    patternCard.innerHTML = `<p class="intelligence-empty">Collect a second diagnostic and Faultline will rank how similar their measured evidence is.</p>`;
    similarCard.innerHTML = "";
    method.textContent = "";
    return;
  }

  const incident = data[Math.min(activeIndex(), data.length - 1)];
  const insight = analysis.incidents[incident.id];
  const cluster = insight?.clusterId ? analysis.clusters.find(item => item.id === insight.clusterId) : null;

  // Enough to compare, not yet enough to cluster. The similarity block below
  // still runs — that is the part that works at this size.
  if (data.length < MIN_POINTS) {
    const short = MIN_POINTS - data.length;
    summary.textContent = `${data.length} diagnostics collected, ranked by measured similarity below. Density-based clustering needs ${MIN_POINTS}, so no pattern is claimed yet.`;
    patternCard.innerHTML = `
      <h3>Not enough diagnostics to cluster</h3>
      <p class="intelligence-empty">Similarity between individual diagnostics is available now. DBSCAN needs ${MIN_POINTS} before a group is dense enough to mean anything, so ${short} more would let Faultline look for a shared evidence signature rather than a single comparison.</p>
    `;
  } else if (cluster) {
    summary.textContent = `${cluster.size} diagnostics form ${cluster.id}, a dense group with a similar measured evidence signature. This does not change the deterministic fault-domain result.`;
    patternCard.innerHTML = `
      <h3>${escapeHtml(cluster.id)} · ${cluster.size} related diagnostics</h3>
      <div class="pattern-meta">Current case: ${escapeHtml(incident.id)} · cluster discovered without labelled training data</div>
      <div class="pattern-features">
        ${cluster.commonCharacteristics.map(item => `<span class="pattern-feature">${escapeHtml(item.label)}</span>`).join("") || '<span class="intelligence-empty">No single human-readable characteristic is shared across every member.</span>'}
      </div>
    `;
  } else {
    summary.textContent = `${incident.id} is currently treated as an outlier rather than part of a dense incident pattern. Similarity scores are still available for comparison.`;
    patternCard.innerHTML = `
      <h3>No dense cluster for this incident</h3>
      <p class="intelligence-empty">DBSCAN marked this evidence pattern as noise at the current density threshold. That is a valid analytical result rather than forcing every case into a group.</p>
    `;
  }

  const neighbours = insight?.neighbours || [];
  similarCard.innerHTML = `
    <h3>Most similar diagnostics</h3>
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

  method.textContent = data.length < MIN_POINTS
    ? `Pairwise similarity over ${analysis.featureSpace.incidentCount} collected diagnostics, using standardised numerical telemetry, binary network states and one-hot Connectivity Contract outcomes. Fault domain is not used. No density-based cluster is reported below minPts=${analysis.method.minPoints}; only pairwise similarity is shown.`
    : `${analysis.method.name}: ε=${analysis.method.epsilon}, minPts=${analysis.method.minPoints}. ${analysis.featureSpace.incidentCount} visible incidents analysed using standardised numerical telemetry, binary network states and one-hot Connectivity Contract outcomes. Fault domain is not used to fit clusters.`;
}

async function refresh() {
  try {
    const visible = await fetchVisibleIncidents();
    locked = visible.locked;
    data = visible.incidents;
    analysis = data.length >= MIN_COMPARE ? analyseEvidencePatterns(data) : null;
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

// The strip is empty until diagnostics exist, so its mutations can no longer be
// the only refresh trigger — unlocking has to re-run the analysis by itself.
// Previously this was masked: sample incidents always populated the strip.
window.addEventListener("faultline-auth-changed", scheduleRefresh);

refresh();
