// Network Bisect.
//
// The screen is organised around the reasoning, not the data dump. Reading top
// to bottom you get: what it concluded, how much work that took, the path of
// experiments it chose and why, and which explanations survived. Everything
// else — the interface table, the experiments it declined to run, the full
// executed matrix — is available but collapsed.
//
// Presentation is built entirely from the shared primitives in shell.js. This
// module previously injected ~60 lines of its own CSS with hardcoded colours;
// the only styles left here are the two layout rules that are genuinely local
// to this screen.

import {
  escapeHtml, mount, panel, tile, state, badge, stateBadge, disclose, auth, statusOf
} from "./shell.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const VERDICT_LABEL = {
  FAILURE_DISCRIMINATOR: "Failure condition isolated",
  WORKAROUND_CANDIDATE: "Workaround identified",
  LOCAL_CAPABILITY_DEFICIENCY: "Local capability difference",
  TARGET_PROPERTY: "Target property, not a fault",
  NO_MEANINGFUL_DIFFERENCE: "No condition made a difference",
  UNSTABLE_BASELINE: "Baseline too unstable to isolate",
  INAPPLICABLE_CONDITION: "Condition not applicable",
  INSUFFICIENT_EVIDENCE: "Evidence insufficient"
};

// A conclusive, actionable result reads as ok; an inconclusive one as warn;
// "there is nothing here to find" as neutral. The colour describes the
// confidence of the conclusion, never whether the network is healthy.
const VERDICT_STATUS = {
  FAILURE_DISCRIMINATOR: "ok",
  WORKAROUND_CANDIDATE: "ok",
  LOCAL_CAPABILITY_DEFICIENCY: "warn",
  UNSTABLE_BASELINE: "warn",
  INSUFFICIENT_EVIDENCE: "warn",
  TARGET_PROPERTY: "idle",
  NO_MEANINGFUL_DIFFERENCE: "idle",
  INAPPLICABLE_CONDITION: "idle"
};

const BASELINE_WHY = {
  HEALTHY_BASELINE: "Normal connectivity is healthy, so this run is a differential capability analysis rather than a fault hunt.",
  FAILED_BASELINE: "The baseline fails consistently, so the useful transition to look for is FAIL to PASS.",
  INTERMITTENT_BASELINE: "The baseline could not be reproduced consistently, so isolation is refused rather than guessed."
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

const host = mount("bisect");
if (host) host.innerHTML = `
  <div class="fl-view-head">
    <div>
      <p class="fl-body fl-prose">
        Forms competing explanations for what the network is doing, then runs the controlled
        experiment that best separates them — stopping as soon as the evidence has isolated a
        boundary. Nothing on this machine is reconfigured: every condition is applied per connection.
      </p>
    </div>
    <div class="fl-view-head-actions">
      <span class="fl-source" data-kind="measured">Measured locally</span>
    </div>
  </div>

  <form class="fl-controlbar" id="bisect-form">
    <div class="fl-control-group" style="flex:0 1 460px;min-width:260px">
      <span class="fl-label">Target</span>
      <input class="fl-input fl-input-mono" type="text" id="bisect-target" style="flex:1"
             placeholder="example.com · 1.1.1.1 · https://example.com/health"
             autocomplete="off" spellcheck="false" value="example.com" />
    </div>
    <div class="fl-control-group">
      <span class="fl-label">Repeat</span>
      <input class="fl-input fl-input-mono" type="number" id="bisect-repeat" min="1" max="10" value="3" style="width:56px;text-align:center" />
    </div>
    <div class="fl-control-group">
      <span class="fl-label">Strategy</span>
      <div class="fl-segmented" id="bisect-mode">
        <button type="button" data-mode="adaptive" aria-pressed="true">Adaptive</button>
        <button type="button" data-mode="exhaustive" aria-pressed="false">Full matrix</button>
      </div>
    </div>
    <div class="fl-spacer"></div>
    <button class="fl-btn fl-btn-primary" type="submit" id="bisect-run">Isolate</button>
  </form>

  <p class="fl-status-line" id="bisect-status"></p>
  <div id="bisect-results"></div>
`;

const form = host?.querySelector("#bisect-form");
const targetInput = host?.querySelector("#bisect-target");
const repeatInput = host?.querySelector("#bisect-repeat");
const modeGroup = host?.querySelector("#bisect-mode");
const runButton = host?.querySelector("#bisect-run");
const statusLine = host?.querySelector("#bisect-status");
const results = host?.querySelector("#bisect-results");

let mode = "adaptive";
// Hidden input kept for the legacy `#bisect-all` contract.
const allProxy = { checked: false };

modeGroup?.addEventListener("click", event => {
  const button = event.target.closest("button[data-mode]");
  if (!button) return;
  mode = button.dataset.mode;
  allProxy.checked = mode === "exhaustive";
  for (const b of modeGroup.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === button));
});

