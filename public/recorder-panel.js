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

  function sampleRow(sample) {
    const tcp = sample.connectivity?.targetTcp || {};
    const reach = tcp.state === "PASS"
      ? `${badge("PASS", "ok")} <span class="fl-num">${tcp.ms} ms</span>`
      : tcp.state === "FAIL"
        ? `${badge("FAIL", "crit")} <span class="fl-meta">${escapeHtml(tcp.error || "")}</span>`
        : badge(tcp.state || "—", "idle");
    const gateway = sample.connectivity?.gateway;
    return `<tr>
      <td class="fl-num">${time(sample.at)}</td>
      <td>${reach}</td>
      <td>${badge(sample.connectivity?.ipv6?.state || "—", sample.connectivity?.ipv6?.state === "PASS" ? "ok" : sample.connectivity?.ipv6?.state === "FAIL" ? "crit" : "idle")}</td>
      <td class="fl-num">${gateway && gateway.state === "PASS" ? `${gateway.averageMs} ms` : "—"}</td>
      <td>${escapeHtml(sample.local?.activeInterface || "—")}</td>
    </tr>`;
  }

  function timelineTable(samples) {
    if (!samples.length) return state({ icon: "⏺", title: "Waiting for the first sample" });
    return `<div class="fl-table-wrap"><table class="fl-table">
      <thead><tr><th>Time</th><th>Target</th><th>IPv6</th><th>Gateway</th><th>Interface</th></tr></thead>
      <tbody>${samples.slice(-14).reverse().map(sampleRow).join("")}</tbody>
    </table></div>`;
  }

  function startForm() {
    return `
      <form class="fl-controlbar" id="recorder-form">
        <div class="fl-control-group" style="flex:0 1 380px;min-width:240px">
          <span class="fl-label">Target</span>
          <input class="fl-input fl-input-mono" id="recorder-target" style="flex:1"
                 placeholder="api.example.com" autocomplete="off" spellcheck="false" value="example.com" />
        </div>
        <div class="fl-control-group">
          <span class="fl-label">Interval</span>
          <input class="fl-input fl-input-mono" id="recorder-interval" type="number" min="2" max="30" value="3" style="width:56px;text-align:center" />
        </div>
        <div class="fl-control-group">
          <span class="fl-label">Window</span>
          <input class="fl-input fl-input-mono" id="recorder-window" type="number" min="60" max="600" step="30" value="180" style="width:64px;text-align:center" />
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
    return `<div class="fl-control-group" style="gap:4px">
      <select class="fl-select fl-btn-sm" data-capsule-redaction="${escapeHtml(record.id)}" title="Redaction">
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
    const window = (title, entry) => entry.samples.length
      ? `<div style="margin-top:16px"><span class="fl-label">${title}</span>${timelineTable(entry.samples)}</div>`
      : "";

    const change = record.observedChange;
    const candidates = record.candidateDiscriminators;

    const differences = change?.comparable && change.differences.length
      ? `<div class="fl-table-wrap"><table class="fl-table">
           <thead><tr><th>Property</th><th>Healthy</th><th>Failing</th><th>Testable</th></tr></thead>
           <tbody>${change.differences.map(difference => `<tr>
             <td>${escapeHtml(difference.label)}</td>
             <td class="fl-mono">${escapeHtml(String(difference.from))}</td>
             <td class="fl-mono">${escapeHtml(String(difference.to))}</td>
             <td>${difference.testable ? badge("Bisect", "info") : badge("no experiment", "idle")}</td>
           </tr>`).join("")}</tbody>
         </table></div>`
      : "";

    const deep = record.deepCapture?.available
      ? `<dl class="fl-kv">
           ${(record.deepCapture.stages || []).map(stage =>
             `<div><dt>${escapeHtml(stage.name)}</dt><dd>${badge(stage.state, stage.state === "pass" ? "ok" : stage.state === "fail" ? "crit" : "idle")}</dd></div>`).join("")}
           <div><dt>Independent vantage</dt><dd>${escapeHtml(record.deepCapture.external?.state || "—")}</dd></div>
         </dl>
         ${record.deepCapture.external?.meaning ? `<p class="fl-meta" style="margin-top:8px">${escapeHtml(record.deepCapture.external.meaning)}</p>` : ""}`
      : `<p class="fl-meta">${escapeHtml(record.deepCapture?.reason || "No deeper diagnostic was captured for this incident.")}</p>`;

    return `
      <div class="fl-view-head">
        <div>
          <span class="fl-label">Incident</span>
          <h3 class="fl-panel-title">${escapeHtml(record.id)} ${record.simulated ? badge("SIMULATED", "warn") : ""}</h3>
          ${record.simulated ? `<p class="fl-meta" style="color:var(--fl-warn)">Generated from scenario <code>${escapeHtml(record.scenario || "")}</code>. Not a measurement of any real network.</p>` : ""}
          <p class="fl-meta">${escapeHtml(record.trigger.summary || "")} · ${time(record.trigger.at)}</p>
        </div>
        <div class="fl-view-head-actions">
          ${exportControl(record)}
          <button class="fl-btn fl-btn-sm" type="button" data-recorder="back">Back to timeline</button>
        </div>
      </div>

      ${panel({
        label: "Observed",
        title: "What the recorder saw",
        body: `${change?.comparable
          ? `<p class="fl-body fl-prose">${escapeHtml(change.statement)}</p>
             <p class="fl-meta" style="margin-top:8px">${escapeHtml(change.note)}</p>
             ${differences}`
          : `<p class="fl-body fl-prose">${escapeHtml(change?.reason || "No comparison was possible.")}</p>`}`,
        // Must not claim a real measurement on a simulated record.
        foot: record.simulated
          ? `<span>Every row was generated from scenario <code>${escapeHtml(record.scenario || "")}</code>. Nothing here was measured.</span>`
          : `<span>Every row is a real measurement taken at the stated time.</span>`
      })}

      ${candidates?.available ? panel({
        label: "Candidate changed conditions",
        title: "Differences Network Bisect can test",
        body: `
          <ul class="fl-analyst-list">${candidates.testable.map(candidate =>
            `<li><strong>${escapeHtml(candidate.condition)}</strong> — ${escapeHtml(String(candidate.healthyValue))} → ${escapeHtml(String(candidate.failingValue))}
             ${badge(candidate.axis, "info")}</li>`).join("")}</ul>
          <p class="fl-meta" style="margin-top:10px">${escapeHtml(candidates.invitation)}</p>
          <p class="fl-meta">${escapeHtml(candidates.note)}</p>
          ${candidates.untestable.length ? `<p class="fl-meta" style="margin-top:8px">Observed but not testable: ${candidates.untestable.map(entry => escapeHtml(entry.condition)).join(", ")}.</p>` : ""}
          <div style="margin-top:12px">
            <button class="fl-btn fl-btn-primary fl-btn-sm" type="button" data-recorder="bisect" data-incident="${escapeHtml(record.id)}" ${busy ? "disabled" : ""}>
              ${busy ? "Running…" : "Run Network Bisect on these conditions"}
            </button>
          </div>`
      }) : ""}

      ${panel({ label: "Deep capture", title: "Measured once, at the trigger", body: deep })}

      ${panel({
        label: "Windows",
        title: "Before, during and after",
        flush: true,
        body: `${window("Before", record.windows.before)}${window("During", record.windows.during)}${window("After", record.windows.after)}`
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

      ${status?.simulated ? `<div class="fl-analyst-block" data-kind="interpretation" style="border-color:var(--fl-warn-line);margin-bottom:12px">
          <span class="fl-label" style="color:var(--fl-warn)">Simulated capture — not a real measurement</span>
          <p class="fl-meta">Scenario <code>${escapeHtml(status.simulation?.scenario || "")}</code>: ${escapeHtml(status.simulation?.description || "")}</p>
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
          ? `<div class="fl-table-wrap"><table class="fl-table">
               <thead><tr><th>Incident</th><th>Trigger</th><th>At</th><th>Differences</th><th></th><th></th></tr></thead>
               <tbody>${status.incidents.map(entry => `<tr>
                 <td class="fl-mono">${escapeHtml(entry.id)} ${entry.simulated ? badge("SIM", "warn") : ""}</td>
                 <td>${escapeHtml(entry.triggerSummary || entry.trigger || "")}</td>
                 <td class="fl-num">${time(entry.at)}</td>
                 <td class="fl-num">${entry.differences}</td>
                 <td><button class="fl-btn fl-btn-sm" type="button" data-recorder="open" data-incident="${escapeHtml(entry.id)}">Open</button></td>
                 <td>${exportControl(entry)}</td>
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
