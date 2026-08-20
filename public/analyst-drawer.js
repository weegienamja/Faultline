// Faultline Analyst drawer.
//
// A persistent right-hand column in the operations shell. It reads as
// instrumentation, not as a chat product: no bubbles, no avatar, no typing
// animation, no AI branding. The only decoration it earns is the one that
// carries meaning - the visual separation between a deterministic Faultline
// finding and an Analyst interpretation.
//
// Everything here is presentation. The browser never talks to Ollama, never
// chooses a model, and never sees a tool definition; it posts a question plus
// the name of the current screen and renders what the server streams back.

import { auth, badge, currentView, escapeHtml, goTo, mount, state } from "./shell.js";

const host = mount("analyst");
const drawer = document.getElementById("analyst-drawer");
const toggle = document.getElementById("analyst-toggle");
const app = document.querySelector(".fl-app");
if (!host || !drawer || !toggle || !app) throw new Error("Analyst drawer mount is missing.");

/** Conversation identity lives in the tab, like the admin credential. */
const conversationId = (() => {
  const existing = sessionStorage.getItem("faultlineAnalystConversation");
  if (existing) return existing;
  const created = `conv_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  sessionStorage.setItem("faultlineAnalystConversation", created);
  return created;
})();

let status = null;
let starters = {};
let turns = [];
let busy = false;
let abort = null;
let installing = null;

// ---------------------------------------------------------------------------
// Server access
// ---------------------------------------------------------------------------

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${auth.token}`, ...extra };
}

async function loadStatus() {
  if (!auth.unlocked) {
    status = null;
    return;
  }
  try {
    const [statusResponse, capabilityResponse] = await Promise.all([
      fetch("/api/analyst/status", { headers: authHeaders() }),
      fetch("/api/analyst/capabilities", { headers: authHeaders() })
    ]);
    status = statusResponse.ok ? await statusResponse.json() : null;
    if (capabilityResponse.ok) starters = (await capabilityResponse.json()).starterQuestions || {};
  } catch {
    // An unreachable control plane is rendered as an unavailable Analyst
    // rather than an exception: the rest of Faultline is unaffected.
    status = null;
  }
}

/**
 * Read one Server-Sent Events stream.
 *
 * Written against fetch + a reader rather than EventSource because the request
 * needs an Authorization header and a POST body.
 */
