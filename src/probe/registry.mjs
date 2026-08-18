import { randomBytes } from "node:crypto";
import { generateCredential, hashCredential, verifyCredential } from "../security/auth.mjs";
import { normaliseProbeScope } from "../security/target.mjs";

export const PROBE_ONLINE_MS = 90_000;
export const PROBE_STALE_MS = 5 * 60_000;

function normaliseTags(value) {
  if (!value) return [];
  const tags = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(tags.map(tag => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 12);
}

function optionalLabel(value, field) {
  const label = String(value || "").trim() || null;
  if (label && label.length > 64) throw new Error(`${field} must be 64 characters or fewer.`);
  return label;
}

export function normaliseProbeRegistration(input = {}, now = Date.now()) {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Registered probe requires a name.");
  if (name.length > 80) throw new Error("Probe name must be 80 characters or fewer.");

  const location = String(input.location || "").trim() || null;
  if (location && location.length > 120) throw new Error("Probe location must be 120 characters or fewer.");

  const createdAt = new Date(now).toISOString();
  return {
    name,
    location,
    country: optionalLabel(input.country, "Probe country"),
    region: optionalLabel(input.region, "Probe region"),
    scope: normaliseProbeScope(input.scope || "public"),
    tags: normaliseTags(input.tags),
    createdAt,
    lastSeenAt: null,
    runtime: null,
    enabled: input.enabled !== false,
    draining: false,
    maintenance: false,
    revokedAt: null,
    credentialVersion: 1,
    credentialRotatedAt: createdAt
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
  if (probe?.revokedAt) return "revoked";
  if (!probe?.enabled) return "disabled";
  if (probe?.maintenance) return "maintenance";
  if (!probe?.lastSeenAt) return "offline";
  const age = now - Date.parse(probe.lastSeenAt);
  if (!Number.isFinite(age) || age < 0) return "unknown";
  if (age <= PROBE_ONLINE_MS) return probe.draining ? "draining" : "online";
  if (age <= PROBE_STALE_MS) return "stale";
  return "offline";
}

export function publicProbe(probe, now = Date.now()) {
  return {
    id: probe.id,
    name: probe.name,
    location: probe.location || null,
    country: probe.country || null,
    region: probe.region || null,
    scope: probe.scope || "public",
    tags: Array.isArray(probe.tags) ? probe.tags : [],
    enabled: probe.enabled !== false,
    draining: Boolean(probe.draining),
    maintenance: Boolean(probe.maintenance),
    revokedAt: probe.revokedAt || null,
    credentialVersion: Number(probe.credentialVersion || 1),
    credentialRotatedAt: probe.credentialRotatedAt || probe.createdAt || null,
    health: probeHealth(probe, now),
    createdAt: probe.createdAt,
    lastSeenAt: probe.lastSeenAt || null,
    runtime: probe.runtime || null
  };
}

export function verifyProbeCredential(probe, token) {
  return Boolean(
    probe?.enabled !== false &&
    !probe?.revokedAt &&
    probe?.tokenHash &&
    verifyCredential(token, probe.tokenHash)
  );
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

export function updateProbeLifecycle(probe, input = {}, now = Date.now()) {
  if (!probe) throw new Error("Registered probe is required.");
  const updated = { ...probe };

  if (Object.hasOwn(input, "enabled")) updated.enabled = Boolean(input.enabled);
  if (Object.hasOwn(input, "draining")) updated.draining = Boolean(input.draining);
  if (Object.hasOwn(input, "maintenance")) updated.maintenance = Boolean(input.maintenance);
  if (Object.hasOwn(input, "scope")) updated.scope = normaliseProbeScope(input.scope);
  if (Object.hasOwn(input, "country")) updated.country = optionalLabel(input.country, "Probe country");
  if (Object.hasOwn(input, "region")) updated.region = optionalLabel(input.region, "Probe region");
  if (Object.hasOwn(input, "tags")) updated.tags = normaliseTags(input.tags);

  updated.updatedAt = new Date(now).toISOString();
  return updated;
}

export function rotateProbeCredential(probe, now = Date.now()) {
  if (!probe || probe.revokedAt) throw new Error("Revoked probes cannot rotate credentials.");
  const credential = generateCredential("fl_probe");
  const rotatedAt = new Date(now).toISOString();
  return {
    probe: {
      ...probe,
      tokenHash: hashCredential(credential),
      credentialVersion: Number(probe.credentialVersion || 1) + 1,
      credentialRotatedAt: rotatedAt,
      updatedAt: rotatedAt
    },
    credential
  };
}

export function revokeProbeCredential(probe, now = Date.now()) {
  if (!probe) throw new Error("Registered probe is required.");
  const revokedAt = new Date(now).toISOString();
  return {
    ...probe,
    enabled: false,
    draining: false,
    maintenance: false,
    revokedAt,
    tokenHash: null,
    updatedAt: revokedAt
  };
}
