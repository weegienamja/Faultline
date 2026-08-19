import { randomBytes } from "node:crypto";
import { generateCredential, hashCredential, verifyCredential } from "../security/auth.mjs";
import { recordCaseEvent } from "./service.mjs";

const ROLES = new Set(["observer", "contributor"]);
const KINDS = new Set(["observation", "counter-evidence", "question", "resolution-update"]);

function text(value, { fallback = "", max = 500, field = "Value" } = {}) {
  const result = String(value ?? fallback).trim();
  if (result.length > max) throw new Error(`${field} must be ${max} characters or fewer.`);
  return result;
}

function participantId() {
  return `PART-${randomBytes(6).toString("hex").toUpperCase()}`;
}

function contributionId() {
  return `CONT-${randomBytes(7).toString("hex").toUpperCase()}`;
}

export function createCaseParticipantInvitation(caseRecord, input = {}, now = Date.now()) {
  if (!caseRecord?.id) throw new Error("Support case is required.");
  const name = text(input.name, { fallback: "External participant", max: 120, field: "Participant name" });
  const organization = text(input.organization, { fallback: "External organisation", max: 180, field: "Participant organisation" });
  const role = String(input.role || "contributor").toLowerCase();
  if (!ROLES.has(role)) throw new Error("Participant role is not supported.");
  const ttlMinutes = Number(input.ttlMinutes ?? 24 * 60);
  if (!Number.isFinite(ttlMinutes) || ttlMinutes < 15 || ttlMinutes > 7 * 24 * 60) {
    throw new Error("Participant invitation TTL must be between 15 minutes and 7 days.");
  }

  const rawToken = generateCredential("fl_case");
  const createdAt = new Date(now).toISOString();
  const invitation = {
    id: participantId(),
    name,
    organization,
    role,
    tokenHash: hashCredential(rawToken),
    createdAt,
    expiresAt: new Date(now + Math.round(ttlMinutes) * 60_000).toISOString(),
    revokedAt: null,
    lastAccessAt: null
  };

  const updated = recordCaseEvent({
    ...caseRecord,
    participantInvitations: [...(caseRecord.participantInvitations || []), invitation].slice(-100)
  }, {
    type: "participant.invited",
    actor: "engineer",
    source: "case-room",
    summary: `${name} from ${organization} invited as ${role}.`,
    evidenceKind: "annotation",
    metadata: { participantId: invitation.id, role }
  }, now);

  return { caseRecord: updated, invitation: publicParticipant(invitation, now), token: rawToken };
}

export function findParticipantAccess(cases = [], token, now = Date.now()) {
  if (!token) return null;
  for (const caseRecord of cases) {
    const invitation = (caseRecord.participantInvitations || []).find(item => verifyCredential(token, item.tokenHash));
    if (!invitation) continue;
    if (invitation.revokedAt || Date.parse(invitation.expiresAt) <= now) return null;
    return { caseRecord, invitation };
  }
  return null;
}

export function touchParticipant(caseRecord, participantIdValue, now = Date.now()) {
  const invitations = (caseRecord.participantInvitations || []).map(item => item.id === participantIdValue
    ? { ...item, lastAccessAt: new Date(now).toISOString() }
    : item);
  return { ...caseRecord, participantInvitations: invitations, updatedAt: new Date(now).toISOString() };
}

export function revokeCaseParticipant(caseRecord, participantIdValue, now = Date.now()) {
  const existing = (caseRecord.participantInvitations || []).find(item => item.id === participantIdValue);
  if (!existing) {
    const error = new Error("Case participant was not found.");
    error.statusCode = 404;
    throw error;
  }
  const revokedAt = new Date(now).toISOString();
  const invitations = caseRecord.participantInvitations.map(item => item.id === participantIdValue
    ? { ...item, tokenHash: null, revokedAt }
    : item);
  return recordCaseEvent({ ...caseRecord, participantInvitations: invitations }, {
    type: "participant.revoked",
    actor: "engineer",
    source: "case-room",
    summary: `${existing.name} participant access revoked.`,
    evidenceKind: "annotation",
    metadata: { participantId: existing.id }
  }, now);
}

export function addParticipantContribution(caseRecord, invitation, input = {}, now = Date.now()) {
  if (invitation?.role !== "contributor") {
    const error = new Error("This participant has read-only access.");
    error.statusCode = 403;
    throw error;
  }
  const kind = String(input.kind || "observation").toLowerCase();
  if (!KINDS.has(kind)) throw new Error("Contribution kind is not supported.");
  const summary = text(input.summary ?? input.body, { max: 2400, field: "Contribution" });
  if (!summary) throw new Error("Contribution cannot be empty.");
  const measurements = input.measurements && typeof input.measurements === "object"
    ? Object.fromEntries(Object.entries(input.measurements).slice(0, 50).map(([key, value]) => [text(key, { max: 80, field: "Measurement key" }), value]))
    : null;
  const at = new Date(now).toISOString();
  const contribution = {
    id: contributionId(),
    participantId: invitation.id,
    participantName: invitation.name,
    organization: invitation.organization,
    kind,
    summary,
    measurements,
    at
  };
  const updated = recordCaseEvent({
    ...caseRecord,
    contributions: [...(caseRecord.contributions || []), contribution].slice(-500)
  }, {
    type: "participant.contribution",
    at,
    actor: invitation.name,
    source: invitation.organization,
    summary,
    evidenceKind: kind === "counter-evidence" ? "observed" : "annotation",
    metadata: { contributionId: contribution.id, participantId: invitation.id, kind }
  }, now);
  return { caseRecord: updated, contribution };
}

export function publicParticipant(invitation, now = Date.now()) {
  return {
    id: invitation.id,
    name: invitation.name,
    organization: invitation.organization,
    role: invitation.role,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    revokedAt: invitation.revokedAt || null,
    lastAccessAt: invitation.lastAccessAt || null,
    status: invitation.revokedAt ? "revoked" : Date.parse(invitation.expiresAt) <= now ? "expired" : "active"
  };
}

export function sharedCaseView(caseRecord, evidencePackage = null, now = Date.now()) {
  return {
    id: caseRecord.id,
    title: caseRecord.title,
    affectedService: caseRecord.affectedService,
    severity: caseRecord.severity,
    status: caseRecord.status,
    createdAt: caseRecord.createdAt,
    updatedAt: caseRecord.updatedAt,
    resolution: caseRecord.resolution || null,
    participants: (caseRecord.participantInvitations || []).map(item => publicParticipant(item, now)),
    contributions: structuredClone(caseRecord.contributions || []),
    timeline: (caseRecord.timeline || []).map(event => ({
      id: event.id,
      type: event.type,
      at: event.at,
      actor: event.actor,
      source: event.source,
      summary: event.summary,
      evidenceKind: event.evidenceKind,
      sessionId: event.sessionId || null
    })),
    evidence: evidencePackage
  };
}
