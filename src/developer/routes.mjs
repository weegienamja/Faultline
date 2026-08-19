import { createSupportCase, attachSessionToCase, publicCase } from "../cases/service.mjs";

function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  throw error;
}

function cleanExternalRef(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > 160) throw new Error("externalRef must be 160 characters or fewer.");
  return text;
}

function publicApiCase(caseRecord, context = {}) {
  return {
    ...publicCase(caseRecord, context),
    externalRef: caseRecord.externalRef || null,
    apiVersion: "v1"
  };
}

export function createDeveloperRouter({ store, requireAdmin, bodyFrom, json, createSession, publicSession, evidenceFor }) {
  async function getCase(id) {
    const caseRecord = await store.getCase(id);
    if (!caseRecord) notFound(`Support case ${id} was not found.`);
    return caseRecord;
  }

  async function contextFor(caseRecord) {
    const sessions = await store.listSessionsByCase(caseRecord.id);
    const runs = await store.listRunsForSessions(caseRecord.sessionIds || []);
    return { sessions, runs };
  }

  async function createDiagnostic(caseRecord, diagnostic = {}) {
    const created = await createSession({
      ...diagnostic,
      caseId: caseRecord.id,
      customer: diagnostic.customer || caseRecord.customer,
      title: diagnostic.title || `${caseRecord.title} · diagnostic`,
      ephemeral: diagnostic.ephemeral !== false
    });
    const updatedCase = attachSessionToCase(caseRecord, created.session.id);
    await store.putCase(updatedCase);
    return { created, caseRecord: updatedCase };
  }

  async function handle(req, res, url) {
    if (!url.pathname.startsWith("/api/v1")) return false;
    requireAdmin(req);

    if (req.method === "POST" && url.pathname === "/api/v1/diagnostics") {
      const payload = await bodyFrom(req);
      if (!payload?.target) throw new Error("target is required.");
      const caseRecord = {
        ...createSupportCase({
          title: payload.caseTitle || payload.title || "Embedded network diagnostic",
          customer: payload.customer || "External support portal",
          affectedService: payload.affectedService || payload.target,
          severity: payload.severity || "medium"
        }),
        externalRef: cleanExternalRef(payload.externalRef)
      };
      await store.putCase(caseRecord);
      const result = await createDiagnostic(caseRecord, payload);
      const invitationToken = result.created.credentials?.invitationToken || null;
      json(res, 201, {
        case: publicApiCase(result.caseRecord, await contextFor(result.caseRecord)),
        session: publicSession(result.created.session),
        invitation: invitationToken ? { path: `/diagnose#invite=${encodeURIComponent(invitationToken)}` } : null,
        correlation: { externalRef: result.caseRecord.externalRef || null, caseId: result.caseRecord.id, sessionId: result.created.session.id }
      });
      return true;
    }

    const match = url.pathname.match(/^\/api\/v1\/diagnostics\/([^/]+)(?:\/(runs|evidence|events))?$/);
    if (!match) return false;
    const id = decodeURIComponent(match[1]);
    const action = match[2] || null;
    const caseRecord = await getCase(id);

    if (req.method === "GET" && !action) {
      const context = await contextFor(caseRecord);
      json(res, 200, {
        case: publicApiCase(caseRecord, context),
        status: {
          caseStatus: caseRecord.status,
          sessionCount: context.sessions.length,
          completedRunCount: context.runs.length,
          latestRunAt: context.runs.map(item => item.updatedAt || item.collectedAt).filter(Boolean).sort().at(-1) || null
        }
      });
      return true;
    }

    if (req.method === "POST" && action === "runs") {
      const payload = await bodyFrom(req);
      if (!payload?.target) throw new Error("target is required.");
      const result = await createDiagnostic(caseRecord, payload);
      const invitationToken = result.created.credentials?.invitationToken || null;
      json(res, 201, {
        case: publicApiCase(result.caseRecord, await contextFor(result.caseRecord)),
        session: publicSession(result.created.session),
        invitation: invitationToken ? { path: `/diagnose#invite=${encodeURIComponent(invitationToken)}` } : null
      });
      return true;
    }

    if (req.method === "GET" && action === "evidence") {
      json(res, 200, await evidenceFor(caseRecord, url.searchParams.get("redaction") || "none"));
      return true;
    }

    if (req.method === "GET" && action === "events") {
      const timeline = [...(caseRecord.timeline || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
      json(res, 200, {
        caseId: caseRecord.id,
        externalRef: caseRecord.externalRef || null,
        events: timeline.map(event => ({
          id: event.id,
          type: event.type,
          occurredAt: event.at,
          sessionId: event.sessionId || null,
          evidenceKind: event.evidenceKind || null,
          summary: event.summary || null
        }))
      });
      return true;
    }

    return false;
  }

  return { handle };
}
