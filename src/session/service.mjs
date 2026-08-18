import { randomBytes } from "node:crypto";
import { generateCredential, hashCredential, isSessionExpired } from "../security/auth.mjs";

const DEFAULT_TTL_MINUTES = 60;
const MAX_TTL_MINUTES = 24 * 60;

export function normaliseSessionInput(input = {}, now = Date.now()) {
  const target = String(input.target || "").trim();
  if (!target) throw new Error("Diagnostic session requires a target.");
  if (target.length > 512) throw new Error("Diagnostic target is too long.");
  if (target.includes("://") && !/^https?:\/\//i.test(target)) {
    throw new Error("Only HTTP and HTTPS URLs are supported as URL targets.");
  }

  let inferredPort = 443;
  if (/^https?:\/\//i.test(target)) {
    const parsed = new URL(target);
    inferredPort = Number(parsed.port || (parsed.protocol === "http:" ? 80 : 443));
  }

  const port = Number(input.port ?? inferredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Session port must be an integer between 1 and 65535.");
  }

  const requestedTtl = Number(input.ttlMinutes ?? DEFAULT_TTL_MINUTES);
  if (!Number.isFinite(requestedTtl) || requestedTtl < 5 || requestedTtl > MAX_TTL_MINUTES) {
    throw new Error(`Session TTL must be between 5 and ${MAX_TTL_MINUTES} minutes.`);
  }

  const ttlMinutes = Math.round(requestedTtl);
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMinutes * 60_000).toISOString();
  const title = String(input.title || `Diagnostic · ${target}`).trim();
  const customer = String(input.customer || "Diagnostic session").trim();
  if (title.length > 180 || customer.length > 180) throw new Error("Session title and customer labels must be 180 characters or fewer.");

  return {
    target: {
      input: target,
      port
    },
    title,
    customer,
    vpnRequired: Boolean(input.vpnRequired || input.expectedRoute),
    expectedRoute: input.expectedRoute ? String(input.expectedRoute).trim() : null,
    assignedProbeId: input.assignedProbeId ? String(input.assignedProbeId).trim() : null,
    ttlMinutes,
    createdAt,
    expiresAt
  };
}

export function createDiagnosticSession(input = {}, now = Date.now()) {
  const normalised = normaliseSessionInput(input, now);
  const endpointToken = generateCredential("fl_ep");
  const probeToken = normalised.assignedProbeId ? null : generateCredential("fl_pr");
  const id = `FL-${randomBytes(5).toString("hex").toUpperCase()}`;

  const session = {
    id,
    ...normalised,
    endpointTokenHash: hashCredential(endpointToken),
    probeTokenHash: probeToken ? hashCredential(probeToken) : null
  };

  return {
    session,
    credentials: {
      endpointToken,
      ...(probeToken ? { probeToken } : {})
    }
  };
}

export function publicSession(session, now = Date.now()) {
  return {
    id: session.id,
    target: session.target,
    title: session.title,
    customer: session.customer,
    vpnRequired: Boolean(session.vpnRequired),
    expectedRoute: session.expectedRoute || null,
    assignedProbeId: session.assignedProbeId || null,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    status: isSessionExpired(session, now) ? "expired" : "active"
  };
}
