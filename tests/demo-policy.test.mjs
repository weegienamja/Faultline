// Public demo target policy.
//
// This is the boundary between an unauthenticated stranger and an outbound
// connection made by Faultline's hosted deployment. Every case below is a
// shape of SSRF or resource abuse that the endpoint has to refuse, so a
// regression here is a security regression rather than a cosmetic one.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DEMO_ALLOWLIST,
  DEMO_ALLOWED_PORTS,
  DemoPolicyError,
  createRedirectGuard,
  isAllowlisted,
  parseDemoTarget,
  readAllowlist,
  resolveDemoTarget,
  withTimeout
} from "../src/demo/policy.mjs";

const rejects = value => {
  assert.throws(() => parseDemoTarget(value), DemoPolicyError, `expected ${JSON.stringify(value)} to be refused`);
  try {
    parseDemoTarget(value);
    return null;
  } catch (error) {
    return error;
  }
};

test("accepts an allowlisted hostname and defaults to HTTPS on 443", () => {
  const target = parseDemoTarget("github.com");
  assert.equal(target.host, "github.com");
  assert.equal(target.port, 443);
  assert.equal(target.scheme, "https");
  assert.equal(target.url, "https://github.com/");
});

test("accepts a subdomain of an allowlisted apex", () => {
  assert.equal(parseDemoTarget("www.google.com").host, "www.google.com");
  assert.equal(parseDemoTarget("api.github.com").host, "api.github.com");
});

test("a suffix match is not a subdomain match", () => {
  // "notgithub.com" ends with "github.com" as a string but is a different
  // registrable domain, and "github.com.evil.test" is the classic confusion.
  assert.equal(isAllowlisted("notgithub.com", DEFAULT_DEMO_ALLOWLIST), false);
  assert.equal(isAllowlisted("github.com.evil.test", DEFAULT_DEMO_ALLOWLIST), false);
  assert.equal(rejects("notgithub.com").code, "DEMO_TARGET_NOT_ALLOWED");
  assert.equal(rejects("github.com.evil.test").code, "DEMO_TARGET_NOT_ALLOWED");
});

test("refuses literal IP addresses in every notation", () => {
  // A bare IPv6 literal is caught by the "no explicit port" rule before the
  // address rule, because a colon in a bare target can only mean a port here.
  // Which rule refuses it does not matter; that every one of them is refused
  // does.
  for (const value of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "[::1]", "::1", "0.0.0.0", "2001:4860:4860::8888"]) {
    const error = rejects(value);
    assert.match(error.message, /literal IP addresses|valid DNS hostname|fully qualified|explicit port/);
  }
});

test("refuses cloud metadata and internal service names", () => {
  for (const value of ["metadata.google.internal", "instance-data", "localhost", "consul.service.consul"]) {
    assert.ok(rejects(value));
  }
});

test("refuses credentials in the authority", () => {
  assert.ok(rejects("http://user:password@github.com/"));
  assert.ok(rejects("https://admin@github.com/"));
  // The bare form must not be silently reinterpreted either.
  assert.ok(rejects("user@github.com"));
});

test("refuses schemes that are not http or https", () => {
  for (const value of ["file:///etc/passwd", "gopher://github.com/", "ftp://github.com/", "dict://github.com:11211/", "ldap://github.com/"]) {
    assert.ok(rejects(value));
  }
});

test("refuses every port except 80 and 443", () => {
  assert.deepEqual([...DEMO_ALLOWED_PORTS], [80, 443]);
  for (const value of ["https://github.com:22/", "https://github.com:6379/", "https://github.com:8080/", "github.com:443"]) {
    assert.ok(rejects(value));
  }
  assert.equal(parseDemoTarget("http://example.com/").port, 80);
});

test("refuses control characters and oversized input", () => {
  assert.ok(rejects(`github.com${String.fromCharCode(10)}Host: evil.test`));
  assert.ok(rejects(`github.com${String.fromCharCode(0)}`));
  assert.ok(rejects(`${"a".repeat(250)}.github.com`));
});

test("drops the query and fragment from a URL target", () => {
  const target = parseDemoTarget("https://github.com/some/path?redirect=http://169.254.169.254#x");
  assert.equal(target.url, "https://github.com/some/path");
});

test("the allowlist is configurable but always falls back to the built-in list", () => {
  assert.deepEqual(readAllowlist({ FAULTLINE_DEMO_ALLOWLIST: "" }), [...DEFAULT_DEMO_ALLOWLIST]);
  assert.deepEqual(readAllowlist({ FAULTLINE_DEMO_ALLOWLIST: "   " }), [...DEFAULT_DEMO_ALLOWLIST]);
  // Entries that are not valid hostnames are discarded rather than trusted.
  assert.deepEqual(readAllowlist({ FAULTLINE_DEMO_ALLOWLIST: "!!!, ???" }), [...DEFAULT_DEMO_ALLOWLIST]);
  assert.deepEqual(readAllowlist({ FAULTLINE_DEMO_ALLOWLIST: "example.net, example.org" }), ["example.net", "example.org"]);
});

test("a custom allowlist is honoured by the parser", () => {
  const allowlist = ["example.net"];
  assert.equal(parseDemoTarget("example.net", { allowlist }).host, "example.net");
  assert.throws(() => parseDemoTarget("github.com", { allowlist }), DemoPolicyError);
});

test("resolution refuses a hostname whose answers are not globally routable", async () => {
  // Every address is checked, not just the first: a hostname that answers with
  // one public and one private address must be refused outright.
  const original = (await import("../src/security/target.mjs")).validateResolvedAddresses;
  assert.equal(typeof original, "function");
  assert.throws(
    () => original([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }], "public"),
    /blocked address 10\.0\.0\.5/
  );
  assert.throws(() => original([{ address: "169.254.169.254", family: 4 }], "public"), /link-local/);
  assert.throws(() => original([{ address: "::1", family: 6 }], "public"), /loopback/);
  assert.throws(() => original([{ address: "fd00::1", family: 6 }], "public"), /unique-local/);
  assert.throws(() => original([{ address: "::ffff:127.0.0.1", family: 6 }], "public"), /loopback/);
});

test("the redirect guard applies the same checks as the original target", async () => {
  const guard = createRedirectGuard({ allowlist: ["example.com"] });
  assert.equal(await guard("evil.test"), null, "off-allowlist redirect must be refused");
  assert.equal(await guard("127.0.0.1"), null, "literal address redirect must be refused");
  assert.equal(await guard("169.254.169.254"), null, "metadata address redirect must be refused");
  assert.equal(await guard(""), null);
  assert.equal(await guard("not a hostname"), null);
});

test("resolveDemoTarget rejects a name that does not resolve", async () => {
  await assert.rejects(
    () => resolveDemoTarget("this-name-should-not-exist.invalid", { timeoutMs: 3_000 }),
    error => error instanceof DemoPolicyError
  );
});

test("withTimeout rejects rather than hanging a Function", async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 20, "budget spent"),
    /budget spent/
  );
  assert.equal(await withTimeout(Promise.resolve("ok"), 1_000), "ok");
});