function idleState() {
  if (!results) return;
  results.innerHTML = auth.unlocked
    ? `<section class="fl-panel">${state({
        icon: "⑂",
        title: "No isolation run yet",
        body: "Enter a target and run an isolation. Faultline will make real connections from this machine, varying one condition at a time, and report which condition changes the outcome.",
        actions: `<button class="fl-btn fl-btn-primary" type="button" data-run-bisect>Isolate now</button>`
      })}</section>`
    : `<section class="fl-panel">${auth.lockedState("Running an isolation from the dashboard")}</section>`;
}
idleState();
window.addEventListener("faultline-auth-changed", () => { if (!results?.dataset.hasResult) idleState(); });
results?.addEventListener("click", event => {
  if (event.target.closest("[data-run-bisect]")) form?.requestSubmit();
});

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function renderVerdict(report) {
  const v = report.verdict || {};
  const kind = v.classification || v.kind || "";
  const status = VERDICT_STATUS[kind] || "idle";
  const k = report.counters || {};

  const tiles = report.mode === "adaptive"
    ? [
        { label: "Experiments run", value: String(k.executed ?? 0), sub: `${k.skipped ?? 0} skipped as low-value` },
        { label: "Inapplicable", value: String(k.inapplicable ?? 0), sub: "no route or unsupported" },
        { label: "Connections", value: String(k.connections ?? 0), sub: "real attempts made" },
        { label: "Stopped because", value: String(v.stop || "—").replace(/_/g, " ").toLowerCase(), sub: "termination reason", status }
      ]
    : [{ label: "Connections", value: String(report.trialCount ?? 0), sub: "full condition matrix" }];

  return `
    <section class="fl-panel" data-status="${escapeHtml(status)}">
      <header class="fl-panel-head">
        <div>
          <span class="fl-label">${escapeHtml(VERDICT_LABEL[kind] || "Result")}</span>
          <h3 class="fl-panel-title">${escapeHtml(v.headline || "")}</h3>
        </div>
      </header>
      <div class="fl-panel-body">
        ${v.claim ? `<p class="bisect-claim">${escapeHtml(v.claim)}</p>` : ""}
        ${v.detail ? `<p class="fl-body fl-prose">${escapeHtml(v.detail)}</p>` : ""}
        ${v.workaround ? `<p class="fl-body fl-prose" style="margin-top:8px">${escapeHtml(v.workaround)}</p>` : ""}
        ${v.recommendation ? `<p class="fl-body fl-prose" style="margin-top:8px">${escapeHtml(v.recommendation)}</p>` : ""}
        <div class="fl-tiles" style="margin-top:16px">${tiles.map(tile).join("")}</div>
      </div>
      ${report.evidence?.note ? `<footer class="fl-panel-foot"><span>${escapeHtml(report.evidence.note)}</span></footer>` : ""}
    </section>`;
}

// ---------------------------------------------------------------------------
// Experiment path — the transcript as a timeline
// ---------------------------------------------------------------------------
// This is the part of the product that makes the reasoning inspectable, so it
// gets the timeline treatment rather than a table: each step is a decision,
// and the "why" line is the decision's justification.

