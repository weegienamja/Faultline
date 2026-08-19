import { randomBytes } from "node:crypto";

const STATUSES = new Set(["open", "investigating", "monitoring", "resolved", "closed"]);
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);

function text(value, { fallback = "", max = 240, field = "Value" } = {}) {
  const result = String(value ?? fallback).trim();
  if (result.length > max) throw new Error(`${field} must be ${max} characters or fewer.`);
  return result;
}

function enumValue(value, allowed, fallback, field) {
  const result = String(value || fallback).trim().toLowerCase();
  if (!allowed.has(result)) throw new Error(`${field} is not supported.`);
  return result;
}

function eventId(prefix = "EVT") {
  return `${prefix}-${randomBytes(6).toString("hex").toUpperCase()}`;
}

export function createSupportCase(input = {}, now = Date.now()) {
  const createdAt = new Date(now).toISOString();
  const title = text(input.title, { fallback: "Network connectivity incident", max: 180, field: "Case title" });
  const customer = text(input.customer, { fallback: "Unassigned customer", max: 180, field: "Customer" });
  const affectedService = text(input.affectedService, { fallback: "Unknown service", max: 180, field: "Affected service" });
  const severity = enumValue(input.severity, SEVERITIES, "medium", "Case severity");
  const status = enumValue(input.status, STATUSES, "open", "Case status");
  const tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.map(item => text(item, { max: 48, field: "Case tag" }).toLowerCase()).filter(Boolean))].slice(0, 20)
    : [];

  const id = `CASE-${randomBytes(7).toString("hex").toUpperCase()}`;
  return {
    id,
    title,
    customer,
    affectedService,
    severity,
    status,
    tags,
    sessionIds: [],
    notes: [],
    timeline: [{
      id: eventId(),
      type: "case.created",
      at: createdAt,
      actor: "engineer",
      source: "control-plane",
      summary: "Support case created.",
      sessionId: null,
      evidenceKind: "observed"
    }],
    resolution: null,
    createdAt,
    updatedAt: createdAt
  };
}

export function updateSupportCase(caseRecord, input = {}, now = Date.now()) {
  if (!caseRecord?.id) throw new Error("Support case is required.");
  const updatedAt = new Date(now).toISOString();
  const updated = {
    ...caseRecord,
    ...(input.title != null ? { title: text(input.title, { max: 180, field: "Case title" }) } : {}),
    ...(input.customer != null ? { customer: text(input.customer, { max: 180, field: "Customer" }) } : {}),
    ...(input.affectedService != null ? { affectedService: text(input.affectedService, { max: 180, field: "Affected service" }) } : {}),
    ...(input.severity != null ? { severity: enumValue(input.severity, SEVERITIES, caseRecord.severity, "Case severity") } : {}),
    ...(input.status != null ? { status: enumValue(input.status, STATUSES, caseRecord.status, "Case status") } : {}),
    ...(Array.isArray(input.tags) ? {
      tags: [...new Set(input.tags.map(item => text(item, { max: 48, field: "Case tag" }).toLowerCase()).filter(Boolean))].slice(0, 20)
    } : {}),
    updatedAt
  };

  if (updated.status !== caseRecord.status) {
    updated.timeline = appendTimeline(caseRecord.timeline, {
      type: "case.status_changed",
      at: updatedAt,
      actor: "engineer",
      source: "control-plane",
      summary: `Case status changed from ${caseRecord.status} to ${updated.status}.`,
      evidenceKind: "observed"
    });
  }

  if (input.resolution != null) {
    const summary = text(input.resolution, { max: 1200, field: "Resolution" });
    updated.resolution = summary ? { summary, recordedAt: updatedAt } : null;
    updated.timeline = appendTimeline(updated.timeline || caseRecord.timeline, {
      type: "case.resolution_recorded",
      at: updatedAt,
      actor: "engineer",
      source: "control-plane",
      summary: summary || "Case resolution cleared.",
      evidenceKind: "observed"
    });
  }

  return updated;
}

