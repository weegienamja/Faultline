// Network Bisect dashboard panel.
//
// Organised around the reasoning, not the data. The default view answers
// "what did it conclude and how did it get there"; the full condition table is
// available behind a toggle. The experiment graph is generated from the actual
// transcript, so it always reflects the decisions the engine really made.

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function installStyles() {
  const style = document.createElement("style");
  style.textContent = `
  .bisect-panel{margin-bottom:13px;border-color:rgba(122,170,255,.3)}
  .bisect-form{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;align-items:stretch}
  .bisect-form input[type=text]{flex:1 1 280px;min-width:200px;border:1px solid var(--border);border-radius:9px;background:var(--bg);color:var(--text);padding:11px 12px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;outline:none}
  .bisect-form input[type=text]:focus{border-color:rgba(122,170,255,.5)}
  .bisect-form label{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:10px}
  .bisect-form input[type=number]{width:52px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);padding:9px;font:11px ui-monospace,monospace;outline:none}
  .bisect-status{margin:12px 0 0;color:var(--muted);font-size:11px;line-height:1.55;min-height:16px}
  .bisect-status.error{color:var(--danger)}
  .bpill{border-radius:999px;padding:3px 8px;font-size:8px;text-transform:uppercase;letter-spacing:.08em;border:1px solid var(--border);color:var(--muted);white-space:nowrap;display:inline-block}
  .bpill.PASS{color:var(--accent);border-color:rgba(97,230,184,.4);background:var(--accent-soft)}
  .bpill.FAIL{color:var(--danger);border-color:rgba(255,122,104,.36);background:rgba(255,122,104,.06)}
  .bpill.UNSTABLE{color:var(--warn);border-color:rgba(241,184,91,.36);background:rgba(241,184,91,.07)}
  .bpill.INAPPLICABLE,.bpill.UNSUPPORTED{color:#5f7670}
  .bverdict{border:1px solid rgba(122,170,255,.32);border-radius:11px;padding:15px;background:rgba(122,170,255,.06);margin-top:16px}
  .bverdict h3{margin:5px 0 8px;font-size:16px}
  .bverdict p{margin:0 0 8px;color:#bbcbc6;font-size:11px;line-height:1.6}
  .bverdict .claim{color:#8fb6ff;font-weight:600}
  .bverdict.FAILURE_DISCRIMINATOR,.bverdict.WORKAROUND_CANDIDATE{border-color:rgba(97,230,184,.35);background:var(--accent-soft)}
  .bverdict.FAILURE_DISCRIMINATOR .claim{color:var(--accent)}
  .bverdict.UNSTABLE_BASELINE,.bverdict.INSUFFICIENT_EVIDENCE,.bverdict.LOCAL_CAPABILITY_DEFICIENCY{border-color:rgba(241,184,91,.35);background:rgba(241,184,91,.06)}
  .bcounts{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}
  .bcount{border:1px solid var(--border-soft);border-radius:9px;padding:8px 11px;min-width:74px}
  .bcount strong{display:block;font-size:16px;line-height:1.2}
  .bcount small{color:var(--muted);font-size:8px;text-transform:uppercase;letter-spacing:.08em}
  .bgraph{margin-top:16px;border:1px solid var(--border-soft);border-radius:11px;padding:14px;background:rgba(255,255,255,.012)}
  .bnode{display:grid;grid-template-columns:118px 1fr;gap:11px;align-items:start;padding:9px 0}
  .bnode + .bnode{border-top:1px dashed rgba(139,160,154,.18)}
  .bnode-mark{font-family:ui-monospace,monospace;font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;padding-top:2px}
  .bnode strong{font-size:12px;display:block}
  .bnode .why{color:#617871;font-size:10px;line-height:1.5;margin-top:4px;display:block}
  .bnode .out{margin-top:5px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .bseq{font-family:ui-monospace,monospace;font-size:11px;color:#adc0ba;letter-spacing:.16em}
  .bskip{margin-top:12px}
  .bskip summary{cursor:pointer;color:var(--muted);font-size:10px;list-style:none}
  .bskip summary::-webkit-details-marker{display:none}
  .bskip summary:before{content:"▸ ";color:#5f7670}
  .bskip[open] summary:before{content:"▾ "}
  .bskip-item{display:grid;grid-template-columns:200px 1fr;gap:10px;padding:5px 0;font-size:10px;color:#8ba09a}
  .bskip-item span:first-child{font-family:ui-monospace,monospace;color:#adc0ba}
  .biface{display:grid;grid-template-columns:1fr auto auto;gap:8px;padding:6px 0;border-top:1px solid var(--border-soft);font-size:10px;align-items:center}
  .biface:first-of-type{border-top:0}
  .bhyp{display:grid;grid-template-columns:150px 1fr;gap:10px;padding:5px 0;font-size:10px}
  .bhyp span:first-child{font-size:8px;text-transform:uppercase;letter-spacing:.07em}
  .bhyp .SUPPORTED{color:var(--accent)}
  .bhyp .CONTRADICTED{color:#5f7670;text-decoration:line-through}
  .bhyp .WEAKENED{color:var(--warn)}
  .bhyp .NOT_TESTABLE{color:#5f7670}
  .btable{width:100%;border-collapse:collapse;margin-top:10px;font-size:10px}
  .btable th{text-align:left;color:var(--muted);font-size:8px;text-transform:uppercase;letter-spacing:.08em;padding:0 8px 6px 0}
  .btable td{padding:6px 8px 6px 0;border-top:1px solid var(--border-soft)}
  .bnote{color:#617871;font-size:9px;line-height:1.55;margin-top:11px;border-top:1px solid var(--border-soft);padding-top:9px}
  @media(max-width:700px){.bnode{grid-template-columns:1fr}.bskip-item{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
}

installStyles();

const anchor = document.getElementById("live-diagnostic") || document.querySelector(".incident-strip");
const panel = document.createElement("section");
panel.className = "panel bisect-panel";
panel.id = "network-bisect";
panel.innerHTML = `
  <div style="display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap">
    <div>
      <span class="section-label">ADAPTIVE FAULT ISOLATION</span>
      <h3 style="margin:4px 0 0">Network Bisect</h3>
      <p style="margin:6px 0 0;color:var(--muted);font-size:11px;line-height:1.55;max-width:76ch">
        Forms competing explanations for what the network is doing, then runs the controlled experiment
        that best separates them &mdash; stopping when the evidence has isolated a boundary. Nothing on
        this machine is reconfigured; every condition is applied per connection.
      </p>
    </div>
    <span class="src-badge src-local">LOCAL</span>
  </div>

  <form class="bisect-form" id="bisect-form">
    <input type="text" id="bisect-target" placeholder="example.com · 1.1.1.1 · https://example.com/health"
           autocomplete="off" spellcheck="false" value="example.com" />
    <label>repeat <input type="number" id="bisect-repeat" min="1" max="10" value="3" /></label>
    <label><input type="checkbox" id="bisect-all" /> full matrix</label>
    <button class="primary-button" type="submit" id="bisect-run">Isolate</button>
  </form>
  <p class="bisect-status" id="bisect-status"></p>
  <div id="bisect-results"></div>
`;
anchor?.parentNode?.insertBefore(panel, anchor.nextSibling);

const form = panel.querySelector("#bisect-form");
const targetInput = panel.querySelector("#bisect-target");
const repeatInput = panel.querySelector("#bisect-repeat");
const allInput = panel.querySelector("#bisect-all");
const runButton = panel.querySelector("#bisect-run");
const statusLine = panel.querySelector("#bisect-status");
const results = panel.querySelector("#bisect-results");

const token = () => sessionStorage.getItem("faultlineAdminToken") || "";
const pill = result => `<span class="bpill ${escapeHtml(result)}">${escapeHtml(result)}</span>`;

// --------------------------------------------------------------------------
// Experiment graph, generated from the transcript
// --------------------------------------------------------------------------

function renderGraph(report) {
  const nodes = [];
  const b = report.baseline;
  nodes.push({
    mark: "BASELINE",
    title: `Baseline ${b.passes}/${b.total}`,
    why: b.state === "HEALTHY_BASELINE"
      ? "Normal connectivity is healthy, so this run is a differential capability analysis rather than a fault hunt."
      : b.state === "FAILED_BASELINE"
        ? "The baseline fails consistently, so the useful transition to look for is FAIL to PASS."
        : "The baseline could not be reproduced consistently.",
    result: b.result, detail: b.reason || ""
  });

  for (const step of report.transcript || []) {
    if (step.kind === "experiment") {
      nodes.push({ mark: `EXPERIMENT ${nodes.filter(n => n.mark.startsWith("EXPERIMENT")).length + 1}`, title: step.action, why: step.why, result: step.result, detail: step.detail });
    }
    if (step.kind === "confirmation") {
      nodes.push({ mark: "CONFIRM", title: step.action, why: step.why, sequence: step.detail, result: step.result });
    }
  }

  const v = report.verdict || {};
  nodes.push({ mark: "CONCLUSION", title: v.headline || "", why: null, result: v.classification, terminal: true });

  return `<div class="bgraph">
    <span class="section-label">EXPERIMENT PATH</span>
    ${nodes.map(n => `<div class="bnode">
      <span class="bnode-mark">${escapeHtml(n.mark)}</span>
      <div>
        <strong>${escapeHtml(n.title)}</strong>
        ${n.why ? `<span class="why">${escapeHtml(n.why)}</span>` : ""}
        <span class="out">
          ${n.terminal ? `<span class="bpill">${escapeHtml(n.result || "")}</span>` : pill(n.result)}
          ${n.detail ? `<span class="why" style="margin:0">${escapeHtml(n.detail)}</span>` : ""}
          ${n.sequence ? `<span class="bseq">${escapeHtml(n.sequence)}</span>` : ""}
        </span>
      </div>
    </div>`).join("")}
  </div>`;
}

function renderCounts(report) {
  const k = report.counters || {};
  const cells = [
    ["executed", k.executed ?? 0], ["skipped", k.skipped ?? 0],
    ["inapplicable", k.inapplicable ?? 0], ["connections", k.connections ?? 0]
  ];
  return `<div class="bcounts">${cells.map(([label, value]) =>
    `<div class="bcount"><strong>${escapeHtml(value)}</strong><small>${escapeHtml(label)}</small></div>`).join("")}</div>`;
}

function renderVerdict(report) {
  const v = report.verdict || {};
  const banner = {
    FAILURE_DISCRIMINATOR: "FAILURE CONDITION ISOLATED",
    WORKAROUND_CANDIDATE: "WORKAROUND IDENTIFIED",
    LOCAL_CAPABILITY_DEFICIENCY: "CAPABILITY DIFFERENCE",
    TARGET_PROPERTY: "TARGET PROPERTY",
    NO_MEANINGFUL_DIFFERENCE: "NO MEANINGFUL DIFFERENCE",
    UNSTABLE_BASELINE: "UNSTABLE BASELINE",
    INAPPLICABLE_CONDITION: "NOT APPLICABLE",
    INSUFFICIENT_EVIDENCE: "INSUFFICIENT EVIDENCE"
  }[v.classification] || v.classification || "RESULT";

  return `<div class="bverdict ${escapeHtml(v.classification || "")}">
    <span class="section-label">${escapeHtml(banner)}</span>
    <h3>${escapeHtml(v.headline || "")}</h3>
    <p>${escapeHtml(v.detail || "")}</p>
    ${v.claim ? `<p class="claim">${escapeHtml(v.claim)}</p>` : ""}
    ${v.workaround ? `<p>${escapeHtml(v.workaround)}</p>` : ""}
    ${v.recommendation ? `<p>${escapeHtml(v.recommendation)}</p>` : ""}
    ${renderCounts(report)}
    <p class="bnote">Stopping reason: ${escapeHtml(v.stop || v.kind || "-")}. ${escapeHtml(report.evidence?.note || "")}</p>
  </div>`;
}

function renderInterfaces(report) {
  const list = report.interfaces || [];
  if (list.length < 2) return "";
  return `<details class="bskip"><summary>Local interfaces (${list.length})</summary>
    ${list.map(i => `<div class="biface">
      <span><strong>${escapeHtml(i.name)}</strong> <span style="color:#8ba09a;font-family:ui-monospace,monospace">${escapeHtml(i.address)}</span></span>
      <span class="bpill">${escapeHtml(i.classification)}</span>
      <span class="bpill ${i.routeSupport === "NO_ROUTE" ? "INAPPLICABLE" : ""}">${escapeHtml(i.routeSupport === "NO_ROUTE" ? "no target route" : "route ok")}</span>
    </div>`).join("")}</details>`;
}

function renderHypotheses(report) {
  const list = report.hypotheses || [];
  if (!list.length) return "";
  const order = { SUPPORTED: 0, STILL_POSSIBLE: 1, WEAKENED: 2, NOT_TESTABLE: 3, CONTRADICTED: 4 };
  const sorted = [...list].sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9));
  return `<details class="bskip"><summary>Explanations considered (${list.length})</summary>
    ${sorted.map(h => `<div class="bhyp">
      <span class="${escapeHtml(h.state)}">${escapeHtml(h.state.replace(/_/g, " "))}</span>
      <span>${escapeHtml(h.label)}${h.notes?.length ? `<br><span style="color:#617871">${escapeHtml(h.notes[h.notes.length - 1])}</span>` : ""}</span>
    </div>`).join("")}</details>`;
}

function renderSkipped(report) {
  const list = report.skipped || [];
  if (!list.length) return "";
  return `<details class="bskip"><summary>Experiments not run (${list.length})</summary>
    ${list.map(s => `<div class="bskip-item">
      <span>${escapeHtml(s.axisLabel)}: ${escapeHtml(s.label)}</span>
      <span>${escapeHtml(s.reason)}</span>
    </div>`).join("")}</details>`;
}

function renderExecutedTable(report) {
  const rows = report.executed || [];
  if (!rows.length) return "";
  return `<details class="bskip"><summary>All executed experiments (${rows.length})</summary>
    <table class="btable">
      <thead><tr><th>Condition</th><th>Variant</th><th>Result</th><th>n</th><th>Score</th><th>Detail</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${escapeHtml(r.axisLabel)}</td><td>${escapeHtml(r.label)}</td>
        <td>${pill(r.result)}</td><td>${escapeHtml(r.passes)}/${escapeHtml(r.total)}</td>
        <td>${escapeHtml(r.selectionScore ?? "-")}</td>
        <td>${escapeHtml(r.stage ? `${r.stage}: ` : "")}${escapeHtml(r.reason || "")}</td>
      </tr>`).join("")}</tbody>
    </table></details>`;
}

