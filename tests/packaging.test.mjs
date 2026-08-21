// Packaging.
//
// The hosted deployment installs Faultline as a package, so what npm packs is
// what the hosted runtime can actually read. `fixtures/recorder/` looks like
// test data because of its name, but it is RUNTIME data: simulate.mjs loads it
// through loadScenario(), and the demo's recorded investigations replay those
// scenarios. It was excluded in .npmignore alongside tests/, which produced a
// package whose /api/demo/incidents/* routes returned 404 on a clean deploy
// while working perfectly from a git checkout - the worst kind of bug, because
// every local check passes.
//
// So this asserts the packed tarball against the demo catalogue itself rather
// than against a hard-coded list: adding a recorded investigation whose
// scenario would not ship now fails here instead of in production.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DEMO_INCIDENTS } from "../src/demo/catalogue.mjs";

/**
 * npm's own CLI entrypoint, run under this Node rather than through a shell.
 *
 * `shell: true` would concatenate arguments unescaped (Node warns about it),
 * and naming `npm.cmd` directly does not spawn on Windows without one. Running
 * npm-cli.js with process.execPath avoids both and keeps the test to a single
 * child process on every platform.
 */
function npmCli() {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ].filter(Boolean);
  return candidates.find(path => path.endsWith(".js") && existsSync(path)) || null;
}

/** File list npm would publish, straight from npm rather than re-derived. */
function packedFiles() {
  const cli = npmCli();
  // Skipping would quietly drop the one check that catches a packaging
  // regression, so an unlocatable npm is a failure rather than a pass.
  assert.ok(cli, "could not locate npm's CLI entrypoint to verify the package contents");

  const raw = execFileSync(process.execPath, [cli, "pack", "--dry-run", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    // npm writes its progress/notice output to stderr; only stdout is JSON.
    stdio: ["ignore", "pipe", "ignore"]
  });
  const parsed = JSON.parse(raw);
  return parsed[0].files.map(entry => entry.path.replace(/\\/g, "/"));
}

test("every scenario the demo catalogue names is in the packed runtime", { timeout: 120_000 }, () => {
  const files = new Set(packedFiles());

  assert.ok(DEMO_INCIDENTS.length > 0, "the catalogue must name at least one investigation");

  for (const entry of DEMO_INCIDENTS) {
    const scenarioPath = `fixtures/recorder/${entry.scenario}.json`;
    assert.ok(
      files.has(scenarioPath),
      `${scenarioPath} is required by the recorded investigation "${entry.slug}" but would not be packaged. `
        + "A hosted deployment would serve 404 for /api/demo/incidents/" + entry.slug + "."
    );
  }
});

test("the packaged runtime carries the code the server actually loads", { timeout: 120_000 }, () => {
  const files = new Set(packedFiles());

  for (const required of [
    "server.mjs",
    "package.json",
    "src/server.mjs",
    "src/recorder/simulate.mjs",
    "src/demo/routes.mjs",
    "src/demo/investigations.mjs",
    "src/runtime/capabilities.mjs",
    "public/index.html",
    "public/demo-panel.js",
    "public/css/faultline.css",
    "public/css/demo.css"
  ]) {
    assert.ok(files.has(required), `${required} must be packaged`);
  }
});

test("the container image copies the scenarios too", () => {
  // The Dockerfile enumerates what it copies rather than copying the tree, so
  // it can omit runtime data exactly the way .npmignore did. Same defect, other
  // artefact: without this the image serves an empty /api/recorder/scenarios.
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(
    dockerfile,
    /^COPY .*\bfixtures\b/m,
    "Dockerfile must COPY fixtures/ - simulate.mjs reads it at runtime"
  );
});

test("packaging stays narrow: development-only trees are still excluded", { timeout: 120_000 }, () => {
  const files = packedFiles();

  // The fixtures fix must not have widened the package into everything else.
  for (const prefix of ["tests/", "docs/", "build/", ".github/", "coverage/", "data/", ".qa-patch/"]) {
    const leaked = files.filter(path => path.startsWith(prefix));
    assert.deepEqual(leaked, [], `${prefix} must not be packaged`);
  }

  for (const path of ["Dockerfile", "docker-compose.yml", "ROADMAP.md", ".dockerignore"]) {
    assert.ok(!files.includes(path), `${path} must not be packaged`);
  }
});