function pathItems(report) {
  const items = [];
  const b = report.baseline || {};

  items.push({
    when: "Baseline",
    title: `Baseline ${b.passes ?? "?"}/${b.total ?? "?"}`,
    why: BASELINE_WHY[b.state] || b.reason || "",
    result: b.result,
    detail: b.reason || ""
  });

  let n = 0;
  for (const step of report.transcript || []) {
    // The engine emits a step when it forms or re-scopes the explanation set.
    // It is the reason the run took the shape it did, so it belongs in the
    // narrative rather than only in the collapsed hypothesis table.
    if (step.kind === "hypotheses") {
      items.push({ when: "Explanations", title: step.action, why: step.detail, result: null, count: step.live?.length });
    }
    if (step.kind === "experiment") {
      items.push({ when: `Experiment ${++n}`, title: step.action, why: step.why, result: step.result, detail: step.detail });
    }
    if (step.kind === "confirmation") {
      items.push({ when: "Confirm", title: step.action, why: step.why, result: step.result, sequence: step.detail });
    }
  }

  const v = report.verdict || {};
  items.push({ when: "Conclusion", title: v.headline || "", result: v.classification, terminal: true });
  return items;
}

function renderPath(report) {
  const items = pathItems(report);
  return panel({
    label: "Reasoning",
    title: "Experiment path",
    meta: `<span class="fl-meta">${items.length} steps</span>`,
    body: `<div class="fl-timeline">${items.map(item => `
      <div class="fl-tl-item">
        <span class="fl-tl-when">${escapeHtml(item.when)}</span>
        <span class="fl-tl-rail"><span class="fl-tl-node" data-status="${escapeHtml(item.terminal ? "info" : statusOf(item.result))}"${item.terminal ? " data-terminal" : ""}></span></span>
        <div class="fl-tl-body">
          <p class="fl-tl-title">${escapeHtml(item.title)}</p>
          ${item.why ? `<p class="fl-tl-why">${escapeHtml(item.why)}</p>` : ""}
          <div class="fl-tl-out">
            ${item.terminal
              ? badge(String(item.result || "").replace(/_/g, " "), VERDICT_STATUS[item.result] || "idle")
              : item.result ? stateBadge(item.result)
              : item.count != null ? badge(`${item.count} in play`, "info")
              : ""}
            ${item.sequence ? `<span class="bisect-seq">${escapeHtml(item.sequence)}</span>` : ""}
            ${item.detail && !item.sequence ? `<span class="fl-tl-why" style="margin:0">${escapeHtml(item.detail)}</span>` : ""}
          </div>
        </div>
      </div>`).join("")}</div>`,
    foot: `<span>Each step is a set of real connections. Confirmation interleaves A/B so a network that recovers mid-run shows as unconfirmed rather than as a cure.</span>`
  });
}

// ---------------------------------------------------------------------------
// Explanations
// ---------------------------------------------------------------------------

const HYPOTHESIS_ORDER = { SUPPORTED: 0, STILL_POSSIBLE: 1, WEAKENED: 2, NOT_TESTABLE: 3, CONTRADICTED: 4 };

