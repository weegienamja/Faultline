import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function emptyState() {
  return { version: 3, sessions: [], runs: [], probes: [], audit: [] };
}

function normaliseState(value) {
  if (!value || typeof value !== "object") return emptyState();
  return {
    version: 3,
    sessions: Array.isArray(value.sessions) ? value.sessions : [],
    runs: Array.isArray(value.runs) ? value.runs : [],
    probes: Array.isArray(value.probes) ? value.probes : [],
    audit: Array.isArray(value.audit) ? value.audit : []
  };
}

export function createStore(filePath) {
  let state = null;
  let writeQueue = Promise.resolve();

  async function load() {
    if (state) return state;
    try {
      state = normaliseState(JSON.parse(await readFile(filePath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = emptyState();
    }
    return state;
  }

  async function persist() {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, filePath);
  }

  function mutate(fn) {
    const operation = writeQueue.then(async () => {
      await load();
      const result = fn(state);
      await persist();
      return result;
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  return {
    async getSession(id) {
      await load();
      return state.sessions.find(session => session.id === id) || null;
    },

    async listSessions() {
      await load();
      return [...state.sessions];
    },

    putSession(session) {
      return mutate(current => {
        const index = current.sessions.findIndex(item => item.id === session.id);
        if (index >= 0) current.sessions[index] = session;
        else current.sessions.unshift(session);
        return session;
      });
    },

    async getRun(id) {
      await load();
      return state.runs.find(run => run.id === id) || null;
    },

    async listRuns(limit = 10) {
      await load();
      return [...state.runs]
        .sort((a, b) => Date.parse(b.updatedAt || b.collectedAt || 0) - Date.parse(a.updatedAt || a.collectedAt || 0))
        .slice(0, limit);
    },

    putRun(run) {
      return mutate(current => {
        const index = current.runs.findIndex(item => item.id === run.id);
        if (index >= 0) current.runs[index] = run;
        else current.runs.unshift(run);
        return run;
      });
    },

    async getProbe(id) {
      await load();
      return state.probes.find(probe => probe.id === id) || null;
    },

    async listProbes() {
      await load();
      return [...state.probes]
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    },

    putProbe(probe) {
      return mutate(current => {
        const index = current.probes.findIndex(item => item.id === probe.id);
        if (index >= 0) current.probes[index] = probe;
        else current.probes.unshift(probe);
        return probe;
      });
    },

    async listAudit(limit = 100) {
      await load();
      return [...state.audit]
        .sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0))
        .slice(0, limit);
    },

    appendAudit(event) {
      return mutate(current => {
        current.audit.unshift(event);
        current.audit = current.audit.slice(0, 1000);
        return event;
      });
    }
  };
}