async function readStream(url, body, onEvent, signal) {
  const response = await fetch(url, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    let detail = null;
    try {
      detail = await response.json();
    } catch {
      // Non-JSON error body; the generic message below is used.
    }
    onEvent({
      type: "error",
      message: detail?.error || "The Analyst is unavailable.",
      state: detail?.state || null,
      remedy: detail?.remedy || null
    });
    return;
  }
  if (!response.body) return;

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
          // A malformed frame is skipped; the stream continues.
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATE_BADGE = {
  MODEL_READY: ["Ready", "ok"],
  MODEL_LOADING: ["Loading", "warn"],
  MODEL_NOT_INSTALLED: ["Not installed", "warn"],
  OLLAMA_UNAVAILABLE: ["Offline", "idle"],
  MODEL_ERROR: ["Error", "crit"]
};

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function shell(bodyHtml, footHtml) {
  const [label, tone] = STATE_BADGE[status?.state] || ["Unavailable", "idle"];
  host.innerHTML = `
    <div class="fl-analyst-head">
      <h2>Faultline Analyst</h2>
      <span class="fl-spacer"></span>
      ${status ? badge(label, tone) : ""}
      <button class="fl-btn fl-btn-quiet fl-btn-sm" type="button" data-analyst="new" title="Clear this conversation">New</button>
      <button class="fl-btn fl-btn-quiet fl-btn-sm" type="button" data-analyst="close" aria-label="Close Analyst">✕</button>
    </div>
    <dl class="fl-analyst-state">
      <dt>Model</dt><dd>${escapeHtml(status?.model || "—")}</dd><dd></dd>
      <dt>Runtime</dt><dd>${escapeHtml(status?.provider || "Ollama")} · local</dd><dd></dd>
    </dl>
    <div class="fl-analyst-body" id="analyst-body">${bodyHtml}</div>
    ${footHtml ? `<div class="fl-analyst-foot">${footHtml}</div>` : ""}
  `;
}

function askForm() {
  return `
    <form class="fl-analyst-ask" id="analyst-form">
      <textarea class="fl-textarea" id="analyst-input" rows="1" placeholder="Ask Faultline…"
                autocomplete="off" spellcheck="false" ${busy ? "disabled" : ""}></textarea>
      <button class="fl-btn fl-btn-primary fl-btn-sm" type="submit" ${busy ? "disabled" : ""}>${busy ? "…" : "Ask"}</button>
    </form>
    <p class="fl-meta fl-mt-2">
      Explains evidence. Does not produce Faultline findings. Local only.
    </p>`;
}

/** Evidence chips. A chip only renders as a link if it resolves to a screen. */
function refChips(ids, resolvable) {
  if (!ids?.length) return "";
  return `<div class="fl-refs">${ids.map(id => {
    const target = resolvable.get(id);
    return target?.view
      ? `<button class="fl-ref" type="button" data-ref="${escapeHtml(id)}" data-ref-view="${escapeHtml(target.view)}" title="${escapeHtml(target.label || id)}">${escapeHtml(id)}</button>`
      : `<button class="fl-ref" type="button" disabled>${escapeHtml(id)}</button>`;
  }).join("")}</div>`;
}

function renderTurn(turn) {
  const resolvable = new Map((turn.evidence || []).map(entry => [entry.ref, entry]));
  const response = turn.response;
  const parts = [`<p class="fl-turn-q">${escapeHtml(turn.question)}</p>`];

  parts.push(`<p class="fl-turn-a">${escapeHtml(turn.streamed || response?.answer || "")}</p>`);

  if (turn.error) {
    parts.push(`<p class="fl-status-line" data-tone="error">${escapeHtml(turn.error)}</p>`);
  }

  if (response) {
    // Deterministic findings first and framed as Faultline's own.
    if (response.deterministicFindings?.length) {
      parts.push(`<div class="fl-analyst-block" data-kind="finding">
        <span class="fl-label">Faultline finding · deterministic</span>
        <ul class="fl-analyst-list">${response.deterministicFindings.map(entry =>
          `<li>${escapeHtml(entry.finding)}${refChips(entry.evidenceIds, resolvable)}</li>`).join("")}</ul>
      </div>`);
    }

    if (response.observations?.length) {
      parts.push(`<div class="fl-analyst-block" data-kind="finding">
        <span class="fl-label">Evidence cited</span>
        <ul class="fl-analyst-list">${response.observations.map(entry =>
          `<li>${escapeHtml(entry.claim)}${entry.unverified ? ` ${badge("unverified", "warn")}` : ""}${refChips(entry.evidenceIds, resolvable)}</li>`).join("")}</ul>
      </div>`);
    }

    // Interpretation is visually demoted and explicitly labelled every time.
    if (response.possibleProblems?.length) {
      parts.push(`<div class="fl-analyst-block" data-kind="interpretation">
        <span class="fl-label">Analyst interpretation · hypotheses, not findings</span>
        <ul class="fl-analyst-list">${response.possibleProblems.map(entry =>
          `<li>${escapeHtml(entry.description)}${refChips(entry.basis, resolvable)}</li>`).join("")}</ul>
        <p class="fl-meta fl-mt-2">Suggested by the local model. Faultline has not determined these.</p>
      </div>`);
    }

    if (response.recommendedChecks?.length) {
      parts.push(`<div class="fl-analyst-block" data-kind="interpretation">
        <span class="fl-label">Suggested next checks</span>
        <ul class="fl-analyst-list" data-numbered>${response.recommendedChecks.map(entry =>
          `<li>${escapeHtml(entry)}</li>`).join("")}</ul>
      </div>`);
    }

    if (response.limitations?.length) {
      parts.push(`<details class="fl-disclose"><summary>Limitations</summary><div class="fl-disclose-body">
        <ul class="fl-analyst-list">${response.limitations.map(entry => `<li>${escapeHtml(entry)}</li>`).join("")}</ul>
      </div></details>`);
    }
  }

  if (turn.tools?.length) {
    parts.push(`<details class="fl-disclose"><summary>Evidence retrieved (${turn.tools.length})</summary>
      <div class="fl-disclose-body"><ul class="fl-analyst-list fl-analyst-tools">${turn.tools.map(tool =>
        `<li>${badge(tool.ok ? (tool.available ? "ok" : "none") : "refused", tool.ok ? (tool.available ? "ok" : "idle") : "crit")}
          <code>${escapeHtml(tool.name)}</code>
          ${tool.detail ? `<span>${escapeHtml(String(tool.detail).slice(0, 120))}</span>` : ""}</li>`).join("")}</ul>
      </div></details>`);
  }

  if (turn.status && busy) {
    parts.push(`<p class="fl-status-line fl-running">${escapeHtml(turn.status)}</p>`);
  }

  return `<div class="fl-turn">${parts.join("")}</div>`;
}

function render() {
  if (!auth.unlocked) {
    shell(auth.lockedState("The Faultline Analyst"), "");
    return;
  }

  if (installing) {
    const percent = installing.percent ?? 0;
    shell(`
      <div class="fl-analyst-block" data-kind="finding">
        <span class="fl-label">Installing ${escapeHtml(installing.model || status?.model || "model")}</span>
        <div class="fl-progress"><span style="width:${percent}%"></span></div>
        <p class="fl-meta">
          ${installing.totalBytes ? `${escapeHtml(formatBytes(installing.completedBytes))} / ${escapeHtml(formatBytes(installing.totalBytes))} · ` : ""}${escapeHtml(installing.label || "Working")}${installing.percent !== null && installing.percent !== undefined ? ` · ${percent}%` : ""}
        </p>
        ${installing.error ? `<p class="fl-status-line" data-tone="error">${escapeHtml(installing.error)}</p>` : ""}
      </div>`, "");
    return;
  }

  if (!status || !status.ready) {
    shell(installState(), "");
    return;
  }

  const view = currentView() || "overview";
  const suggestions = starters[view] || starters.overview || [];
  const body = turns.length
    ? turns.map(renderTurn).join("")
    : `<div class="fl-analyst-block" data-kind="finding">
         <span class="fl-label">Ask about this screen</span>
         <p class="fl-meta fl-mb-3">
           The Analyst reads Faultline's evidence through read-only tools. It explains findings; it never makes them.
         </p>
         <div class="fl-starters">${suggestions.map(question =>
           `<button class="fl-starter" type="button" data-starter="${escapeHtml(question)}">${escapeHtml(question)}</button>`).join("")}</div>
       </div>`;

  shell(body, askForm());
  const body_ = document.getElementById("analyst-body");
  if (body_ && turns.length) body_.scrollTop = body_.scrollHeight;
}

/** The not-ready surface: honest about state, with one explicit action. */
function installState() {
  if (!status) {
    return state({
      icon: "○",
      tone: "empty",
      title: "Analyst unavailable",
      body: "The Faultline control plane did not report an Analyst runtime. Faultline's deterministic diagnosis is unaffected."
    });
  }

  if (status.state === "OLLAMA_UNAVAILABLE") {
    return state({
      icon: "○",
      tone: "empty",
      title: "Local AI runtime not running",
      body: `${status.detail} ${status.remedy || ""} Local AI is optional: every Faultline measurement and diagnosis works without it.`
    });
  }

  if (status.state === "MODEL_NOT_INSTALLED") {
    return `<div class="fl-analyst-block" data-kind="finding">
      <span class="fl-label">Local AI is optional</span>
      <p class="fl-meta fl-mb-3">
        Faultline can use a local model to explain diagnostic evidence and answer questions about the
        current network state. No deterministic diagnosis is delegated to the model.
      </p>
      <dl class="fl-kv">
        <div><dt>Ollama</dt><dd>${badge("Connected", "ok")}</dd></div>
        <div><dt>${escapeHtml(status.model)}</dt><dd>${badge("Not installed", "warn")}</dd></div>
        <div><dt>Download</dt><dd>~5.2 GB</dd></div>
      </dl>
      <div class="fl-mt-3"><button class="fl-btn fl-btn-primary fl-btn-sm" type="button" data-analyst="install">Install model</button></div>
      <p class="fl-meta fl-mt-2">Downloads from Ollama's registry to this machine. Nothing is installed until you choose it.</p>
    </div>`;
  }

  return state({
    icon: "△",
    tone: "empty",
    title: "Analyst error",
    body: `${status.detail || "The local model runtime reported an error."} ${status.remedy || ""}`
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function ask(question) {
  if (busy || !question.trim()) return;
  busy = true;
  abort = new AbortController();

  const turn = {
    question: question.trim(),
    streamed: "",
    status: "Retrieving Faultline evidence",
    tools: [],
    evidence: [],
    response: null,
    error: null
  };
  turns.push(turn);
  render();

  try {
    await readStream("/api/analyst/ask", {
      question: turn.question,
      conversationId,
      // Explicit context object. No DOM, no HTML, no page scrape.
      view: {
        view: currentView() || "overview",
        target: document.getElementById("bisect-target")?.value?.trim() || null
      }
    }, event => {
      if (event.type === "status") turn.status = event.detail;
      else if (event.type === "tool") turn.tools.push({ name: event.name, ok: event.ok, available: event.available, detail: event.detail });
      else if (event.type === "answer_delta") {
        turn.streamed += event.text;
        turn.status = null;
      } else if (event.type === "result") {
        turn.response = event.response;
        turn.evidence = event.evidence || [];
        turn.tools = event.tools || turn.tools;
        turn.streamed = event.response?.answer || turn.streamed;
        turn.status = null;
      } else if (event.type === "error") {
        turn.error = [event.message, event.remedy].filter(Boolean).join(" ");
        turn.status = null;
      }
      render();
    }, abort.signal);
  } catch (error) {
    if (error?.name !== "AbortError") turn.error = "The Analyst request could not be completed.";
  } finally {
    busy = false;
    abort = null;
    turn.status = null;
    render();
  }
}

async function install() {
  installing = { percent: 0, label: "Starting", model: status?.model };
  render();
  try {
    await readStream("/api/analyst/install", { model: status?.model }, event => {
      if (event.type === "progress") installing = { ...installing, ...event };
      else if (event.type === "error") installing = { ...installing, error: event.message };
      else if (event.type === "done") installing = { ...installing, percent: 100, label: "Installed" };
      render();
    });
  } catch {
    installing = { ...installing, error: "The download was interrupted." };
  }
  // Re-read runtime state rather than assuming the pull succeeded.
  await loadStatus();
  installing = null;
  render();
}

async function newConversation() {
  abort?.abort();
  turns = [];
  try {
    await fetch("/api/analyst/conversation/clear", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ conversationId })
    });
  } catch {
    // Server-side history expires on its own; a failed clear is not fatal.
  }
  render();
}

function setOpen(open) {
  drawer.hidden = !open;
  app.dataset.analyst = open ? "open" : "closed";
  toggle.setAttribute("aria-expanded", String(open));
  sessionStorage.setItem("faultlineAnalystOpen", open ? "1" : "0");
  if (open) render();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

toggle.addEventListener("click", async () => {
  const open = drawer.hidden;
  setOpen(open);
  if (open && !status) {
    await loadStatus();
    render();
  }
});

host.addEventListener("click", event => {
  const action = event.target.closest("[data-analyst]")?.dataset.analyst;
  if (action === "close") return setOpen(false);
  if (action === "new") return void newConversation();
  if (action === "install") return void install();

  const starter = event.target.closest("[data-starter]");
  if (starter) return void ask(starter.dataset.starter);

  // An evidence chip navigates to the panel that holds the record.
  const ref = event.target.closest(".fl-ref[data-ref-view]");
  if (ref) goTo(ref.dataset.refView);
});

host.addEventListener("submit", event => {
  if (event.target.id !== "analyst-form") return;
  event.preventDefault();
  const input = document.getElementById("analyst-input");
  const question = input?.value || "";
  if (input) input.value = "";
  void ask(question);
});

// Enter sends, Shift+Enter breaks the line.
host.addEventListener("keydown", event => {
  if (event.target.id !== "analyst-input") return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    document.getElementById("analyst-form")?.requestSubmit();
  }
});

window.addEventListener("faultline-auth-changed", async () => {
  await loadStatus();
  render();
});

// Starter questions follow the user between screens.
window.addEventListener("faultline-view", () => {
  if (!drawer.hidden && !turns.length) render();
});

if (sessionStorage.getItem("faultlineAnalystOpen") === "1") {
  setOpen(true);
  void loadStatus().then(render);
}
