import test from "node:test";
import assert from "node:assert/strict";
import { normaliseProbeTarget } from "../src/probe/network.mjs";

test("normalises HTTPS targets for the remote probe", () => {
  assert.deepEqual(normaliseProbeTarget("https://example.com/health"), {
    input: "https://example.com/health",
    host: "example.com",
    port: 443,
    url: "https://example.com/health"
  });
});

test("normalises hostnames to HTTPS and default port 443", () => {
  assert.deepEqual(normaliseProbeTarget("example.com"), {
    input: "example.com",
    host: "example.com",
    port: 443,
    url: "https://example.com/"
  });
});

test("preserves explicit probe port", () => {
  assert.equal(normaliseProbeTarget("example.com", 8443).port, 8443);
});
