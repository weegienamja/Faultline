// Faultline application shell.
//
// Two jobs, deliberately kept small:
//
//   1. Routing. The dashboard used to be one long scroll with anchor links, so
//      every surface competed for the same screen and "where am I" had no
//      answer. Views are now real destinations addressable by URL.
//   2. Shared primitives. Panels previously each injected a <style> block and
//      invented their own colours and markup. The helpers below are the only
//      sanctioned way to render a badge, tile, state or panel frame.

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------
// Every status in the product maps onto exactly four visual states. Panels must
// translate their domain vocabulary here rather than picking a colour directly,
// which is what kept PASS green in one panel and mint in another.

const STATUS_BY_TERM = {
  pass: "ok", ok: "ok", healthy: "ok", online: "ok", up: "ok", resolved: "ok",
  supported: "ok", improvement: "ok", isolated: "ok",

  warn: "warn", warning: "warn", degraded: "warn", stale: "warn", unstable: "warn",
  weakened: "warn", intermittent: "warn", partial: "warn", unconfirmed: "warn",

  fail: "crit", failed: "crit", critical: "crit", offline: "crit", down: "crit",
  error: "crit", regression: "crit", breaking: "crit",

  idle: "idle", unknown: "idle", inapplicable: "idle", unsupported: "idle",
  contradicted: "idle", disabled: "idle", "not_testable": "idle", skipped: "idle"
};

export function statusOf(term) {
  if (!term) return "idle";
  return STATUS_BY_TERM[String(term).trim().toLowerCase().replace(/\s+/g, "_")] || "idle";
}

// ---------------------------------------------------------------------------
// Render helpers — all return HTML strings so panels can compose them freely
// ---------------------------------------------------------------------------

export function badge(text, status = "idle", { code = false } = {}) {
  const cls = code ? "fl-badge fl-badge-code" : "fl-badge";
  return `<span class="${cls}" data-status="${escapeHtml(status)}">${escapeHtml(text)}</span>`;
}

/** Machine state (PASS / FAIL / INAPPLICABLE …) rendered in the code style. */
export function stateBadge(term) {
  return badge(String(term ?? "—").replace(/_/g, " "), statusOf(term), { code: true });
}

export function dot(status = "idle") {
  return `<span class="fl-dot" data-status="${escapeHtml(status)}"></span>`;
}

/** Where a number came from: measured | inferred | external | demo. */
export function source(kind, label = kind) {
  return `<span class="fl-source" data-kind="${escapeHtml(kind)}">${escapeHtml(label)}</span>`;
}

export function tile({ label, value, unit, sub, status = "idle" }) {
  // Figures get the numeral treatment; phrases step down so a long fault-domain
  // name does not shout louder than the measurements next to it.
  const kind = /^[\d.,+\-−]+$/.test(String(value).trim()) ? "number" : "text";
  return `<div class="fl-tile" data-status="${escapeHtml(status)}">
    <span class="fl-tile-label">${escapeHtml(label)}</span>
    <span class="fl-tile-value" data-kind="${kind}">${escapeHtml(value)}${unit ? `<small>${escapeHtml(unit)}</small>` : ""}</span>
    ${sub ? `<span class="fl-tile-sub">${sub}</span>` : ""}
  </div>`;
}

export function panel({ label, title, meta = "", body, foot = "", status, flush = false, id = "" }) {
  return `<section class="fl-panel"${status ? ` data-status="${escapeHtml(status)}"` : ""}${id ? ` id="${escapeHtml(id)}"` : ""}>
    <header class="fl-panel-head">
      <div>
        ${label ? `<span class="fl-label">${escapeHtml(label)}</span>` : ""}
        <h2 class="fl-panel-title">${escapeHtml(title)}</h2>
      </div>
      ${meta ? `<div class="fl-panel-head-actions">${meta}</div>` : ""}
    </header>
    <div class="fl-panel-body${flush ? " fl-panel-body-flush" : ""}">${body}</div>
    ${foot ? `<footer class="fl-panel-foot">${foot}</footer>` : ""}
  </section>`;
}

/**
 * Empty / error / locked state.
 *
 * Faultline has a lot of surfaces that are legitimately empty until someone
 * runs something. An empty surface must say what it will contain and how to
 * fill it, otherwise it reads as broken.
 */
export function state({ icon = "○", title, body, actions = "", tone = "empty" }) {
  return `<div class="fl-state" data-tone="${escapeHtml(tone)}">
    <div class="fl-state-icon" aria-hidden="true">${icon}</div>
    <p class="fl-state-title">${escapeHtml(title)}</p>
    ${body ? `<p class="fl-state-body">${escapeHtml(body)}</p>` : ""}
    ${actions ? `<div class="fl-state-actions">${actions}</div>` : ""}
  </div>`;
}

export function skeleton(rows = 4) {
  return `<div class="fl-skeleton-rows">${Array.from({ length: rows }, () => `<div class="fl-skeleton"></div>`).join("")}</div>`;
}

