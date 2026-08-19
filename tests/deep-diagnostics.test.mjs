import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { httpStageProbe, parseWindowsMtuPing, tcpAddressProbe } from "../src/diagnostics/deep.mjs";

test("parses Windows do-not-fragment MTU outcomes", () => {
  assert.deepEqual(parseWindowsMtuPing("Reply from 1.1.1.1: bytes=1472 time=8ms TTL=55"), { fits: true, reason: "reply" });
  assert.deepEqual(parseWindowsMtuPing("Packet needs to be fragmented but DF set."), { fits: false, reason: "fragmentation-required" });
  assert.deepEqual(parseWindowsMtuPing("Request timed out."), { fits: false, reason: "no-reply" });
});

test("captures HTTP response-stage timing against a local endpoint", async () => {
  const server = createServer((req, res) => { res.writeHead(204); res.end(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const result = await httpStageProbe(`http://127.0.0.1:${port}/health`);
    assert.equal(result.ok, true);
    assert.equal(result.status, 204);
    assert.ok(result.timings.ttfbMs >= 0);
    assert.ok(result.timings.totalMs >= result.timings.ttfbMs);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("records explicit address-family TCP reachability", async () => {
  const server = createServer((req, res) => res.end("ok"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const result = await tcpAddressProbe("127.0.0.1", port, 4, 1000);
    assert.equal(result.ok, true);
    assert.equal(result.family, 4);
    assert.equal(result.address, "127.0.0.1");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
