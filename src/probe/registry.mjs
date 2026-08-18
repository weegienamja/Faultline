import { randomBytes } from "node:crypto";
import { generateCredential, hashCredential, verifyCredential } from "../security/auth.mjs";

export const PROBE_ONLINE_MS = 90_000;
export const PROBE_STALE_MS = 5 * 60_000;

function normaliseTags(value) {
  if (!value) return [];
  const tags = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(tags.map(tag => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 12);
}

export function normaliseProbeRegistration(input = {}, now = Date.now()) {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Registered probe requires a name.");
  if (name.length > 80) throw new Error("Probe name must be 80 characters or fewer.");

  const location = String(input.location || "").trim() || null;
  if (location && location.length > 120) throw new Error("Probe location must be 120 characters or fewer.");

  return {
    name,
    location,
    tags: normaliseTags(input.tags),
    createdAt: new Date(now).toISOString(),
    lastSeenAt: null,
    runtime: null,
    enabled: input.enabled !== false
  };
}

export function createRegisteredProbe(input = {}, now = Date.now()) {
  const normalised = normaliseProbeRegistration(input, now);
  const token = generateCredential("fl_probe");
  const probe = {
    id: `PRB-${randomBytes(5).toString("hex").toUpperCase()}`,
    ...normalised,
    tokenHash: hashCredential(token)
  };

  return { probe, credential: token };
}

export function probeHealth(probe, now = Date.now()) {
  if (!probe?.enabled) return "disabled";
  if (!probe?.lastSeenAt) return "offline";
  const age = now - Date.parse(probe.lastSeenAt);
  if (!Number.isFinite(age) || age < 0) return "unknown";
  if (age <= PROBE_ONLINE_MS) return "online";
  if (age <= PROBE_STALE_MS) return "stale";
  return "offline";
}

export function publicProbe(probe, now = Date.now()) {
  return {
    id: probe.id,
    name: probe.name,
    location: probe.location || null,
    tags: Array.isArray(probe.tags) ? probe.tags : [],
    enabled: probe.enabled !== false,
    health: probeHealth(probe, now),
    createdAt: probe.createdAt,
    lastSeenAt: probe.lastSeenAt || null,
    runtime: probe.runtime || null
  };
}

export function verifyProbeCredential(probe, token) {
  return Boolean(probe?.enabled !== false && verifyCredential(token, probe?.tokenHash));
}

export function touchProbe(probe, heartbeat = {}, now = Date.now()) {
  const runtime = heartbeat.runtime && typeof heartbeat.runtime === "object"
    ? {
        version: heartbeat.runtime.version ? String(heartbeat.runtime.version) : null,
        platform: heartbeat.runtime.platform ? String(heartbeat.runtime.platform) : null,
        hostname: heartbeat.runtime.hostname ? String(heartbeat.runtime.hostname) : null,
        node: heartbeat.runtime.node ? String(heartbeat.runtime.node) : null
      }
    : probe.runtime || null;

  return {
    ...probe,
    lastSeenAt: new Date(now).toISOString(),
    runtime
  };
}
