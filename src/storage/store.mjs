import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const STATE_VERSION = 7;

function emptyState() {
  return { version: STATE_VERSION, sessions: [], runs: [], probes: [], audit: [], cases: [], organizations: [], projects: [], incidents: [], incidentEvidence: [] };
}

function normaliseState(value) {
  if (!value || typeof value !== "object") return emptyState();
  return {
    version: STATE_VERSION,
    sessions: Array.isArray(value.sessions) ? value.sessions : [],
    runs: Array.isArray(value.runs) ? value.runs : [],
    probes: Array.isArray(value.probes) ? value.probes : [],
    audit: Array.isArray(value.audit) ? value.audit : [],
    cases: Array.isArray(value.cases) ? value.cases : [],
    organizations: Array.isArray(value.organizations) ? value.organizations : [],
    projects: Array.isArray(value.projects) ? value.projects : [],
    // v6: closed Flight Recorder incidents. Absent in a v5 file, which loads
    // unchanged - the field simply starts empty.
    incidents: Array.isArray(value.incidents) ? value.incidents : [],
    // v7: evidence produced ABOUT an incident after it closed, most obviously a
    // Network Bisect run started from its candidate conditions. Kept separate
    // so the frozen incident stays the immutable artefact PR #20 established:
    // running another experiment must not rewrite the record of what was
    // observed.
    incidentEvidence: Array.isArray(value.incidentEvidence) ? value.incidentEvidence : []
  };
}

export function createStore(filePath) {
  let state = null;
  let writeQueue = Promise.resolve();
  async function load() { if (state) return state; try { state = normaliseState(JSON.parse(await readFile(filePath, "utf8"))); } catch (error) { if (error.code !== "ENOENT") throw error; state = emptyState(); } return state; }
  async function persist() { await mkdir(dirname(filePath), { recursive: true }); const tempPath = `${filePath}.${process.pid}.tmp`; await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); await rename(tempPath, filePath); }
  function mutate(fn) { const operation = writeQueue.then(async () => { await load(); const result = fn(state); await persist(); return result; }); writeQueue = operation.catch(() => {}); return operation; }
  const upsert = (collection, value) => mutate(current => { const index = current[collection].findIndex(item => item.id === value.id); if (index >= 0) current[collection][index] = value; else current[collection].unshift(value); return value; });

  return {
    async getSession(id) { await load(); return state.sessions.find(item => item.id === id) || null; },
    async listSessions() { await load(); return [...state.sessions]; },
    async listSessionsByCase(caseId) { await load(); return state.sessions.filter(item => item.caseId === caseId); },
    putSession(value) { return upsert("sessions", value); },
    async getRun(id) { await load(); return state.runs.find(item => item.id === id) || null; },
    async listRuns(limit = 10) { await load(); return [...state.runs].sort((a,b)=>Date.parse(b.updatedAt||b.collectedAt||0)-Date.parse(a.updatedAt||a.collectedAt||0)).slice(0, limit); },
    async listRunsForSessions(ids=[]) { await load(); const wanted=new Set(ids); return state.runs.filter(run=>wanted.has(run.sessionId||run.id)).sort((a,b)=>Date.parse(a.updatedAt||a.collectedAt||0)-Date.parse(b.updatedAt||b.collectedAt||0)); },
    putRun(value) { return upsert("runs", value); },
    async getProbe(id) { await load(); return state.probes.find(item => item.id === id) || null; },
    async listProbes() { await load(); return [...state.probes].sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""))); },
    putProbe(value) { return upsert("probes", value); },
    async getCase(id) { await load(); return state.cases.find(item => item.id === id) || null; },
    async listCases() { await load(); return [...state.cases].sort((a,b)=>Date.parse(b.updatedAt||b.createdAt||0)-Date.parse(a.updatedAt||a.createdAt||0)); },
    async listCasesByOrganization(organizationId) { await load(); return state.cases.filter(item => item.organizationId === organizationId); },
    async listCasesByProject(projectId) { await load(); return state.cases.filter(item => item.projectId === projectId); },
    putCase(value) { return upsert("cases", value); },
    async getOrganization(id) { await load(); return state.organizations.find(item => item.id === id) || null; },
    async listOrganizations() { await load(); return [...state.organizations]; },
    putOrganization(value) { return upsert("organizations", value); },
    async getProject(id) { await load(); return state.projects.find(item => item.id === id) || null; },
    async listProjects() { await load(); return [...state.projects]; },
    async listProjectsByOrganization(organizationId) { await load(); return state.projects.filter(item => item.organizationId === organizationId); },
    putProject(value) { return upsert("projects", value); },
    // Flight Recorder incidents. The rolling sample buffer is never persisted;
    // only a closed incident, which is a finished evidence artefact like a run.
    async getIncident(id) { await load(); return state.incidents.find(item => item.id === id) || null; },
    async listIncidents(limit = 20) { await load(); return [...state.incidents].slice(0, limit); },
    putIncident(value, { max = 20 } = {}) { return mutate(current => { const index = current.incidents.findIndex(item => item.id === value.id); if (index >= 0) current.incidents[index] = value; else current.incidents.unshift(value); current.incidents = current.incidents.slice(0, max); return value; }); },
    deleteIncident(id) { return mutate(current => { const before = current.incidents.length; current.incidents = current.incidents.filter(item => item.id !== id); const attachments = current.incidentEvidence.length; current.incidentEvidence = current.incidentEvidence.filter(item => item.incidentId !== id); return { removed: before !== current.incidents.length, attachmentsRemoved: attachments - current.incidentEvidence.length }; }); },
    async getIncidentEvidence(id) { await load(); return state.incidentEvidence.find(item => item.id === id) || null; },
    async listIncidentEvidence(incidentId) { await load(); return state.incidentEvidence.filter(item => item.incidentId === incidentId).sort((a,b)=>Date.parse(a.createdAt||0)-Date.parse(b.createdAt||0)); },
    putIncidentEvidence(value, { max = 100 } = {}) { return mutate(current => { const index = current.incidentEvidence.findIndex(item => item.id === value.id); if (index >= 0) current.incidentEvidence[index] = value; else current.incidentEvidence.unshift(value); current.incidentEvidence = current.incidentEvidence.slice(0, max); return value; }); },
    async listAudit(limit=100) { await load(); return [...state.audit].sort((a,b)=>Date.parse(b.at||0)-Date.parse(a.at||0)).slice(0,limit); },
    appendAudit(event) { return mutate(current => { current.audit.unshift(event); current.audit=current.audit.slice(0,1000); return event; }); }
  };
}
