import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../src/storage/store.mjs";

test("persists sessions runs probes cases and audit events across store instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "faultline-store-"));
  const file = join(dir, "faultline.json");
  try {
    const first = createStore(file);
    await first.putSession({ id: "FL-TEST", caseId: "CASE-TEST", target: { input: "example.com", port: 443 } });
    await first.putRun({ id: "FL-TEST", sessionId: "FL-TEST", updatedAt: "2026-08-18T18:00:00.000Z", metrics: { targetReachable: true } });
    await first.putProbe({ id: "PRB-TEST", name: "london-1", tokenHash: "hash", enabled: true });
    await first.putCase({ id: "CASE-TEST", title: "Test case", createdAt: "2026-08-18T17:00:00.000Z", updatedAt: "2026-08-18T18:02:00.000Z", sessionIds: ["FL-TEST"] });
    await first.appendAudit({ at: "2026-08-18T18:01:00.000Z", type: "probe.registered", probeId: "PRB-TEST" });

    const second = createStore(file);
    assert.equal((await second.getSession("FL-TEST")).target.input, "example.com");
    assert.equal((await second.getRun("FL-TEST")).metrics.targetReachable, true);
    assert.equal((await second.getProbe("PRB-TEST")).name, "london-1");
    assert.equal((await second.getCase("CASE-TEST")).title, "Test case");
    assert.equal((await second.listSessionsByCase("CASE-TEST")).length, 1);
    assert.equal((await second.listRunsForSessions(["FL-TEST"])).length, 1);
    assert.equal((await second.listAudit())[0].type, "probe.registered");

    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.version, 4);
    assert.equal(raw.sessions.length, 1);
    assert.equal(raw.runs.length, 1);
    assert.equal(raw.probes.length, 1);
    assert.equal(raw.cases.length, 1);
    assert.equal(raw.audit.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrates v2 state by adding audit and case collections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "faultline-store-"));
  const file = join(dir, "faultline.json");
  try {
    await writeFile(file, JSON.stringify({ version: 2, sessions: [], runs: [], probes: [{ id: "PRB-OLD", name: "old" }] }));
    const store = createStore(file);
    assert.equal((await store.getProbe("PRB-OLD")).name, "old");
    assert.deepEqual(await store.listCases(), []);
    await store.appendAudit({ at: "2026-08-18T18:00:00.000Z", type: "migration.test" });
    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.version, 4);
    assert.equal(raw.audit.length, 1);
    assert.deepEqual(raw.cases, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("replaces an existing run instead of duplicating a session id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "faultline-store-"));
  const file = join(dir, "faultline.json");
  try {
    const store = createStore(file);
    await store.putRun({ id: "FL-TEST", updatedAt: "2026-08-18T18:00:00.000Z", source: "agent" });
    await store.putRun({ id: "FL-TEST", updatedAt: "2026-08-18T18:01:00.000Z", source: "correlated" });
    const runs = await store.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].source, "correlated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("replaces registered probes and cases by id instead of duplicating them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "faultline-store-"));
  const file = join(dir, "faultline.json");
  try {
    const store = createStore(file);
    await store.putProbe({ id: "PRB-TEST", name: "probe", lastSeenAt: null });
    await store.putProbe({ id: "PRB-TEST", name: "probe", lastSeenAt: "2026-08-18T18:01:00.000Z" });
    await store.putCase({ id: "CASE-TEST", title: "Before", updatedAt: "2026-08-18T18:00:00.000Z" });
    await store.putCase({ id: "CASE-TEST", title: "After", updatedAt: "2026-08-18T18:01:00.000Z" });
    const probes = await store.listProbes();
    const cases = await store.listCases();
    assert.equal(probes.length, 1);
    assert.equal(probes[0].lastSeenAt, "2026-08-18T18:01:00.000Z");
    assert.equal(cases.length, 1);
    assert.equal(cases[0].title, "After");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
