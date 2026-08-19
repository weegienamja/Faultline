import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { listConnectivityContracts, validateConnectivityContract } from "../src/contracts/registry.mjs";

// public/contracts.json is served to the browser so the dashboard can offer the
// built-in Connectivity Contracts without an extra API surface. It duplicates
// src/contracts/registry.mjs by hand, so drift would silently ship a contract
// the server would reject or evaluate differently.
const assetPath = fileURLToPath(new URL("../public/contracts.json", import.meta.url));

test("browser contract asset stays in sync with the built-in registry", async () => {
  const asset = JSON.parse(await readFile(assetPath, "utf8"));
  const builtins = listConnectivityContracts();

  assert.deepEqual(asset.map(item => item.id), builtins.map(item => item.id));
  for (const [index, entry] of asset.entries()) {
    assert.deepEqual(validateConnectivityContract(entry), builtins[index], `contract ${entry.id} differs from the built-in definition`);
  }
});