function hypothesisRows(list) {
  return `<div class="fl-table-wrap"><table class="fl-table fl-table-compact">
    <thead><tr><th style="width:140px">State</th><th>Explanation</th></tr></thead>
    <tbody>${list.map(h => `<tr>
      <td>${stateBadge(h.state)}</td>
      <td>
        <span class="bisect-hyp-label">${escapeHtml(h.label)}</span>
        ${h.notes?.length ? `<span class="bisect-note">${escapeHtml(h.notes[h.notes.length - 1])}</span>` : ""}
      </td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderHypotheses(report) {
  const list = report.hypotheses || [];
  if (!list.length) return "";
  const sorted = [...list].sort((a, b) => (HYPOTHESIS_ORDER[a.state] ?? 9) - (HYPOTHESIS_ORDER[b.state] ?? 9));

  // A run that concludes cleanly contradicts most of what it started with, so
  // showing all thirteen at equal weight buries the one that survived under a
  // wall of struck-through text. The eliminated ones are the audit trail, not
  // the answer: they go behind a disclosure.
  const live = sorted.filter(h => h.state === "SUPPORTED" || h.state === "STILL_POSSIBLE" || h.state === "WEAKENED");
  const eliminated = sorted.filter(h => !live.includes(h));

  return panel({
    label: "Competing explanations",
    title: "What the evidence left standing",
    meta: `<span class="fl-meta">${live.length} of ${list.length} still live</span>`,
    flush: true,
    body: `${live.length ? hypothesisRows(live) : ""}
      ${eliminated.length ? `<div style="padding:0 16px">${disclose(
        `Eliminated explanations (${eliminated.length})`,
        hypothesisRows(eliminated)
      )}</div>` : ""}`,
    foot: `<span>No probabilities and no model. A hypothesis moves only on a PASS or FAIL that it predicted.</span>`
  });
}

// ---------------------------------------------------------------------------
// Progressive disclosure
// ---------------------------------------------------------------------------

function renderDetail(report) {
  const blocks = [];

  const interfaces = report.interfaces || [];
  if (interfaces.length >= 2) {
    blocks.push(disclose(`Local interfaces (${interfaces.length})`, `<div class="fl-table-wrap"><table class="fl-table fl-table-compact">
      <thead><tr><th>Interface</th><th>Address</th><th>Classification</th><th>Route to target</th></tr></thead>
      <tbody>${interfaces.map(i => `<tr>
        <td>${escapeHtml(i.name)}</td>
        <td class="fl-mono">${escapeHtml(i.address)}</td>
        <td>${badge(i.classification, "idle")}</td>
        <td>${i.routeSupport === "NO_ROUTE" ? badge("No route", "idle") : badge("Route ok", "ok")}</td>
      </tr>`).join("")}</tbody></table></div>`));
  }

  const skipped = report.skipped || [];
  if (skipped.length) {
    blocks.push(disclose(`Experiments not run (${skipped.length})`, `<div class="fl-table-wrap"><table class="fl-table fl-table-compact">
      <thead><tr><th>Condition</th><th>Variant</th><th>Why it was skipped</th></tr></thead>
      <tbody>${skipped.map(s => `<tr>
        <td>${escapeHtml(s.axisLabel)}</td><td>${escapeHtml(s.label)}</td><td>${escapeHtml(s.reason)}</td>
      </tr>`).join("")}</tbody></table></div>`));
  }

  const executed = report.executed || [];
  if (executed.length) {
    blocks.push(disclose(`All executed experiments (${executed.length})`, `<div class="fl-table-wrap"><table class="fl-table fl-table-compact">
      <thead><tr><th>Condition</th><th>Variant</th><th>Result</th><th class="fl-right">n</th><th class="fl-right">Score</th><th>Detail</th></tr></thead>
      <tbody>${executed.map(r => `<tr>
        <td>${escapeHtml(r.axisLabel)}</td>
        <td>${escapeHtml(r.label)}</td>
        <td>${stateBadge(r.result)}</td>
        <td class="fl-right">${escapeHtml(r.passes)}/${escapeHtml(r.total)}</td>
        <td class="fl-right">${escapeHtml(r.selectionScore ?? "—")}</td>
        <td>${escapeHtml(r.stage ? `${r.stage}: ` : "")}${escapeHtml(r.reason || "")}</td>
      </tr>`).join("")}</tbody></table></div>`));
  }

  if (!blocks.length) return "";
  return panel({ label: "Full record", title: "Everything the run considered", body: blocks.join("") });
}

// ---------------------------------------------------------------------------
// Exhaustive mode
// ---------------------------------------------------------------------------

function renderExhaustive(report) {
  const rows = report.conditions || [];
  return renderVerdict(report) + panel({
    label: "Capability audit",
    title: "Full condition matrix",
    meta: `<span class="fl-meta">${rows.length} conditions</span>`,
    flush: true,
    body: `<div class="fl-table-wrap"><table class="fl-table">
      <thead><tr><th>Condition</th><th>Variant</th><th>Result</th><th class="fl-right">n</th><th>Detail</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${escapeHtml(r.axisId === "__baseline__" ? "baseline" : r.axisLabel)}</td>
        <td>${escapeHtml(r.label)}</td>
        <td>${stateBadge(r.outcome)}</td>
        <td class="fl-right">${escapeHtml(r.passes)}/${escapeHtml(r.total)}</td>
        <td>${escapeHtml(r.stage ? `${r.stage}: ` : "")}${escapeHtml(r.reason || "")}</td>
      </tr>`).join("")}</tbody>
    </table></div>`
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function setStatus(text, tone = "") {
  if (!statusLine) return;
  statusLine.textContent = text;
  if (tone) statusLine.dataset.tone = tone;
  else delete statusLine.dataset.tone;
}

form?.addEventListener("submit", async event => {
  event.preventDefault();
  const target = targetInput.value.trim();
  if (!target) return;
  const exhaustive = mode === "exhaustive";

  if (!auth.unlocked) {
    setStatus(`Unlock live data with the Faultline admin credential first. The CLI needs no credential: npm run bisect -- ${target}`, "error");
    document.getElementById("auth-open")?.click();
    return;
  }

  runButton.disabled = true;
  results.dataset.hasResult = "1";
  results.innerHTML = `<section class="fl-panel">${state({
    icon: "⑂",
    title: exhaustive ? "Running the full condition matrix" : "Choosing experiments",
    body: exhaustive
      ? "Every available condition is being tested. This makes many real connections and can take a minute."
      : "Forming explanations and running the experiment that best separates them. Each step is a set of real connections."
  })}</section>`;
  setStatus(exhaustive ? "Running the complete condition matrix…" : "Forming explanations and choosing experiments…");

  try {
    const response = await fetch("/api/bisect", {
      method: "POST", cache: "no-store",
      headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
      body: JSON.stringify({ target, repeat: Number(repeatInput.value) || 3, mode: exhaustive ? "exhaustive" : "adaptive" })
    });
    const report = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(report.error || `Faultline returned HTTP ${response.status}.`);

    results.innerHTML = report.mode === "adaptive"
      ? renderVerdict(report) + `<div class="fl-grid"><div class="fl-col-7">${renderPath(report)}</div><div class="fl-col-5">${renderHypotheses(report)}</div></div>` + renderDetail(report)
      : renderExhaustive(report);

    const k = report.counters;
    setStatus(k
      ? `${k.executed} experiments executed, ${k.skipped} skipped as low-value, ${k.inapplicable} inapplicable — ${k.connections} real connections.`
      : `${report.trialCount} connection attempts.`, "ok");
    window.dispatchEvent(new CustomEvent("faultline-bisect-result", { detail: report }));
  } catch (error) {
    results.innerHTML = `<section class="fl-panel">${state({
      icon: "!", tone: "error",
      title: "The isolation run could not complete",
      body: error.message,
      actions: `<button class="fl-btn" type="button" data-run-bisect>Try again</button>`
    })}</section>`;
    setStatus(error.message, "error");
  } finally {
    runButton.disabled = false;
  }
});

// Two rules that are genuinely local to this screen.
const style = document.createElement("style");
style.textContent = `
  .bisect-claim { margin: 0 0 8px; font-size: var(--fl-fs-base); font-weight: 550; color: var(--fl-text); line-height: 1.5; }
  .bisect-seq { font-family: var(--fl-mono); font-size: var(--fl-fs-micro); color: var(--fl-text-2); letter-spacing: .14em; }
  .bisect-hyp-label { display: block; color: var(--fl-text); }
  /* The engine's note explains why a hypothesis moved. It is a second line, not
     a continuation of the label, or the two run together into one sentence. */
  .bisect-note { display: block; margin-top: 2px; font-size: var(--fl-fs-micro); color: var(--fl-text-3); line-height: 1.5; }
  .fl-table-compact td { padding-top: 6px; padding-bottom: 6px; height: auto; }
`;
document.head.appendChild(style);
