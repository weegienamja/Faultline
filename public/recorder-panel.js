// Flight Recorder panel.
//
// A live capture surface built from the existing design system. Three states:
// stopped (start form), recording (rolling timeline), and incident (the
// BEFORE / DURING / AFTER record).
//
// The presentation rule that matters here is the same one the record itself
// enforces: a difference between two windows is shown as a difference, never as
// a cause. The candidate conditions block therefore reads as an invitation to
// test, and the button next to it hands those conditions to Network Bisect
// rather than drawing a conclusion from them.

import { auth, badge, disclose, escapeHtml, mount, onView, panel, state } from "./shell.js";

const host = mount("recorder");
if (host) {
  let status = null;
  let incident = null;
  let stream = null;
  let scenarios = [];
  let busy = false;
  let error = null;

  const time = at => (at ? new Date(at).toISOString().slice(11, 19) : "—");

  function headers(extra = {}) {
    return { authorization: `Bearer ${auth.token}`, ...extra };
  }

  async function api(path, options = {}) {
    const response = await fetch(`/api/recorder${path}`, { ...options, headers: headers(options.headers) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }

  async function refresh() {
    if (!auth.unlocked) {
      status = null;
      return;
    }
    try {
      status = await api("/status");
      if (!scenarios.length) {
        const listed = await api("/scenarios").catch(() => null);
        scenarios = listed?.scenarios || [];
      }
      error = null;
    } catch (failure) {
      status = null;
      error = failure.message;
    }
  }

  /**
   * Live events keep the timeline current without polling. The stream is only
   * opened while the view is visible and a recorder exists.
   */
  function openStream() {
    if (stream || !auth.unlocked) return;
    const controller = new AbortController();
    stream = controller;

    fetch("/api/recorder/stream", { headers: headers(), signal: controller.signal })
      .then(async response => {
        if (!response.ok || !response.body) return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split;
          while ((split = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try {
                onEvent(JSON.parse(line.slice(5).trim()));
              } catch {
                // Ignore an unparsable frame.
              }
            }
          }
        }
      })
      .catch(() => {
        // A dropped stream falls back to the next manual refresh.
      })
      .finally(() => {
        if (stream === controller) stream = null;
      });
  }

  function closeStream() {
    stream?.abort();
    stream = null;
  }

  async function onEvent(event) {
    if (event.type === "sample" || event.type === "incident-open" || event.type === "incident-closed" || event.type === "stopped") {
      await refresh();
      // An incident that just closed is the thing the user came for.
      if (event.type === "incident-closed") {
        try {
          incident = await api(`/incidents/${event.id}`);
        } catch {
          incident = null;
        }
      }
      render();
    }
  }

  // --- rendering -----------------------------------------------------------

  /** Span between two timestamps, in the unit an engineer would say aloud. */
  function span(from, to) {
    if (!from || !to) return null;
    const ms = new Date(to) - new Date(from);
    if (!Number.isFinite(ms) || ms < 0) return null;
    if (ms < 1000) return `${ms} ms`;
    if (ms < 90000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
    return `${Math.round(ms / 60000)} min`;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function sampleRow(sample) {
    const tcp = sample.connectivity?.targetTcp || {};
    const reach = tcp.state === "PASS"
      ? `${badge("PASS", "ok")} <span class="fl-num">${tcp.ms} ms</span>`
      : tcp.state === "FAIL"
        ? `${badge("FAIL", "crit")} <span class="fl-meta">${escapeHtml(tcp.error || "")}</span>`
        : badge(tcp.state || "—", "idle");
    const gateway = sample.connectivity?.gateway;
    const v6 = sample.connectivity?.ipv6?.state;
    // data-label lets the table restack as labelled key/value rows in a narrow
    // container without dropping a single column.
    return `<tr>
      <td class="fl-num" data-label="Time">${time(sample.at)}</td>
      <td data-label="Target">${reach}</td>
      <td data-label="IPv6">${badge(v6 || "—", v6 === "PASS" ? "ok" : v6 === "FAIL" ? "crit" : "idle")}</td>
      <td class="fl-num" data-label="Gateway">${gateway && gateway.state === "PASS" ? `${gateway.averageMs} ms` : "—"}</td>
      <td data-label="Interface"><span class="fl-value">${escapeHtml(sample.local?.activeInterface || "—")}</span></td>
    </tr>`;
  }

  function timelineTable(samples) {
    if (!samples.length) return state({ icon: "⏺", title: "Waiting for the first sample" });
    return `<div class="fl-table-wrap"><table class="fl-table" data-stack>
      <thead><tr><th>Time</th><th>Target</th><th>IPv6</th><th>Gateway</th><th>Interface</th></tr></thead>
      <tbody>${samples.slice(-14).reverse().map(sampleRow).join("")}</tbody>
    </table></div>`;
  }

  // --- chronology ----------------------------------------------------------

  /**
   * One stage of the incident record.
   *
   * `level` is which of the two rail heights this stage sits at, and `shift`
   * marks the stage where the rail moves between them. That displacement is
   * the only piece of iconography in the product: it puts the moment the
   * observed state changed somewhere the eye finds before it reads a label.
   */
  function stage({ kind = "phase", event = null, label, headline, detail, at, status = "idle", level = 0, shift = null }) {
    const style = [`--fl-chrono-level:${level}`];
    if (shift) style.push(`--fl-shift-from:var(--fl-${shift})`);
    return `<li class="fl-chrono-stage" data-kind="${kind}"${event ? ` data-event="${event}"` : ""}
        data-status="${escapeHtml(status)}"${shift ? " data-shift" : ""} style="${style.join(";")}">
      <span class="fl-chrono-rail" aria-hidden="true"></span>
      ${kind === "event" ? `<span class="fl-chrono-marker" aria-hidden="true"></span>` : ""}
      <div class="fl-chrono-head">
        <span class="fl-chrono-label">${escapeHtml(label)}</span>
        <time class="fl-chrono-time">${time(at)}</time>
      </div>
      <div class="fl-chrono-state">${escapeHtml(headline)}</div>
      <div class="fl-chrono-detail">${escapeHtml(detail)}</div>
    </li>`;
  }

  /**
   * BEFORE -> TRIGGER -> DURING -> DEEP CAPTURE -> AFTER as one continuous
   * record.
   *
   * Every stage is rendered even when it is empty: "no samples were retained
   * before the trigger" is a real and consequential fact about a capture, and
   * omitting the column would hide the reason the comparison below is missing.
   */
  function chronology(record) {
    const change = record.observedChange;
    const windows = record.windows;
    const recovery = change?.recovery || null;
    const deepCapture = record.deepCapture?.available ? record.deepCapture : null;
    const failed = change?.hadFailure !== false;

    const before = windows.before.samples.length;
    const during = windows.during.samples.length;
    const after = windows.after.samples.length;

    const stages = [];

    stages.push(stage({
      label: "Before",
      status: before ? "ok" : "idle",
      headline: before ? "Reachable" : "No prior samples",
      detail: before
        ? [plural(before, "sample"), span(windows.before.from, windows.before.to)].filter(Boolean).join(" · ")
        : "Nothing retained to compare the captured state against",
      at: windows.before.to,
      level: 0
    }));

    stages.push(stage({
      kind: "event",
      event: "trigger",
      label: "Trigger",
      status: failed ? "crit" : "warn",
      headline: record.trigger.summary || record.trigger.type || "Capture opened",
      detail: record.trigger.manual
        ? "Captured by hand while the recorder was running"
        : `Rule: ${record.trigger.type || "—"}`,
      at: record.trigger.at,
      level: 1,
      shift: before ? "ok" : "idle"
    }));

    stages.push(stage({
      label: failed ? "During" : "Captured",
      status: failed ? "crit" : "warn",
      headline: failed
        ? (change?.capturedWindow?.reasons?.[0] || "Target unreachable")
        : "Target still reachable",
      detail: during
        ? [plural(during, "sample"), span(windows.during.from, windows.during.to)].filter(Boolean).join(" · ")
        : "No samples captured in this window",
      at: windows.during.from,
      level: 1
    }));

    if (deepCapture) {
      const passed = (deepCapture.stages || []).filter(entry => entry.state === "pass").length;
      const total = (deepCapture.stages || []).length;
      stages.push(stage({
        kind: "event",
        event: "deep",
        label: "Deep capture",
        status: total && passed === total ? "ok" : passed ? "warn" : "crit",
        headline: total ? `${passed}/${total} stages passed` : "Diagnostic captured",
        detail: deepCapture.external?.state && deepCapture.external.state !== "not-measured"
          ? `Independent vantage: ${deepCapture.external.state}`
          : "Local vantage only",
        at: record.trigger.at,
        level: 1
      }));
    }

    stages.push(stage({
      label: "After",
      status: recovery ? "ok" : failed ? "crit" : "idle",
      headline: recovery
        ? "Recovered"
        : failed ? "No recovery observed" : "No failure occurred",
      detail: [
        after ? plural(after, "sample") : "no samples",
        recovery ? `reachable again after ${span(record.trigger.at, recovery.at) || "—"}` : null
      ].filter(Boolean).join(" · "),
      at: recovery ? recovery.at : windows.after.to,
      // Recovery brings the rail back to the healthy level; an unrecovered
      // incident stays displaced, which is the honest picture of its state.
      level: recovery ? 0 : 1,
      shift: recovery ? "crit" : null
    }));

    return `<ol class="fl-chrono"${record.simulated ? " data-simulated" : ""}>${stages.join("")}</ol>`;
  }

  /**
   * What this incident supports doing next.
   *
   * CAPTURE has happened; the strip names ISOLATE, EXPLAIN and PRESERVE in the
   * order the evidence supports them, with at most one marked as the lead. It
   * is a set of available moves, not a wizard: every one of these is reachable
   * from the navigation rail too.
   */
  function followUp(record) {
    const candidates = record.candidateDiscriminators;
    const canBisect = Boolean(candidates?.available);
    const entries = [];

    entries.push(`<div class="fl-chrono-next"${canBisect ? " data-lead" : ""}>
      <span class="fl-chrono-label">Isolate</span>
      ${canBisect
        ? `<button class="fl-btn fl-btn-primary fl-btn-sm" type="button" data-recorder="bisect"
             data-incident="${escapeHtml(record.id)}" ${busy ? "disabled" : ""}>
             ${busy ? "Running…" : `Test ${plural(candidates.testable.length, "condition")} with Bisect`}
           </button>`
        : `<span class="fl-meta">No difference here maps to an experiment Bisect can run.</span>`}
    </div>`);

    entries.push(`<div class="fl-chrono-next">
      <span class="fl-chrono-label">Explain</span>
      <button class="fl-btn fl-btn-sm" type="button" data-recorder="analyst">Ask the Analyst</button>
    </div>`);

    entries.push(`<div class="fl-chrono-next">
      <span class="fl-chrono-label">Preserve</span>
      ${exportControl(record)}
    </div>`);

    return `<div class="fl-chrono-followup">${entries.join("")}</div>`;
  }

  function startForm() {
    return `
      <form class="fl-controlbar" id="recorder-form">
        <div class="fl-control-group fl-grow">
          <span class="fl-label">Target</span>
          <input class="fl-input fl-input-mono fl-grow" id="recorder-target"
                 placeholder="api.example.com" autocomplete="off" spellcheck="false" value="example.com" />
        </div>
        <div class="fl-control-group">
          <span class="fl-label">Interval</span>
          <input class="fl-input fl-input-mono fl-input-num-sm" id="recorder-interval" type="number" min="2" max="30" value="3" aria-label="Sample interval in seconds" />
        </div>
        <div class="fl-control-group">
          <span class="fl-label">Window</span>
          <input class="fl-input fl-input-mono fl-input-num" id="recorder-window" type="number" min="60" max="600" step="30" value="180" aria-label="Rolling window in seconds" />
        </div>
        <div class="fl-control-group">
          <span class="fl-label">Simulate</span>
          <select class="fl-select" id="recorder-simulate">
            <option value="">Off — record the real network</option>
            ${scenarios.map(entry => `<option value="${escapeHtml(entry.scenario)}">${escapeHtml(entry.title)}</option>`).join("")}
          </select>
        </div>
        <div class="fl-spacer"></div>
        <button class="fl-btn fl-btn-primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Starting…" : "Start recording"}</button>
      </form>`;
  }

  /**
   * Export control.
   *
   * The label states what is inside so nobody has to open the file to find out
   * whether an experiment was ever run against the incident.
   */
  function exportControl(record) {
    const experiments = Array.isArray(record.evidence)
      ? record.evidence.length
      : record.experimentCount ?? 0;
    const label = experiments ? "Export capsule · Recorder + Bisect" : "Export capsule · Recorder only";
    return `<div class="fl-control-group">
      <select class="fl-select fl-btn-sm" data-capsule-redaction="${escapeHtml(record.id)}" aria-label="Redaction level">
        <option value="none">No redaction</option>
        <option value="network-identifiers">Hide identifiers</option>
        <option value="strict">Strict</option>
      </select>
      <a class="fl-btn fl-btn-sm" data-capsule-link="${escapeHtml(record.id)}"
         href="/api/recorder/incidents/${encodeURIComponent(record.id)}/capsule"
         download>${escapeHtml(label)}</a>
    </div>`;
  }

  function incidentView(record) {
    const change = record.observedChange;
    const candidates = record.candidateDiscriminators;
    const deepAvailable = record.deepCapture?.available;

    const windowTable = (title, entry) => entry.samples.length
      ? `<div class="fl-mt-4"><span class="fl-label">${title}</span>${timelineTable(entry.samples)}</div>`
      : "";

    // The differences table is a DETERMINISTIC COMPARISON: two real windows,
    // one fixed rule, no claim about why they differ. It is framed as one, and
    // states its own limit inside the block rather than in a legend elsewhere.
    const differences = change?.comparable && change.differences.length
      ? `<div class="fl-evidence fl-mt-3" data-evidence="comparison">
           <div class="fl-evidence-head">
             <span class="fl-provenance" data-evidence="comparison">Deterministic comparison</span>
             <h3 class="fl-evidence-title">What differed between the two windows</h3>
           </div>
           <div class="fl-table-wrap"><table class="fl-table" data-stack>
             <thead><tr><th>Property</th><th>Healthy</th><th>Captured</th><th>Testable</th></tr></thead>
             <tbody>${change.differences.map(difference => `<tr>
               <td data-label="Property">${escapeHtml(difference.label)}</td>
               <td data-label="Healthy"><span class="fl-value">${escapeHtml(String(difference.from))}</span></td>
               <td data-label="Captured"><span class="fl-value">${escapeHtml(String(difference.to))}</span></td>
               <td data-label="Testable">${difference.testable || difference.bisectAxis ? badge("Bisect can test", "info") : badge("no experiment", "idle")}</td>
             </tr>`).join("")}</tbody>
           </table></div>
           <p class="fl-evidence-caveat">${escapeHtml(change.note || "")}</p>
         </div>`
      : "";

    const deep = deepAvailable
      ? `<dl class="fl-kv">
           ${(record.deepCapture.stages || []).map(entry =>
             `<div><dt>${escapeHtml(entry.name)}</dt><dd>${badge(entry.state, entry.state === "pass" ? "ok" : entry.state === "fail" ? "crit" : "idle")}</dd></div>`).join("")}
           <div><dt>Independent vantage</dt><dd>${escapeHtml(record.deepCapture.external?.state || "—")}</dd></div>
         </dl>
         ${record.deepCapture.external?.meaning ? `<p class="fl-meta fl-mt-2">${escapeHtml(record.deepCapture.external.meaning)}</p>` : ""}`
      : `<p class="fl-meta">${escapeHtml(record.deepCapture?.reason || "No deeper diagnostic was captured for this incident.")}</p>`;

    return `
      <div class="fl-view-head">
        <div>
          <span class="fl-label">Incident</span>
          <h2 class="fl-panel-title"><span class="fl-value">${escapeHtml(record.id)}</span></h2>
          <p class="fl-meta fl-mt-1">${escapeHtml(record.trigger.summary || "")} · ${time(record.trigger.at)}${record.target?.host ? ` · ${escapeHtml(record.target.host)}:${record.target.port ?? ""}` : ""}</p>
        </div>
        <div class="fl-view-head-actions">
          ${record.simulated
            ? `<span class="fl-source" data-kind="simulated">Simulated</span>`
            : `<span class="fl-source" data-kind="measured">Measured</span>`}
          <button class="fl-btn fl-btn-sm" type="button" data-recorder="back">Back to timeline</button>
        </div>
      </div>

      ${record.simulated ? `
        <div class="fl-evidence fl-mb-3" data-evidence="simulated">
          <div class="fl-evidence-head">
            <span class="fl-provenance" data-evidence="simulated">Simulated</span>
            <h3 class="fl-evidence-title">Nothing in this incident was measured</h3>
          </div>
          <p class="fl-body">Every sample below was generated from scenario <span class="fl-value">${escapeHtml(record.scenario || "")}</span>. This is not a capture of any real network.</p>
        </div>` : ""}

      ${panel({
        label: "Chronology",
        title: "What the recorder saw",
        meta: record.simulated
          ? `<span class="fl-source" data-kind="simulated">Scenario</span>`
          : `<span class="fl-source" data-kind="measured">Measured locally</span>`,
        body: `${chronology(record)}${followUp(record)}`,
        foot: record.simulated
          ? `<span>Generated from scenario <span class="fl-value">${escapeHtml(record.scenario || "")}</span>. Nothing here was measured.</span>`
          : `<span>Every stage is a real measurement taken at the stated time.</span>`
      })}

      ${panel({
        label: "Observed",
        title: "The comparison",
        body: `${change?.comparable
          ? `<p class="fl-claim fl-prose" data-evidence="comparison">${escapeHtml(change.statement)}</p>${differences}`
          : `<p class="fl-body fl-prose">${escapeHtml(change?.reason || "No comparison was possible.")}</p>`}`,
        foot: `<span>${escapeHtml(record.epistemics?.limit || "")}</span>`
      })}

      ${candidates?.available ? panel({
        label: "Candidate conditions",
        title: "Differences Network Bisect can test",
        body: `
          <ul class="fl-evidence-set">${candidates.testable.map(candidate =>
            `<li class="fl-evidence" data-evidence="comparison">
               <div class="fl-evidence-head">
                 <h3 class="fl-evidence-title">${escapeHtml(candidate.condition)}</h3>
                 ${badge(candidate.axis, "info")}
               </div>
               <div class="fl-body"><span class="fl-value">${escapeHtml(String(candidate.healthyValue))}</span> → <span class="fl-value">${escapeHtml(String(candidate.failingValue))}</span></div>
             </li>`).join("")}</ul>
          <p class="fl-meta fl-mt-3">${escapeHtml(candidates.invitation || "")}</p>
          <p class="fl-meta">${escapeHtml(candidates.note)}</p>
          ${candidates.untestable.length
            ? `<p class="fl-meta fl-mt-2">Observed but not testable: ${candidates.untestable.map(entry => escapeHtml(entry.condition)).join(", ")}.</p>`
            : ""}
          <div class="fl-mt-3">
            <button class="fl-btn fl-btn-primary fl-btn-sm" type="button" data-recorder="bisect" data-incident="${escapeHtml(record.id)}" ${busy ? "disabled" : ""}>
              ${busy ? "Running…" : "Run Network Bisect on these conditions"}
            </button>
          </div>`
      }) : ""}

      ${panel({ label: "Deep capture", title: "Measured once, at the trigger", body: deep })}

      ${panel({
        label: "Windows",
        title: "Every sample, before during and after",
        flush: true,
        body: `<div class="fl-panel-body">${windowTable("Before", record.windows.before)}${windowTable("During", record.windows.during)}${windowTable("After", record.windows.after)}</div>`
      })}`;
  }

  function render() {
    if (!auth.unlocked) {
      host.innerHTML = `<section class="fl-panel">${auth.lockedState("The Flight Recorder")}</section>`;
      return;
    }

    if (incident) {
      host.innerHTML = incidentView(incident);
      return;
    }

    const recording = status && status.state !== "stopped";
    const coverage = status?.coverage;

    host.innerHTML = `
      <div class="fl-view-head">
        <div>
          <p class="fl-body fl-prose">
            Captures the evidence that normally disappears before troubleshooting begins. A light sample
            every few seconds, held in memory for a few minutes; when something changes, the window
            around it is frozen and a deeper diagnostic runs once.
          </p>
        </div>
        <div class="fl-view-head-actions">
          ${status?.simulated ? badge("SIMULATED", "warn") : ""}
          ${recording ? badge("Recording", "ok") : badge("Not recording", "idle")}
          ${status?.simulated
            // Never "Measured locally" while simulating: provenance is a design
            // guarantee here, not decoration, and the two chips side by side
            // would say exactly the thing this feature must not say.
            ? `<span class="fl-source" data-kind="simulated">Scenario source</span>`
            : `<span class="fl-source" data-kind="measured">Measured locally</span>`}
        </div>
      </div>

      ${status?.simulated ? `
        <div class="fl-evidence fl-mb-3" data-evidence="simulated">
          <div class="fl-evidence-head">
            <span class="fl-provenance" data-evidence="simulated">Simulated</span>
            <h3 class="fl-evidence-title">Simulated capture — not a real measurement</h3>
          </div>
          <p class="fl-body">Scenario <span class="fl-value">${escapeHtml(status.simulation?.scenario || "")}</span>: ${escapeHtml(status.simulation?.description || "")}</p>
        </div>` : ""}
      ${recording ? "" : startForm()}
      ${error ? `<p class="fl-status-line" data-tone="error">${escapeHtml(error)}</p>` : ""}

      ${recording ? panel({
        label: "Live",
        title: `${escapeHtml(status.target?.host || "")}:${status.target?.port ?? ""}`,
        meta: `<button class="fl-btn fl-btn-sm" type="button" data-recorder="mark">Capture incident now</button>
               <button class="fl-btn fl-btn-sm" type="button" data-recorder="stop">Stop</button>`,
        flush: true,
        body: timelineTable(status.latest ? [status.latest] : []),
        // The rolling buffer is ephemeral; closed incidents are not. Saying only
        // the first half was accurate before incidents persisted, and is not now.
        foot: `<span>${coverage ? `${coverage.samples} samples · ${Math.round(coverage.windowMs / 1000)}s rolling window` : "starting"} · buffer in memory only · closed incidents ${status?.incidentsPersisted === false ? "kept in memory" : "persist"}</span>`
      }) : ""}

      ${recording ? panel({
        label: "Timeline",
        title: "Rolling buffer",
        flush: true,
        body: `<div id="recorder-timeline">${timelineTable([])}</div>`
      }) : ""}

      ${panel({
        label: "Incidents",
        title: "Captured windows",
        body: status?.incidents?.length
          ? `<div class="fl-table-wrap"><table class="fl-table" data-stack>
               <thead><tr><th>Incident</th><th>Trigger</th><th>At</th><th>Differences</th><th><span class="fl-sr-only">Open</span></th><th><span class="fl-sr-only">Export</span></th></tr></thead>
               <tbody>${status.incidents.map(entry => `<tr>
                 <td data-label="Incident"><span class="fl-value">${escapeHtml(entry.id)}</span> ${entry.simulated ? badge("SIM", "warn") : ""}</td>
                 <td data-label="Trigger">${escapeHtml(entry.triggerSummary || entry.trigger || "")}</td>
                 <td class="fl-num" data-label="At">${time(entry.at)}</td>
                 <td class="fl-num" data-label="Differences">${entry.differences}</td>
                 <td data-label="Open"><button class="fl-btn fl-btn-sm" type="button" data-recorder="open" data-incident="${escapeHtml(entry.id)}">Open</button></td>
                 <td data-label="Export">${exportControl(entry)}</td>
               </tr>`).join("")}</tbody>
             </table></div>`
          : state({
              icon: "⏺",
              title: recording ? "No incident captured yet" : "Nothing recorded",
              body: recording
                ? "The recorder is watching. An incident is captured when the target's reachability changes, a contract fails, the gateway degrades, or you capture one by hand."
                : "Start a recording to keep a rolling window of evidence."
            })
      })}`;

    if (recording) void paintTimeline();
  }

  async function paintTimeline() {
    try {
      const { samples } = await api("/timeline?limit=40");
      const node = document.getElementById("recorder-timeline");
      if (node) node.innerHTML = timelineTable(samples);
    } catch {
      // The panel is still usable without the rolling view.
    }
  }

  // --- actions -------------------------------------------------------------

  host.addEventListener("submit", async event => {
    if (event.target.id !== "recorder-form") return;
    event.preventDefault();

    // Read the form BEFORE rendering: render() rebuilds the panel's innerHTML,
    // which replaces these inputs with fresh ones carrying their defaults.
    // Reading afterwards silently discarded whatever the user actually typed.
    const request = {
      target: document.getElementById("recorder-target")?.value?.trim(),
      simulate: document.getElementById("recorder-simulate")?.value || undefined,
      intervalMs: Number(document.getElementById("recorder-interval")?.value || 3) * 1000,
      windowMs: Number(document.getElementById("recorder-window")?.value || 180) * 1000
    };

    busy = true;
    error = null;
    render();
    try {
      status = await api("/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request)
      });
      openStream();
    } catch (failure) {
      error = failure.message;
    } finally {
      busy = false;
      render();
    }
  });

  host.addEventListener("change", event => {
    const select = event.target.closest("[data-capsule-redaction]");
    if (!select) return;
    const link = host.querySelector(`[data-capsule-link="${CSS.escape(select.dataset.capsuleRedaction)}"]`);
    if (link) link.dataset.redaction = select.value;
  });

  host.addEventListener("click", async event => {
    // The capsule route is admin-authenticated, and a plain download link
    // cannot carry the credential. Fetch it and hand the browser a blob.
    const link = event.target.closest("[data-capsule-link]");
    if (link) {
      event.preventDefault();
      const id = link.dataset.capsuleLink;
      const redaction = link.dataset.redaction || "none";
      try {
        const response = await fetch(`/api/recorder/incidents/${encodeURIComponent(id)}/capsule?redaction=${encodeURIComponent(redaction)}`, { headers: headers() });
        if (!response.ok) throw new Error(`Export failed (${response.status})`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `faultline-${id}.html`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      } catch (failure) {
        error = failure.message;
        render();
      }
      return;
    }

    const action = event.target.closest("[data-recorder]")?.dataset.recorder;
    if (!action) return;
    const incidentId = event.target.closest("[data-incident]")?.dataset.incident;

    try {
      if (action === "stop") {
        closeStream();
        status = await api("/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      } else if (action === "mark") {
        await api("/mark", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "captured from the dashboard" }) });
      } else if (action === "open" && incidentId) {
        incident = await api(`/incidents/${encodeURIComponent(incidentId)}`);
      } else if (action === "analyst") {
        // EXPLAIN is available from the incident, but it opens the same drawer
        // the topbar opens — the Analyst is never a step the incident owns.
        document.getElementById("analyst-toggle")?.click();
        return;
      } else if (action === "back") {
        incident = null;
        await refresh();
      } else if (action === "bisect" && incidentId) {
        busy = true;
        error = null;
        render();
        const result = await api(`/incidents/${encodeURIComponent(incidentId)}/bisect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        });
        // Bisect owns the verdict; the recorder only handed it the conditions.
        incident = { ...incident, bisectResult: result };
        error = null;
        window.location.hash = "#/bisect";
        window.dispatchEvent(new CustomEvent("faultline-bisect-report", { detail: { report: result.report } }));
      }
    } catch (failure) {
      error = failure.message;
    } finally {
      busy = false;
      render();
    }
  });

  window.addEventListener("faultline-auth-changed", async () => {
    closeStream();
    await refresh();
    render();
  });

  onView("recorder", async () => {
    await refresh();
    render();
    if (status && status.state !== "stopped") openStream();
  });

  render();
}
