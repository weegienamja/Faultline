import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../src/storage/store.mjs";

test("persists sessions and runs across store instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "faultline-store-"));
  const file = join(dir, "faultline.json");
  try {
    const first = createStore(file);
    await first.putSession({ id: "FL-TEST", target: { input: "example.com", port: 443 } });
    await first.putRun({ id: "FL-TEST", updatedAt: "2026-08-18T18:00:00.000Z", metrics: { targetReachable: true } });

    const second = createStore(file);
    assert.equal((await second.getSession("FL-TEST")).target.input, "example.com");
    assert.equal((await second.getRun("FL-TEST")).metrics.targetReachable, true);

    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.version, 1);
    assert.equal(raw.sessions.length, 1);
    assert.equal(raw.runs.length, 1);
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