function appendTimeline(current = [], event = {}) {
  const at = event.at || new Date().toISOString();
  const next = [...current, {
    id: event.id || eventId(),
    type: text(event.type, { fallback: "case.event", max: 80, field: "Event type" }),
    at,
    actor: text(event.actor, { fallback: "system", max: 120, field: "Event actor" }),
    source: text(event.source, { fallback: "faultline", max: 120, field: "Event source" }),
    summary: text(event.summary, { fallback: "Case event", max: 1000, field: "Event summary" }),
    sessionId: event.sessionId ? text(event.sessionId, { max: 120, field: "Session id" }) : null,
    evidenceKind: enumValue(event.evidenceKind, new Set(["observed", "inferred", "deterministic", "statistical", "annotation"]), "observed", "Evidence kind"),
    metadata: event.metadata && typeof event.metadata === "object" ? structuredClone(event.metadata) : null
  }];
  return next.slice(-500);
}

export function addCaseNote(caseRecord, input = {}, now = Date.now()) {
  if (!caseRecord?.id) throw new Error("Support case is required.");
  const body = text(input.body ?? input.text, { max: 2000, field: "Case note" });
  if (!body) throw new Error("Case note cannot be empty.");
  const at = new Date(now).toISOString();
  const author = text(input.author, { fallback: "Engineer", max: 120, field: "Note author" });
  const note = { id: eventId("NOTE"), at, author, body };
  return {
    caseRecord: {
      ...caseRecord,
      notes: [...(caseRecord.notes || []), note].slice(-200),
      timeline: appendTimeline(caseRecord.timeline, {
        type: "case.note_added",
        at,
        actor: author,
        source: "engineer-note",
        summary: body,
        evidenceKind: "annotation"
      }),
      updatedAt: at
    },
    note
  };
}

export function attachSessionToCase(caseRecord, sessionId, now = Date.now()) {
  if (!caseRecord?.id) throw new Error("Support case is required.");
  const id = text(sessionId, { max: 120, field: "Session id" });
  if (!id) throw new Error("Session id is required.");
  if ((caseRecord.sessionIds || []).includes(id)) return caseRecord;
  const at = new Date(now).toISOString();
  return {
    ...caseRecord,
    sessionIds: [...(caseRecord.sessionIds || []), id],
    timeline: appendTimeline(caseRecord.timeline, {
      type: "diagnostic.attached",
      at,
      actor: "engineer",
      source: "control-plane",
      summary: `Diagnostic ${id} attached to case.`,
      sessionId: id,
      evidenceKind: "observed"
    }),
    updatedAt: at
  };
}

export function recordCaseEvent(caseRecord, event = {}, now = Date.now()) {
  if (!caseRecord?.id) throw new Error("Support case is required.");
  const at = event.at || new Date(now).toISOString();
  return {
    ...caseRecord,
    timeline: appendTimeline(caseRecord.timeline, { ...event, at }),
    updatedAt: at
  };
}

export function publicCase(caseRecord, { sessions = [], runs = [] } = {}) {
  const sessionIds = caseRecord.sessionIds || [];
  const runBySession = new Map(runs.map(run => [run.sessionId || run.id, run]));
  const completedRuns = sessionIds.filter(id => runBySession.has(id)).length;
  return {
    ...structuredClone(caseRecord),
    diagnosticCount: sessionIds.length,
    completedDiagnosticCount: completedRuns,
    sessions: sessions.map(session => ({
      id: session.id,
      title: session.title,
      target: session.target,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      mode: session.mode || "direct",
      connectivityContract: session.connectivityContract ? {
        id: session.connectivityContract.id,
        name: session.connectivityContract.name,
        version: session.connectivityContract.version
      } : null,
      hasEvidence: runBySession.has(session.id)
    }))
  };
}

export const caseStatuses = [...STATUSES];
export const caseSeverities = [...SEVERITIES];
