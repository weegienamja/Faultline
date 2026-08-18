import { randomBytes } from "node:crypto";
import { generateCredential, hashCredential, isSessionExpired, verifyCredential } from "../security/auth.mjs";

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

  const probeSelection = input.probeSelection && typeof input.probeSelection === "object"
    ? {
        mode: String(input.probeSelection.mode || "explicit"),
        selector: input.probeSelection.selector || null,
        selectedAt: input.probeSelection.selectedAt || createdAt,
        candidateCount: Number(input.probeSelection.candidateCount || 0),
        loadAtSelection: Number(input.probeSelection.loadAtSelection || 0)
      }
    : null;

  return {
    target: { input: target, port },
    title,
    customer,
    vpnRequired: Boolean(input.vpnRequired || input.expectedRoute),
    expectedRoute: input.expectedRoute ? String(input.expectedRoute).trim() : null,
    assignedProbeId: input.assignedProbeId ? String(input.assignedProbeId).trim() : null,
    probeSelection,
    ttlMinutes,
    createdAt,
    expiresAt
  };
}

export function createDiagnosticSession(input = {}, now = Date.now()) {
  const normalised = normaliseSessionInput(input, now);
  const ephemeral = Boolean(input.ephemeral);
  const endpointToken = ephemeral ? null : generateCredential("fl_ep");
  const invitationToken = ephemeral ? generateCredential("fl_inv") : null;
  const probeToken = normalised.assignedProbeId ? null : generateCredential("fl_pr");
  const id = `FL-${randomBytes(8).toString("hex").toUpperCase()}`;

  const session = {
    id,
    ...normalised,
    mode: ephemeral ? "ephemeral" : "direct",
    endpointTokenHash: endpointToken ? hashCredential(endpointToken) : null,
    probeTokenHash: probeToken ? hashCredential(probeToken) : null,
    invitation: invitationToken ? {
      tokenHash: hashCredential(invitationToken),
      createdAt: normalised.createdAt,
      claimedAt: null,
      consentedAt: null,
      includeTopology: null,
      clientLaunch: null
    } : null
  };

  return {
    session,
    credentials: {
      ...(endpointToken ? { endpointToken } : {}),
      ...(invitationToken ? { invitationToken } : {}),
      ...(probeToken ? { probeToken } : {})
    }
  };
}

export function findSessionByInvitationToken(sessions, token) {
  if (!token || !Array.isArray(sessions)) return null;
  return sessions.find(session => verifyCredential(token, session?.invitation?.tokenHash)) || null;
}

export function findSessionByClientLaunchToken(sessions, token) {
  if (!token || !Array.isArray(sessions)) return null;
  return sessions.find(session => verifyCredential(token, session?.invitation?.clientLaunch?.tokenHash)) || null;
}

export function claimDiagnosticInvitation(session, token, options = {}, now = Date.now()) {
  if (!session || session.mode !== "ephemeral" || !session.invitation?.tokenHash) {
    const error = new Error("Diagnostic invitation is invalid.");
    error.statusCode = 404;
    throw error;
  }
  if (!verifyCredential(token, session.invitation.tokenHash)) {
    const error = new Error("Diagnostic invitation is invalid.");
    error.statusCode = 404;
    throw error;
  }
  if (isSessionExpired(session, now)) {
    const error = new Error("Diagnostic invitation has expired.");
    error.statusCode = 410;
    throw error;
  }
  if (session.invitation.claimedAt) {
    const error = new Error("Diagnostic invitation has already been claimed.");
    error.statusCode = 410;
    throw error;
  }
  if (options.consent !== true) {
    const error = new Error("Explicit consent is required before endpoint diagnostics can be activated.");
    error.statusCode = 400;
    throw error;
  }

  const clientLaunchToken = generateCredential("fl_launch");
  const claimedAt = new Date(now).toISOString();
  const includeTopology = options.includeTopology !== false;
  const updatedSession = {
    ...session,
    endpointTokenHash: null,
    invitation: {
      ...session.invitation,
      tokenHash: null,
      claimedAt,
      consentedAt: claimedAt,
      includeTopology,
      clientLaunch: {
        tokenHash: hashCredential(clientLaunchToken),
        createdAt: claimedAt,
        exchangedAt: null
      }
    }
  };

  return { session: updatedSession, clientLaunchToken };
}

export function exchangeClientLaunch(session, token, now = Date.now()) {
  const launch = session?.invitation?.clientLaunch;
  if (!session || session.mode !== "ephemeral" || !launch?.tokenHash) {
    const error = new Error("Windows client launch credential is invalid or already used.");
    error.statusCode = 404;
    throw error;
  }
  if (!verifyCredential(token, launch.tokenHash)) {
    const error = new Error("Windows client launch credential is invalid.");
    error.statusCode = 404;
    throw error;
  }
  if (isSessionExpired(session, now)) {
    const error = new Error("Diagnostic session has expired.");
    error.statusCode = 410;
    throw error;
  }
  if (launch.exchangedAt) {
    const error = new Error("Windows client launch credential has already been used.");
    error.statusCode = 410;
    throw error;
  }

  const endpointToken = generateCredential("fl_ep");
  const exchangedAt = new Date(now).toISOString();
  const updatedSession = {
    ...session,
    endpointTokenHash: hashCredential(endpointToken),
    invitation: {
      ...session.invitation,
      clientLaunch: {
        ...launch,
        tokenHash: null,
        exchangedAt
      }
    }
  };

  return {
    session: updatedSession,
    endpointToken,
    includeTopology: updatedSession.invitation.includeTopology !== false
  };
}

export function publicSession(session, now = Date.now()) {
  const expired = isSessionExpired(session, now);
  const mode = session.mode || "direct";
  const invitation = session.invitation ? {
    status: expired ? "expired" : session.invitation.claimedAt ? "claimed" : "available",
    claimedAt: session.invitation.claimedAt || null,
    consentedAt: session.invitation.consentedAt || null,
    includeTopology: session.invitation.includeTopology,
    clientLaunchStatus: session.invitation.clientLaunch
      ? session.invitation.clientLaunch.exchangedAt ? "exchanged" : "available"
      : null,
    clientExchangedAt: session.invitation.clientLaunch?.exchangedAt || null
  } : null;

  return {
    id: session.id,
    target: session.target,
    title: session.title,
    customer: session.customer,
    mode,
    vpnRequired: Boolean(session.vpnRequired),
    expectedRoute: session.expectedRoute || null,
    assignedProbeId: session.assignedProbeId || null,
    probeSelection: session.probeSelection || null,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    status: expired ? "expired" : "active",
    invitation
  };
}
