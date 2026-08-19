// Single-file offline capsule renderer.
//
// Produces one .html file that opens from file:// on a machine that has never
// had Faultline installed, with no server, no API, no Internet and no external
// CSS, JavaScript, fonts or images.
//
// SAFETY: the capsule embeds evidence gathered from the network - SSIDs, target
// strings, hostnames, error text, case notes. All of it is untrusted, and it
// reaches the page two ways, each with its own escape:
//
//   1. As HTML text        -> escapeHtml(), applied at every interpolation.
//   2. As embedded JSON    -> embedJson(), which escapes the sequences that
//                             would otherwise terminate the script element or
//                             open a comment: `<`, `>`, `&`, U+2028/9.
//
// The JSON lives in <script type="application/json">, not a JS literal, so it
// is inert data even if an escape were somehow missed. It is parsed at runtime
// with JSON.parse rather than being executed.
//
// The rendered page contains no network requests of any kind. That is a
// property worth protecting: a capsule that phoned home would leak the very
// evidence it exists to preserve.

import { verifyIntegrity } from "./integrity.mjs";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Serialise JSON for embedding inside a <script> element.
 *
 * `</script>` anywhere in the data would end the element early; `<!--` would
 * open a comment. Escaping the angle brackets and ampersand as unicode escapes
 * keeps the JSON valid and byte-identical after JSON.parse, so the embedded
 * payload still verifies against its own digest.
 */
export function embedJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

const time = value => (value ? String(value).slice(11, 19) : "—");
const date = value => (value ? String(value).slice(0, 10) : "—");

function stateClass(value) {
  const state = String(value ?? "").toUpperCase();
  if (state === "PASS") return "ok";
  if (state === "FAIL") return "crit";
  if (state === "INAPPLICABLE" || state === "UNKNOWN" || state === "NOT-SAMPLED") return "idle";
  return "idle";
}

/**
 * Readable name for an experiment.
 *
 * A source-interface experiment is named after the address it binds to, so a
 * redacted capsule has no label. Falling back to the axis and position keeps
 * "two variants were tried, one passed and one failed" intelligible without
 * restoring the identifier.
 */
function experimentName(entry, index) {
  const label = entry.label;
  if (label && label !== "[redacted]") return label;
  const axis = entry.axisId || entry.axis || "condition";
  return `${axis} · variant ${index + 1}`;
}

function chip(text, kind = "idle") {
  return `<span class="chip ${kind}">${escapeHtml(text)}</span>`;
}

// --- sections ---------------------------------------------------------------

function renderSimulationBanner(capsule) {
  const { provenance, incident } = capsule;
  if (!provenance.containsSimulated) return "";

  const mixed = !provenance.fullySimulated;
  return `<div class="banner sim">
    <h2>Simulated incident</h2>
    <p>
      This capsule contains scripted Flight Recorder samples from scenario
      <code>${escapeHtml(incident.scenario || "unknown")}</code>.
      It does not describe an incident that occurred on a real network.
    </p>
    ${mixed ? `<p class="mixed">
      <strong>Not everything here is simulated.</strong> Each artefact carries its own
      provenance below: the recorder samples were scripted, but any Network Bisect
      experiment listed made real connections and its measurements are real.
    </p>` : ""}
  </div>`;
}

function renderSummary(capsule) {
  const { incident, conclusion, evidence } = capsule;
  const target = incident.target
    ? `${incident.target.host ?? "—"}${incident.target.port ? `:${incident.target.port}` : ""}`
    : "—";

  return `<section class="card summary">
    <div class="summary-grid">
      <div><span class="label">Incident</span><strong class="mono big">${escapeHtml(incident.id)}</strong></div>
      <div><span class="label">Target</span><strong class="mono">${escapeHtml(target)}</strong></div>
      <div><span class="label">Trigger</span><strong>${escapeHtml(incident.trigger?.summary || "—")}</strong></div>
      <div><span class="label">Captured</span><strong class="mono">${escapeHtml(date(incident.trigger?.at))} ${escapeHtml(time(incident.trigger?.at))}</strong></div>
      <div><span class="label">Recovery</span><strong>${evidence.comparison.recovery ? `reachable again at ${escapeHtml(time(evidence.comparison.recovery.at))}` : "not observed"}</strong></div>
      <div><span class="label">Evidence</span><strong>${escapeHtml(String(capsule.provenance.artefacts.length))} artefact(s)</strong></div>
    </div>

    ${conclusion.available
      ? `<div class="conclusion">
           <span class="label">Deterministic conclusion</span>
           <p class="headline">${escapeHtml(conclusion.headline || conclusion.classification || "")}</p>
           <p class="mono small">${escapeHtml(conclusion.classification || "")}</p>
           <div class="split">
             <div><span class="label ok">This establishes</span><p>${escapeHtml(conclusion.establishes)}</p></div>
             <div><span class="label warn">This does not establish</span><p>${escapeHtml(conclusion.doesNotEstablish)}</p></div>
           </div>
         </div>`
      : `<div class="conclusion none">
           <span class="label">No deterministic conclusion</span>
           <p>${escapeHtml(conclusion.reason)}</p>
         </div>`}
  </section>`;
}