// Exhaustive mode keeps the original full condition table.
function renderExhaustive(report) {
  const rows = report.conditions || [];
  const v = report.verdict || {};
  return `<div class="bverdict ${escapeHtml(v.kind || "")}">
      <span class="section-label">FULL CONDITION MATRIX</span>
      <h3>${escapeHtml(v.headline || "")}</h3>
      <p>${escapeHtml(v.detail || "")}</p>
      ${v.claim ? `<p class="claim">${escapeHtml(v.claim)}</p>` : ""}
      <p class="bnote">${escapeHtml(report.trialCount)} connection attempts across every available condition.</p>
    </div>
    <table class="btable">
      <thead><tr><th>Condition</th><th>Variant</th><th>Result</th><th>n</th><th>Detail</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${escapeHtml(r.axisId === "__baseline__" ? "baseline" : r.axisLabel)}</td>
        <td>${escapeHtml(r.label)}</td>
        <td><span class="bpill ${escapeHtml(String(r.outcome).toUpperCase())}">${escapeHtml(r.outcome)}</span></td>
        <td>${escapeHtml(r.passes)}/${escapeHtml(r.total)}</td>
        <td>${escapeHtml(r.stage ? `${r.stage}: ` : "")}${escapeHtml(r.reason || "")}</td>
      </tr>`).join("")}</tbody>
    </table>`;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const target = targetInput.value.trim();
  if (!target) return;
  const exhaustive = allInput.checked;

  if (!token()) {
    statusLine.classList.add("error");
    statusLine.textContent = `Unlock live data with the Faultline admin credential first. The CLI needs no credential: npm run bisect -- ${target}`;
    document.getElementById("auth-open")?.click();
    return;
  }

  runButton.disabled = true;
  statusLine.classList.remove("error");
  results.innerHTML = "";
  const repeat = Number(repeatInput.value) || 3;
  statusLine.textContent = exhaustive
    ? "Running the complete condition matrix. This makes many real connections and can take a minute…"
    : "Forming explanations and choosing experiments. Each step is a set of real connections…";

  try {
    const response = await fetch("/api/bisect", {
      method: "POST", cache: "no-store",
      headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
      body: JSON.stringify({ target, repeat, mode: exhaustive ? "exhaustive" : "adaptive" })
    });
    const report = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(report.error || `Faultline returned HTTP ${response.status}.`);

    results.innerHTML = report.mode === "adaptive"
      ? renderVerdict(report) + renderGraph(report) + renderInterfaces(report) + renderHypotheses(report) + renderSkipped(report) + renderExecutedTable(report)
      : renderExhaustive(report);

    const k = report.counters;
    statusLine.textContent = k
      ? `${k.executed} experiments executed, ${k.skipped} skipped as low-value, ${k.inapplicable} inapplicable — ${k.connections} connections.`
      : `${report.trialCount} connection attempts.`;
    window.dispatchEvent(new CustomEvent("faultline-bisect-result", { detail: report }));
  } catch (error) {
    statusLine.classList.add("error");
    statusLine.textContent = error.message;
  } finally {
    runButton.disabled = false;
  }
});
