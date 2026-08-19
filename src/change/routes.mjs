import {
  buildChangeAssurancePackage,
  compareChangeRuns,
  createChangeWindow,
  setChangeBaseline,
  setChangePostRun
} from "./service.mjs";

function notFound(message) { const error = new Error(message); error.statusCode = 404; throw error; }
function conflict(message) { const error = new Error(message); error.statusCode = 409; throw error; }

export function createChangeAssuranceRouter({ store, requireAdmin, bodyFrom, json }) {
  async function getCase(caseId) {
    const caseRecord = await store.getCase(caseId);
    if (!caseRecord) notFound(`Support case ${caseId} was not found.`);
    return caseRecord;
  }

  function findWindow(caseRecord, changeId) {
    const item = (caseRecord.changeWindows || []).find(change => change.id === changeId);
    if (!item) notFound(`Change window ${changeId} was not found.`);
    return item;
  }

  async function getCaseRun(caseRecord, sessionId) {
    if (!(caseRecord.sessionIds || []).includes(sessionId)) conflict(`Diagnostic ${sessionId} is not attached to case ${caseRecord.id}.`);
    const run = await store.getRun(sessionId);
    if (!run) conflict(`Diagnostic ${sessionId} does not yet have endpoint evidence.`);
    return run;
  }

  async function saveWindow(caseRecord, updated) {
    const windows = [...(caseRecord.changeWindows || [])];
    const index = windows.findIndex(item => item.id === updated.id);
    if (index >= 0) windows[index] = updated; else windows.push(updated);
    const saved = { ...caseRecord, changeWindows: windows, updatedAt: new Date().toISOString() };
    await store.putCase(saved);
    return saved;
  }

  async function comparison(caseRecord, changeWindow) {
    if (!changeWindow.baselineSessionId || !changeWindow.postChangeSessionId) conflict("Both baseline and post-change diagnostics are required before comparison.");
    const before = await getCaseRun(caseRecord, changeWindow.baselineSessionId);
    const after = await getCaseRun(caseRecord, changeWindow.postChangeSessionId);
    return { before, after, comparison: compareChangeRuns(before, after) };
  }

  async function handle(req, res, url) {
    if (!url.pathname.includes("/change-windows")) return false;
    requireAdmin(req);

    const collection = url.pathname.match(/^\/api\/cases\/([^/]+)\/change-windows$/);
    if (collection) {
      const caseRecord = await getCase(decodeURIComponent(collection[1]));
      if (req.method === "GET") { json(res, 200, structuredClone(caseRecord.changeWindows || [])); return true; }
      if (req.method === "POST") {
        const payload = await bodyFrom(req);
        const changeWindow = createChangeWindow(payload);
        const saved = await saveWindow(caseRecord, changeWindow);
        await store.appendAudit({ at: new Date().toISOString(), type: "change.created", probeId: null, details: { caseId: saved.id, changeId: changeWindow.id, changeType: changeWindow.changeType } });
        json(res, 201, changeWindow);
        return true;
      }
    }

    const actionMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/change-windows\/([^/]+)(?:\/(baseline|post-change|comparison|evidence))?$/);
    if (!actionMatch) return false;
    const caseRecord = await getCase(decodeURIComponent(actionMatch[1]));
    const changeId = decodeURIComponent(actionMatch[2]);
    const action = actionMatch[3] || null;
    const changeWindow = findWindow(caseRecord, changeId);

    if (req.method === "GET" && !action) { json(res, 200, structuredClone(changeWindow)); return true; }

    if (req.method === "POST" && action === "baseline") {
      const payload = await bodyFrom(req);
      await getCaseRun(caseRecord, String(payload.sessionId || ""));
      const updated = setChangeBaseline(changeWindow, payload.sessionId);
      await saveWindow(caseRecord, updated);
      await store.appendAudit({ at: new Date().toISOString(), type: "change.baseline_selected", probeId: null, details: { caseId: caseRecord.id, changeId, sessionId: updated.baselineSessionId } });
      json(res, 200, updated);
      return true;
    }

    if (req.method === "POST" && action === "post-change") {
      const payload = await bodyFrom(req);
      await getCaseRun(caseRecord, String(payload.sessionId || ""));
      const updated = setChangePostRun(changeWindow, payload.sessionId);
      const saved = await saveWindow(caseRecord, updated);
      const result = await comparison(saved, updated);
      await store.appendAudit({ at: new Date().toISOString(), type: "change.compared", probeId: null, details: { caseId: caseRecord.id, changeId, outcome: result.comparison.outcome, regressions: result.comparison.regressions.length } });
      json(res, 200, { change: updated, comparison: result.comparison });
      return true;
    }

    if (req.method === "GET" && action === "comparison") {
      json(res, 200, (await comparison(caseRecord, changeWindow)).comparison);
      return true;
    }

    if (req.method === "GET" && action === "evidence") {
      const result = await comparison(caseRecord, changeWindow);
      json(res, 200, buildChangeAssurancePackage(changeWindow, result.before, result.after, caseRecord));
      return true;
    }

    return false;
  }

  return { handle };
}