function renderTimeline(capsule) {
  if (!capsule.timeline.length) return "";
  return `<section class="card">
    <h2>Timeline</h2>
    <ol class="timeline">
      ${capsule.timeline.map(event => `<li class="tl-${escapeHtml(event.kind)}">
        <span class="mono tl-time">${escapeHtml(time(event.at))}</span>
        <span class="tl-dot"></span>
        <div><strong>${escapeHtml(event.label)}</strong>${event.detail ? `<span class="small">${escapeHtml(event.detail)}</span>` : ""}</div>
      </li>`).join("")}
    </ol>
  </section>`;
}

function renderSample(sample) {
  const c = sample.connectivity || {};
  return `<tr>
    <td class="mono">${escapeHtml(time(sample.at))}</td>
    <td>${chip(c.targetTcp?.state ?? "—", stateClass(c.targetTcp?.state))}${c.targetTcp?.ms !== undefined && c.targetTcp?.ms !== null ? `<span class="mono small"> ${escapeHtml(String(c.targetTcp.ms))} ms</span>` : ""}</td>
    <td>${chip(c.ipv4?.state ?? "—", stateClass(c.ipv4?.state))}</td>
    <td>${chip(c.ipv6?.state ?? "—", stateClass(c.ipv6?.state))}</td>
    <td class="mono small">${escapeHtml(sample.local?.activeInterface ?? "—")}</td>
    <td class="small">${escapeHtml((sample.reasons || []).join("; ") || "—")}</td>
  </tr>`;
}

function renderWindows(capsule) {
  const windows = capsule.evidence.recorder.windows || {};
  const section = (title, entry) => {
    const samples = entry?.samples || [];
    if (!samples.length) return "";
    return `<details class="window"${title === "During" ? " open" : ""}>
      <summary><strong>${escapeHtml(title)}</strong> <span class="small">${samples.length} sample(s)</span></summary>
      <div class="table-wrap"><table>
        <thead><tr><th>Time</th><th>Target</th><th>IPv4</th><th>IPv6</th><th>Interface</th><th>State</th></tr></thead>
        <tbody>${samples.map(renderSample).join("")}</tbody>
      </table></div>
    </details>`;
  };

  return `<section class="card">
    <h2>Before, during and after</h2>
    <p class="small">
      ${capsule.evidence.recorder.simulated
        ? "Scripted samples generated from a scenario file."
        : "Every row is a real measurement taken from the recording machine at the stated time."}
    </p>
    ${section("Before", windows.before)}
    ${section("During", windows.during)}
    ${section("After", windows.after)}
  </section>`;
}

