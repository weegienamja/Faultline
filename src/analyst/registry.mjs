// Recent-evidence registry.
//
// Network Bisect reports and live diagnostics are returned straight to the
// browser and never written to the store. That is a deliberate privacy
// property, but it left the Analyst with nothing to retrieve: a tool called
// `get_latest_bisect_run` needs somewhere to read from.
//
// This is that somewhere, and it keeps the privacy property intact:
//
//   * memory only - nothing reaches disk, so evidence does not outlive the
//     process and is never silently persisted;
//   * bounded - a small ring per kind, so a long-running control plane cannot
//     accumulate an unbounded record of who measured what;
//   * read-only downstream - the Analyst gateway can look, never mutate.
//
// The existing routers call `record()` once a run completes. Nothing else in
// Faultline reads from here, so removing the Analyst removes the retention.

const DEFAULT_LIMIT = 10;

export function createEvidenceRegistry({ limit = DEFAULT_LIMIT, now = () => Date.now() } = {}) {
  /** @type {Map<string, Array<{id: string, at: number, value: object}>>} */
  const kinds = new Map();

  function ring(kind) {
    if (!kinds.has(kind)) kinds.set(kind, []);
    return kinds.get(kind);
  }

  return {
    /**
     * Store a completed artefact. `id` is the artefact's own identifier where
     * it has one, so a later lookup by id is stable.
     */
    record(kind, value, { id = null } = {}) {
      if (!kind || !value || typeof value !== "object") return null;
      const entry = {
        id: String(id || value.id || `${kind}_${now().toString(36)}`),
        at: now(),
        value
      };
      const entries = ring(kind);
      const existing = entries.findIndex(item => item.id === entry.id);
      if (existing >= 0) entries.splice(existing, 1);
      entries.unshift(entry);
      entries.length = Math.min(entries.length, limit);
      return entry.id;
    },

    /** Most recent artefact of a kind, or null. */
    latest(kind) {
      return ring(kind)[0]?.value ?? null;
    },

    get(kind, id) {
      if (!id) return null;
      return ring(kind).find(item => item.id === String(id))?.value ?? null;
    },

    /** Newest-first descriptors, without the payloads. */
    list(kind, count = DEFAULT_LIMIT) {
      return ring(kind).slice(0, count).map(item => ({ id: item.id, at: new Date(item.at).toISOString() }));
    },

    size(kind) {
      return ring(kind).length;
    },

    clear() {
      kinds.clear();
    }
  };
}

/** Process-wide registry used by the live and bisect routers. */
export const evidenceRegistry = createEvidenceRegistry();

export const EVIDENCE_KIND = {
  BISECT: "bisect",
  LIVE: "live"
};
