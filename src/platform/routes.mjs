import {
  addCaseNote,
  attachSessionToCase,
  createSupportCase,
  publicCase,
  recordCaseEvent,
  updateSupportCase
} from "../cases/service.mjs";
import { buildCaseEvidencePackage, redactCaseEvidence, renderEvidenceHtml } from "../cases/evidence.mjs";

function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  throw error;
}

function safeFilename(value) {
  return String(value || "faultline-case").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "faultline-case";
}

export function createPlatformRouter({ store, requireAdmin, bodyFrom, json, createSession, publicSession }) {
  async function getCase(id) {
    const caseRecord = await store.getCase(id);
    if (!caseRecord) notFound(`Support case ${id} was not found.`);
    return caseRecord;
  }

  async function caseContext(caseRecord) {
    const sessions = await store.listSessionsByCase(caseRecord.id);
    const runs = await store.listRunsForSessions(caseRecord.sessionIds || []);
    return { sessions, runs };
  }

  async function evidenceFor(caseRecord, redaction = "none") {
    const context = await caseContext(caseRecord);
    const built = buildCaseEvidencePackage(caseRecord, context);
    return redaction && redaction !== "none" ? redactCaseEvidence(built, redaction) : built;
  }

  async function createCaseDiagnostic(caseRecord, payload) {
    const created = await createSession({
      ...payload,
      caseId: caseRecord.id,
      customer: payload.customer || caseRecord.customer,
      title: payload.title || `${caseRecord.title} · diagnostic`,
      ephemeral: payload.ephemeral !== false
    });
    const updatedCase = attachSessionToCase(caseRecord, created.session.id);
    await store.putCase(updatedCase);
    return { created, caseRecord: updatedCase };
  }

  async function handle(req, res, url) {
    if (!url.pathname.startsWith("/api/cases")) return false;
    requireAdmin(req);

    if (req.method === "POST" && url.pathname === "/api/cases") {
      const payload = await bodyFrom(req);
      const caseRecord = createSupportCase(payload);
      await store.putCase(caseRecord);
      await store.appendAudit({
        at: new Date().toISOString(),
        type: "case.created",
        probeId: null,
        details: { caseId: caseRecord.id, severity: caseRecord.severity }
      });
      json(res, 201, publicCase(caseRecord));
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/cases") {
      const cases = await store.listCases();
      const sessions = await store.listSessions();
      const runs = await store.listRuns(5000);
      json(res, 200, cases.map(caseRecord => publicCase(caseRecord, {
        sessions: sessions.filter(session => session.caseId === caseRecord.id),
        runs: runs.filter(run => (caseRecord.sessionIds || []).includes(run.sessionId || run.id))
      })));
      return true;
    }

    const match = url.pathname.match(/^\/api\/cases\/([^/]+)(?:\/(notes|diagnostics|evidence|report|compare))?$/);
    if (!match) return false;
    const id = decodeURIComponent(match[1]);
    const action = match[2] || null;
    const caseRecord = await getCase(id);

    if (req.method === "GET" && !action) {
      json(res, 200, publicCase(caseRecord, await caseContext(caseRecord)));
      return true;
    }

    if (req.method === "PATCH" && !action) {
      const payload = await bodyFrom(req);
      const updated = updateSupportCase(caseRecord, payload);
      await store.putCase(updated);
      json(res, 200, publicCase(updated, await caseContext(updated)));
      return true;
    }

    if (req.method === "POST" && action === "notes") {
      const payload = await bodyFrom(req);
      const result = addCaseNote(caseRecord, payload);
      await store.putCase(result.caseRecord);
      json(res, 201, { note: result.note, case: publicCase(result.caseRecord, await caseContext(result.caseRecord)) });
      return true;
    }

    if (req.method === "POST" && action === "diagnostics") {
      const payload = await bodyFrom(req);
      const result = await createCaseDiagnostic(caseRecord, payload);
      json(res, 201, {
        case: publicCase(result.caseRecord, await caseContext(result.caseRecord)),
        session: publicSession(result.created.session),
        credentials: result.created.credentials,
        invitation: result.created.credentials.invitationToken ? {
          path: `/diagnose#invite=${encodeURIComponent(result.created.credentials.invitationToken)}`
        } : null
      });
      return true;
    }

    if (req.method === "GET" && action === "evidence") {
      const redaction = url.searchParams.get("redaction") || "none";
      const packageData = await evidenceFor(caseRecord, redaction);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${safeFilename(caseRecord.id)}-evidence.json"`
      });
      res.end(`${JSON.stringify(packageData, null, 2)}\n`);
      return true;
    }

    if (req.method === "GET" && action === "report") {
      const redaction = url.searchParams.get("redaction") || "none";
      const packageData = await evidenceFor(caseRecord, redaction);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-disposition": `inline; filename="${safeFilename(caseRecord.id)}-evidence.html"`
      });
      res.end(renderEvidenceHtml(packageData));
      return true;
    }

    if (req.method === "GET" && action === "compare") {
      const packageData = await evidenceFor(caseRecord, "none");
      json(res, 200, packageData.comparison);
      return true;
    }

    return false;
  }

  async function recordSessionEvidence(session, type, { summary, evidenceKind = "observed", metadata = null } = {}) {
    if (!session?.caseId) return null;
    const caseRecord = await store.getCase(session.caseId);
    if (!caseRecord) return null;
    const duplicate = (caseRecord.timeline || []).some(event => event.type === type && event.sessionId === session.id);
    if (duplicate) return caseRecord;
    const updated = recordCaseEvent(caseRecord, {
      type,
      sessionId: session.id,
      actor: "faultline",
      source: "diagnostic",
      summary: summary || `${type} received for ${session.id}.`,
      evidenceKind,
      metadata
    });
    await store.putCase(updated);
    return updated;
  }

  return { handle, recordSessionEvidence, evidenceFor };
}