function renderDifferences(capsule) {
  const comparison = capsule.evidence.comparison;
  if (!comparison.comparable) {
    return `<section class="card">
      <h2>Observed differences</h2>
      <p>${escapeHtml(comparison.reason || "No comparison was possible.")}</p>
    </section>`;
  }

  return `<section class="card">
    <h2>Observed differences <span class="count">${escapeHtml(String(comparison.differenceCount))}</span></h2>
    <p class="statement">${escapeHtml(comparison.statement || "")}</p>
    <p class="small warn-text">${escapeHtml(comparison.note || "")}</p>

    ${comparison.groups.map(group => `<div class="group">
      <h3>${escapeHtml(group.group)}</h3>
      <div class="table-wrap"><table>
        <tbody>${group.changes.map(change => `<tr>
          <td class="prop">${escapeHtml(change.property)}</td>
          <td class="mono small">${escapeHtml(String(change.from))}</td>
          <td class="arrow">→</td>
          <td class="mono small">${escapeHtml(String(change.to))}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    </div>`).join("")}
  </section>`;
}

function renderTestable(capsule) {
  const testable = capsule.evidence.testableConditions;
  const experiments = capsule.evidence.experiments;

  return `<section class="card">
    <h2>Testable conditions <span class="count">${escapeHtml(String(testable.count))}</span></h2>

    ${testable.conditions.map(condition => {
      const run = experiments.find(entry => entry.id === condition.experiment?.evidenceId);
      const payload = run?.payload;
      return `<div class="condition">
        <div class="condition-head">
          <strong class="mono">${escapeHtml(condition.axis)}</strong>
          ${condition.tested ? chip("tested", "ok") : chip("not tested", "idle")}
          ${run?.simulated === false && capsule.provenance.containsSimulated ? chip("real measurement", "info") : ""}
        </div>
        ${condition.note ? `<p class="small">${escapeHtml(condition.note)} <span class="mono">${escapeHtml(condition.derivedFrom.join(" · "))}</span></p>` : ""}

        ${payload ? `
          <div class="table-wrap"><table>
            <thead><tr><th>Experiment</th><th>Result</th><th>Trials</th><th>Stage</th></tr></thead>
            <tbody>${(payload.experiments?.executed || []).map((entry, index) => `<tr>
              <td>${escapeHtml(experimentName(entry, index))}</td>
              <td>${chip(entry.result ?? "—", stateClass(entry.result))}</td>
              <td class="mono">${escapeHtml(String(entry.passes ?? "—"))}/${escapeHtml(String(entry.total ?? "—"))}</td>
              <td class="mono small">${escapeHtml(entry.stage ?? "—")}</td>
            </tr>`).join("")}</tbody>
          </table></div>

          ${payload.confirmation ? `<div class="confirmation">
            <span class="label">Paired confirmation</span>
            <p class="mono">${escapeHtml((payload.confirmation.sequence || []).map(step => `${step.arm === "baseline" ? "A" : "B"}${step.verdict === "pass" ? "+" : "-"}`).join(" ") || `${payload.confirmation.pairs} pair(s)`)}</p>
            <p>${payload.confirmation.confirmed ? chip("CONFIRMED DISCRIMINATOR", "ok") : chip("NOT CONFIRMED", "warn")}</p>
          </div>` : ""}

          ${(payload.hypotheses || []).length ? `<details>
            <summary>Hypotheses tracked (${escapeHtml(String(payload.hypotheses.length))})</summary>
            <div class="table-wrap"><table>
              <tbody>${payload.hypotheses.map(entry => `<tr>
                <td>${escapeHtml(entry.label ?? "—")}</td>
                <td>${chip(entry.state ?? "—", entry.state === "CONTRADICTED" ? "idle" : entry.state === "SUPPORTED" ? "ok" : "warn")}</td>
              </tr>`).join("")}</tbody>
            </table></div>
          </details>` : ""}

          <p class="small">Stopping reason <span class="mono">${escapeHtml(payload.stoppingReason ?? "—")}</span></p>
        ` : `<p class="small">No experiment has been run against this condition.</p>`}
      </div>`;
    }).join("")}

    ${testable.untestable.length ? `<div class="group">
      <h3>Observed but not testable</h3>
      <ul>${testable.untestable.map(entry => `<li><strong>${escapeHtml(entry.condition)}</strong><span class="small"> — ${escapeHtml(entry.reason)}</span></li>`).join("")}</ul>
    </div>` : ""}

    ${testable.note ? `<p class="small warn-text">${escapeHtml(testable.note)}</p>` : ""}
  </section>`;
}

function renderDeepCapture(capsule) {
  const deep = capsule.evidence.recorder.deepCapture;
  if (!deep) return "";
  if (deep.available === false) {
    return `<section class="card"><h2>Deep capture</h2><p class="small">${escapeHtml(deep.reason || "No deeper diagnostic was captured.")}</p></section>`;
  }

  return `<section class="card">
    <h2>Deep capture</h2>
    <p class="small">One heavyweight diagnostic, run once at the trigger.</p>
    <div class="table-wrap"><table>
      <tbody>${(deep.stages || []).map(stage => `<tr>
        <td class="prop">${escapeHtml(stage.name)}</td>
        <td>${chip(stage.state ?? "—", stateClass(stage.state === "pass" ? "PASS" : stage.state === "fail" ? "FAIL" : "IDLE"))}</td>
        <td class="mono small">${stage.ms === null || stage.ms === undefined ? "—" : `${escapeHtml(String(stage.ms))} ms`}</td>
        <td class="small">${escapeHtml(stage.detail ?? "")}</td>
      </tr>`).join("")}</tbody>
    </table></div>
    ${deep.external?.meaning ? `<p class="small">${escapeHtml(deep.external.meaning)}</p>` : ""}
  </section>`;
}

function renderInterpretation(capsule) {
  const interpretation = capsule.evidence.interpretation;
  if (!interpretation) return "";
  return `<section class="card interpretation">
    <h2>Analyst interpretation</h2>
    <p class="small warn-text">${escapeHtml(interpretation.note)}</p>
    ${interpretation.answer ? `<p>${escapeHtml(interpretation.answer)}</p>` : ""}
  </section>`;
}

function renderProvenance(capsule) {
  return `<section class="card">
    <h2>Provenance and raw evidence</h2>

    <div class="table-wrap"><table>
      <thead><tr><th>Artefact</th><th>Kind</th><th>Evidence class</th><th>Provenance</th></tr></thead>
      <tbody>${capsule.provenance.artefacts.map(entry => `<tr>
        <td class="mono">${escapeHtml(entry.id)}</td>
        <td class="small">${escapeHtml(entry.kind)}</td>
        <td>${chip(entry.evidenceClass, entry.evidenceClass === "simulated" ? "warn" : "idle")}</td>
        <td>${entry.simulated ? chip(`simulated · ${entry.scenario || "scenario"}`, "warn") : chip("measured", "ok")}</td>
      </tr>`).join("")}</tbody>
    </table></div>

    <h3>What each evidence class means</h3>
    <dl class="classes">
      ${Object.entries(capsule.provenance.evidenceClasses).map(([name, meaning]) =>
        `<dt class="mono">${escapeHtml(name)}</dt><dd>${escapeHtml(meaning)}</dd>`).join("")}
    </dl>

    <h3>Redaction</h3>
    <p><strong class="mono">${escapeHtml(capsule.redaction.mode)}</strong> — ${escapeHtml(capsule.redaction.note)}</p>
    ${capsule.redaction.applied ? `<p class="small">${escapeHtml(capsule.redaction.preserved)}</p>` : ""}

    <h3>Content integrity</h3>
    <dl class="kv">
      <dt>Algorithm</dt><dd class="mono">${escapeHtml(capsule.integrity.algorithm)}</dd>
      <dt>Digest</dt><dd class="mono break">${escapeHtml(capsule.integrity.digest)}</dd>
      <dt>Scope</dt><dd>${escapeHtml(capsule.integrity.scope)}</dd>
      <dt>Verification</dt><dd id="verify">not checked</dd>
    </dl>
    <p class="small warn-text">${escapeHtml(capsule.integrity.note)}</p>

    <h3>Raw capsule</h3>
    <p class="small">The complete evidence payload is embedded in this file.</p>
    <div class="actions">
      <button type="button" id="copy">Copy JSON</button>
      <button type="button" id="toggle-raw">Show JSON</button>
    </div>
    <pre id="raw" hidden></pre>

    <dl class="kv">
      <dt>Faultline version</dt><dd class="mono">${escapeHtml(capsule.provenance.faultlineVersion)}</dd>
      <dt>Capsule schema</dt><dd class="mono">${escapeHtml(capsule.schema)} v${escapeHtml(String(capsule.schemaVersion))}</dd>
      <dt>Generated</dt><dd class="mono">${escapeHtml(capsule.generatedAt)}</dd>
    </dl>
  </section>`;
}

// --- page -------------------------------------------------------------------

const STYLE = `
:root{--bg:#0b0e13;--surface:#111620;--surface2:#161c28;--border:#212a37;--border2:#2d3846;
--text:#e7ecf3;--text2:#97a3b4;--text3:#6a7789;--ok:#3ddc97;--warn:#f0b429;--crit:#ff5c5c;--info:#4c8dff;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);font-size:14px;line-height:1.55}
.wrap{max-width:1100px;margin:0 auto;padding:32px 20px 64px}
header.top{border-bottom:1px solid var(--border);padding-bottom:16px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap}
header.top h1{font-size:19px;margin:0;letter-spacing:-.01em}
header.top .sub{color:var(--text3);font-size:12px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px}
.card h2{font-size:15px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
.card h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--text3);margin:20px 0 8px}
.count{background:var(--surface2);border:1px solid var(--border2);border-radius:999px;padding:1px 8px;font-size:12px;color:var(--text2)}
.label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--text3);margin-bottom:4px}
.label.ok{color:var(--ok)}.label.warn{color:var(--warn)}
.mono{font-family:var(--mono)}.small{font-size:12px;color:var(--text2)}.big{font-size:18px}
.break{overflow-wrap:anywhere}.warn-text{color:var(--warn)}
.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px}
.conclusion{margin-top:20px;padding-top:16px;border-top:1px solid var(--border)}
.conclusion .headline{font-size:16px;margin:4px 0;font-weight:600}
.conclusion.none{color:var(--text2)}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:12px}
.split p{margin:0;font-size:13px;color:var(--text2)}
.banner{border-radius:8px;padding:16px 20px;margin-bottom:16px;border:1px dashed var(--warn);background:rgba(240,180,41,.08)}
.banner h2{color:var(--warn);margin:0 0 8px;font-size:15px;text-transform:uppercase;letter-spacing:.06em}
.banner p{margin:0 0 8px}.banner .mixed{color:var(--text2);font-size:13px}
.chip{display:inline-block;font-family:var(--mono);font-size:10px;letter-spacing:.04em;padding:2px 6px;border-radius:4px;border:1px solid var(--border2);color:var(--text3);text-transform:uppercase}
.chip.ok{color:var(--ok);border-color:rgba(61,220,151,.32);background:rgba(61,220,151,.11)}
.chip.warn{color:var(--warn);border-color:rgba(240,180,41,.32);background:rgba(240,180,41,.11)}
.chip.crit{color:var(--crit);border-color:rgba(255,92,92,.32);background:rgba(255,92,92,.11)}
.chip.info{color:var(--info);border-color:rgba(76,141,255,.38);background:rgba(76,141,255,.12)}
.table-wrap{overflow-x:auto;margin:8px 0}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:500;padding:6px 10px;border-bottom:1px solid var(--border)}
td{padding:6px 10px;border-bottom:1px solid rgba(33,42,55,.6);vertical-align:top}
tr:last-child td{border-bottom:0}
td.prop{color:var(--text);white-space:nowrap}td.arrow{color:var(--text3);text-align:center;width:24px}
.group{margin-top:16px}
.statement{margin:8px 0}
.condition{border:1px solid var(--border2);border-radius:6px;padding:14px;margin-bottom:12px;background:var(--surface2)}
.condition-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}
.confirmation{margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}
.confirmation p{margin:4px 0}
details{margin:8px 0}summary{cursor:pointer;color:var(--text2);font-size:13px;padding:4px 0}
summary:hover{color:var(--text)}
.window{border:1px solid var(--border);border-radius:6px;padding:8px 12px;margin-bottom:8px}
.timeline{list-style:none;margin:0;padding:0}
.timeline li{display:grid;grid-template-columns:60px 16px 1fr;gap:10px;align-items:start;padding:6px 0}
.tl-time{color:var(--text3);font-size:12px;padding-top:2px}
.tl-dot{width:8px;height:8px;border-radius:50%;background:var(--text3);margin-top:6px}
.tl-trigger .tl-dot{background:var(--crit)}.tl-recovery .tl-dot{background:var(--ok)}
.tl-experiment .tl-dot{background:var(--info)}
.timeline .small{display:block;color:var(--text3)}
dl.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:8px 0;font-size:13px}
dl.kv dt{color:var(--text3)}dl.kv dd{margin:0}
dl.classes{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:8px 0;font-size:13px}
dl.classes dt{color:var(--text2)}dl.classes dd{margin:0;color:var(--text3)}
.actions{display:flex;gap:8px;margin:8px 0}
button{font:inherit;font-size:12px;padding:5px 12px;border-radius:6px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);cursor:pointer}
button:hover{background:var(--border)}
pre{background:#080b0f;border:1px solid var(--border);border-radius:6px;padding:14px;overflow-x:auto;font-family:var(--mono);font-size:11px;color:var(--text2);max-height:520px}
.interpretation{border-style:dashed;border-color:var(--border2)}
footer{color:var(--text3);font-size:12px;margin-top:24px;text-align:center}
@media print{
  body{background:#fff;color:#000}
  .card{border-color:#ccc;background:#fff;break-inside:avoid}
  .chip{border-color:#999;color:#000}
  .banner{border-color:#000;background:#f5f5f5}
  button,.actions{display:none}
  details{open:true}pre{max-height:none}
}
@media (max-width:640px){.wrap{padding:20px 12px 48px}.timeline li{grid-template-columns:52px 12px 1fr}}
`;

/**
 * Runtime script. Deliberately tiny: verify the digest, and let the reader see
 * the raw payload. No network access, no external dependency.
 */
const SCRIPT = `
(function(){
  var node=document.getElementById("capsule-data");
  var capsule;
  try{ capsule=JSON.parse(node.textContent); }catch(e){ return; }

  function canonical(v){
    if(Array.isArray(v))return v.map(canonical);
    if(v&&typeof v==="object"){var o={};Object.keys(v).sort().forEach(function(k){o[k]=canonical(v[k]);});return o;}
    return v;
  }

  var raw=document.getElementById("raw");
  if(raw)raw.textContent=JSON.stringify(capsule,null,2);

  var toggle=document.getElementById("toggle-raw");
  if(toggle)toggle.addEventListener("click",function(){
    raw.hidden=!raw.hidden;
    toggle.textContent=raw.hidden?"Show JSON":"Hide JSON";
  });

  var copy=document.getElementById("copy");
  if(copy)copy.addEventListener("click",function(){
    var text=JSON.stringify(capsule,null,2);
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){copy.textContent="Copied";setTimeout(function(){copy.textContent="Copy JSON";},1500);});
    }else{
      // file:// without clipboard permission: select instead of failing silently.
      raw.hidden=false;toggle.textContent="Hide JSON";
      var range=document.createRange();range.selectNodeContents(raw);
      var sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);
      copy.textContent="Selected — press Ctrl/Cmd+C";
    }
  });

  // Recompute the digest over the payload with integrity nulled, exactly the
  // scope the capsule declares. SubtleCrypto is unavailable on file:// in some
  // browsers, so an inability to check is reported as such, never as a failure.
  var verify=document.getElementById("verify");
  if(!verify)return;
  var base=JSON.parse(JSON.stringify(capsule));
  var embedded=base.integrity&&base.integrity.digest;
  base.integrity=null;
  var json=JSON.stringify(canonical(base));

  if(!window.crypto||!window.crypto.subtle||!window.TextEncoder){
    verify.textContent="cannot verify in this browser context";
    return;
  }
  window.crypto.subtle.digest("SHA-256",new TextEncoder().encode(json)).then(function(buf){
    var hex=Array.prototype.map.call(new Uint8Array(buf),function(b){return ("0"+b.toString(16)).slice(-2);}).join("");
    if(hex===embedded){
      verify.innerHTML='<span class="chip ok">payload matches embedded digest</span>';
    }else{
      verify.innerHTML='<span class="chip crit">payload does not match embedded digest</span>';
    }
  }).catch(function(){ verify.textContent="cannot verify in this browser context"; });
})();
`;

/** Render a capsule as one self-contained HTML document. */
export function renderCapsuleHtml(capsule) {
  const verification = verifyIntegrity(capsule);
  const title = `${capsule.incident.id} · Faultline incident capsule`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div>
      <h1>Faultline incident capsule</h1>
      <div class="sub mono">${escapeHtml(capsule.incident.id)} · generated ${escapeHtml(capsule.generatedAt)}</div>
    </div>
    <div class="sub">
      ${capsule.provenance.containsSimulated ? chip("contains simulated evidence", "warn") : chip("measured evidence", "ok")}
      ${capsule.redaction.applied ? chip(`redacted · ${capsule.redaction.mode}`, "warn") : ""}
      ${verification.verifiable && verification.matches ? chip("digest sealed", "idle") : ""}
    </div>
  </header>

  ${renderSimulationBanner(capsule)}
  ${renderSummary(capsule)}
  ${renderTimeline(capsule)}
  ${renderDifferences(capsule)}
  ${renderTestable(capsule)}
  ${renderWindows(capsule)}
  ${renderDeepCapture(capsule)}
  ${renderInterpretation(capsule)}
  ${renderProvenance(capsule)}

  <footer>
    Faultline · this file is self-contained and makes no network requests.
  </footer>
</div>

<script type="application/json" id="capsule-data">${embedJson(capsule)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