export function disclose(summary, body, { open = false } = {}) {
  return `<details class="fl-disclose"${open ? " open" : ""}>
    <summary>${escapeHtml(summary)}</summary>
    <div class="fl-disclose-body">${body}</div>
  </details>`;
}

/** Horizontal bar list — used where a count comparison beats a time series. */
export function bars(rows) {
  const max = Math.max(1, ...rows.map(r => Number(r.value) || 0));
  return `<div class="fl-bars">${rows.map(r => `
    <div class="fl-bar-row">
      <span>${escapeHtml(r.label)}</span>
      <span class="fl-bar-track"><span class="fl-bar-fill" data-status="${escapeHtml(r.status || "info")}" style="width:${Math.round((Number(r.value) || 0) / max * 100)}%"></span></span>
      <span class="fl-bar-value">${escapeHtml(r.display ?? r.value)}</span>
    </div>`).join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Mount points
// ---------------------------------------------------------------------------
// Panels used to locate themselves with `insertBefore` against whatever element
// happened to be nearby, so layout depended on script import order. They now
// ask for a named slot declared in the markup.

export function mount(name) {
  return document.querySelector(`[data-mount="${name}"]`);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const views = new Map();
let activeView = null;

function readViews() {
  for (const node of document.querySelectorAll("[data-view]")) {
    views.set(node.dataset.view, {
      node,
      title: node.dataset.viewTitle || node.dataset.view,
      group: node.dataset.viewGroup || ""
    });
  }
}

function routeFromHash() {
  const raw = (location.hash || "").replace(/^#\/?/, "").trim();
  return views.has(raw) ? raw : "overview";
}

/**
 * Switch views, with a cross-fade where the browser can do one cheaply.
 *
 * Views are `display: none` siblings, so a switch is instantaneous and the
 * whole screen changes at once — which reads as a flicker rather than as
 * navigation. A short cross-fade says "this replaced that" without costing
 * troubleshooting time.
 *
 * Three conditions, all of which must hold, or it falls straight through to
 * the plain swap:
 *   - the browser has the API at all;
 *   - the user has not asked for reduced motion;
 *   - this is not the first render (there is nothing to transition FROM, and
 *     animating the initial paint would delay first contentful paint).
 */
function apply(name) {
  const view = views.get(name);
  if (!view || activeView === name) return;

  const animate = activeView !== null
    && typeof document.startViewTransition === "function"
    && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (animate) document.startViewTransition(() => swap(name, view));
  else swap(name, view);
}

function swap(name, view) {
  activeView = name;

  for (const [key, entry] of views) entry.node.classList.toggle("is-active", key === name);

  for (const link of document.querySelectorAll(".fl-nav-item")) {
    const target = (link.getAttribute("href") || "").replace(/^#\/?/, "");
    if (target === name) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }

  const crumbGroup = document.getElementById("crumb-group");
  const crumbTitle = document.getElementById("crumb-title");
  if (crumbGroup) crumbGroup.textContent = view.group;
  if (crumbTitle) crumbTitle.textContent = view.title;
  document.title = `${view.title} · Faultline`;

  document.querySelector(".fl-content")?.scrollTo?.({ top: 0 });
  window.scrollTo({ top: 0 });

  // Panels render lazily so an unopened view costs nothing.
  window.dispatchEvent(new CustomEvent("faultline-view", { detail: { view: name } }));
}

export function currentView() {
  return activeView;
}

export function goTo(name) {
  if (location.hash === `#/${name}`) apply(name);
  else location.hash = `#/${name}`;
}

/** Run `fn` the first time `name` becomes visible, and on every visit after. */
export function onView(name, fn) {
  if (activeView === name) fn();
  window.addEventListener("faultline-view", event => {
    if (event.detail.view === name) fn();
  });
}

function start() {
  readViews();
  apply(routeFromHash());
  window.addEventListener("hashchange", () => apply(routeFromHash()));
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();

// ---------------------------------------------------------------------------
// Credential state, shared across panels
// ---------------------------------------------------------------------------

export const auth = {
  get token() { return sessionStorage.getItem("faultlineAdminToken") || ""; },
  get unlocked() { return Boolean(this.token); },
  set(value) {
    if (value) sessionStorage.setItem("faultlineAdminToken", value);
    else sessionStorage.removeItem("faultlineAdminToken");
    window.dispatchEvent(new CustomEvent("faultline-auth-changed"));
  },
  /** Standard locked-surface state, so every gated panel reads identically. */
  lockedState(what) {
    return state({
      icon: "◌",
      tone: "locked",
      title: "Live data is locked",
      body: `${what} requires the Faultline admin credential. It is held in this browser tab only and never persisted.`,
      actions: `<button class="fl-btn fl-btn-primary" data-action="unlock">Unlock live data</button>`
    });
  }
};

document.addEventListener("click", event => {
  if (event.target.closest("[data-action='unlock']")) document.getElementById("auth-open")?.click();
  // The rail's Explain entry drives the one Analyst toggle rather than owning a
  // second copy of the drawer's open/close state.
  if (event.target.closest("[data-opens='analyst']")) document.getElementById("analyst-toggle")?.click();
});
