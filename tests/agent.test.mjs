import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateJitter,
  normaliseTarget,
  parsePingOutput,
  parseTracerouteOutput,
  routeMatches
} from "../src/agent/network.mjs";

test("parses Windows ping output into loss, latency and jitter", () => {
  const output = `
Pinging 1.1.1.1 with 32 bytes of data:
Reply from 1.1.1.1: bytes=32 time=12ms TTL=57
Reply from 1.1.1.1: bytes=32 time=18ms TTL=57
Reply from 1.1.1.1: bytes=32 time=15ms TTL=57
Reply from 1.1.1.1: bytes=32 time=17ms TTL=57

Ping statistics for 1.1.1.1:
    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),
Approximate round trip times in milli-seconds:
    Minimum = 12ms, Maximum = 18ms, Average = 15ms
`;
  const result = parsePingOutput(output, 4);
  assert.equal(result.lossPct, 0);
  assert.equal(result.replies, 4);
  assert.equal(result.averageMs, 15.5);
  assert.equal(result.jitterMs, 3.7);
});

test("infers packet loss if the summary is unavailable", () => {
  const output = "Reply from 192.168.1.1: bytes=32 time=2ms TTL=64\nReply from 192.168.1.1: bytes=32 time=3ms TTL=64";
  const result = parsePingOutput(output, 4);
  assert.equal(result.lossPct, 50);
});

test("calculates average adjacent-sample jitter", () => {
  assert.equal(Number(calculateJitter([10, 20, 15, 25]).toFixed(1)), 8.3);
});

test("parses useful traceroute hops without requiring hostnames", () => {
  const output = `
Tracing route to 1.1.1.1 over a maximum of 30 hops
  1     2 ms     1 ms     2 ms  192.168.1.1
  2    12 ms    11 ms    13 ms  10.20.0.1
  3     *        *        *     Request timed out.
`;
  const hops = parseTracerouteOutput(output);
  assert.equal(hops.length, 3);
  assert.deepEqual(hops[0], { hop: 1, ip: "192.168.1.1", averageRttMs: 1.7, timedOut: false });
  assert.equal(hops[2].timedOut, true);
});

test("normalises URL and hostname targets", () => {
  assert.deepEqual(normaliseTarget("https://example.com/health"), {
    input: "https://example.com/health",
    host: "example.com",
    port: 443,
    url: "https://example.com/health"
  });
  assert.equal(normaliseTarget("example.com").port, 443);
});

test("matches an expected VPN route exactly", () => {
  const routes = [{ DestinationPrefix: "0.0.0.0/0" }, { DestinationPrefix: "10.40.0.0/16" }];
  assert.equal(routeMatches(routes, "10.40.0.0/16"), true);
  assert.equal(routeMatches(routes, "10.50.0.0/16"), false);
});
