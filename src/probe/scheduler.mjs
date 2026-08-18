import { isSessionExpired } from "../security/auth.mjs";
import { probeHealth } from "./registry.mjs";

function normaliseTags(value) {
  if (!value) return [];
  const tags = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(tags.map(tag => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 12);
}

export function normaliseProbeSelector(input = {}) {
  const selector = input && typeof input === "object" ? input : {};
  const scope = String(selector.scope || "public").trim().toLowerCase();
  if (!['public', 'private'].includes(scope)) throw new Error("Probe selector scope must be public or private.");

  const country = String(selector.country || "").trim().toLowerCase() || null;
  const region = String(selector.region || "").trim().toLowerCase() || null;
  if (country && country.length > 64) throw new Error("Probe selector country must be 64 characters or fewer.");
  if (region && region.length > 64) throw new Error("Probe selector region must be 64 characters or fewer.");

  return {
    scope,
    country,
    region,
    tags: normaliseTags(selector.tags)
  };
}

function pendingLoad(probeId, sessions, runsById, now) {
  let count = 0;
  for (const session of sessions || []) {
    if (session.assignedProbeId !== probeId || isSessionExpired(session, now)) continue;
    const run = runsById.get(session.id);
    if (!run?.remoteProbe) count += 1;
  }
  return count;
}

function matchesSelector(probe, selector) {
  if (String(probe.scope || "public").toLowerCase() !== selector.scope) return false;
  if (selector.country && String(probe.country || "").toLowerCase() !== selector.country) return false;
  if (selector.region && String(probe.region || "").toLowerCase() !== selector.region) return false;
  const probeTags = new Set((probe.tags || []).map(tag => String(tag).toLowerCase()));
  return selector.tags.every(tag => probeTags.has(tag));
}

export function selectProbe({ probes = [], sessions = [], runs = [], selector = {}, now = Date.now() } = {}) {
  const normalised = normaliseProbeSelector(selector);
  const runsById = new Map((runs || []).map(run => [run.id || run.sessionId, run]));

  const candidates = probes
    .filter(probe => probe?.enabled !== false)
    .filter(probe => !probe.revokedAt)
    .filter(probe => !probe.draining && !probe.maintenance)
    .filter(probe => probeHealth(probe, now) === "online")
    .filter(probe => matchesSelector(probe, normalised))
    .map(probe => ({
      probe,
      load: pendingLoad(probe.id, sessions, runsById, now),
      seenAt: Date.parse(probe.lastSeenAt || 0) || 0
    }))
    .sort((a, b) => a.load - b.load || b.seenAt - a.seenAt || String(a.probe.id).localeCompare(String(b.probe.id)));

  if (!candidates.length) {
    const error = new Error("No online registered probe matches the requested selector.");
    error.statusCode = 409;
    error.code = "NO_PROBE_MATCH";
    throw error;
  }

  const selected = candidates[0];
  return {
    probe: selected.probe,
    selector: normalised,
    load: selected.load,
    candidateCount: candidates.length
  };
}
