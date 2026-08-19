import test from "node:test";
import assert from "node:assert/strict";
import { normaliseManifestTarget, previewManifest, validateManifest } from "../src/environment/manifest.mjs";
import { parseLiveTarget } from "../src/live/measure.mjs";

const VALID = {
  version: 1,
  name: "Example environment",
  sites: [{ id: "glasgow", name: "Glasgow Office", location: "Glasgow, UK" }],
  targets: [
    { name: "Customer Portal", url: "https://example.com", scope: "public", contract: "secure-web" },
    { name: "Internal CRM", host: "10.40.12.25", port: 443, scope: "private", site: "glasgow", contract: "secure-web" }
  ]
};

test("accepts a well-formed manifest and summarises scope", () => {
  const manifest = validateManifest(VALID);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.summary.siteCount, 1);
  assert.equal(manifest.summary.targetCount, 2);
  assert.equal(manifest.summary.publicTargets, 1);
  assert.equal(manifest.summary.privateTargets, 1);
  assert.equal(manifest.summary.requiresPrivateProbe, true);
});

test("accepts a JSON string as well as an object", () => {
  const manifest = validateManifest(JSON.stringify(VALID));
  assert.equal(manifest.summary.targetCount, 2);
  assert.throws(() => validateManifest("{ not json"), /not valid JSON/);
});

test("a private literal address always requires a private probe", () => {
  const manifest = validateManifest(VALID);
  const crm = manifest.targets.find(t => t.name === "Internal CRM");
  assert.equal(crm.scope, "private");
  assert.equal(crm.requiresPrivateProbe, true);
  assert.equal(crm.addressClass, "private-literal");

  const portal = manifest.targets.find(t => t.name === "Customer Portal");
  assert.equal(portal.requiresPrivateProbe, false);
});

test("a private address can never be declared public in a manifest", () => {
  for (const host of ["10.40.12.25", "192.168.1.1", "127.0.0.1", "169.254.169.254", "172.16.0.9"]) {
    assert.throws(
      () => normaliseManifestTarget({ name: "Sneaky", host, scope: "public" }),
      /cannot be declared public/,
      host
    );
  }
});

test("a private address with no declared scope is still forced to private", () => {
  const target = normaliseManifestTarget({ name: "Unlabelled", host: "10.0.0.5" });
  assert.equal(target.scope, "private");
  assert.equal(target.requiresPrivateProbe, true);
});

test("credential-shaped fields are rejected outright, not silently dropped", () => {
  for (const field of ["password", "secret", "token", "apiKey", "api_key", "credential", "authorization", "privateKey", "passphrase"]) {
    assert.throws(
      () => validateManifest({ ...VALID, targets: [{ name: "X", url: "https://example.com", [field]: "hunter2" }] }),
      /must not contain credential fields/,
      field
    );
  }
  assert.throws(() => validateManifest({ ...VALID, password: "hunter2" }), /must not contain credential fields/);
});

test("unknown fields are rejected rather than carried through", () => {
  assert.throws(() => validateManifest({ ...VALID, evil: true }), /unsupported field "evil"/);
  assert.throws(
    () => validateManifest({ ...VALID, targets: [{ name: "X", url: "https://example.com", command: "rm -rf /" }] }),
    /unsupported field "command"/
  );
  assert.throws(
    () => validateManifest({ ...VALID, sites: [{ id: "a", name: "A", script: "x" }] }),
    /unsupported field "script"/
  );
});

test("structural validation rejects malformed manifests", () => {
  assert.throws(() => validateManifest(null), /must be a JSON object/);
  assert.throws(() => validateManifest([]), /must be a JSON object/);
  assert.throws(() => validateManifest({ version: 2, targets: [] }), /version must be 1/);
  assert.throws(() => validateManifest({ version: 1, targets: [] }), /at least one target/);
  assert.throws(() => validateManifest({ version: 1, targets: [{ url: "https://example.com" }] }), /name is required/);
  assert.throws(() => validateManifest({ version: 1, targets: [{ name: "X" }] }), /requires either a url or a host/);
  assert.throws(() => validateManifest({ version: 1, targets: [{ name: "X", url: "https://e.com", host: "e.com" }] }), /not both/);
  assert.throws(() => validateManifest({ version: 1, targets: [{ name: "X", url: "ftp://e.com" }] }), /must start with http/);
  assert.throws(() => validateManifest({ version: 1, targets: [{ name: "X", host: "e.com", port: 70000 }] }), /between 1 and 65535/);
  assert.throws(() => validateManifest({ version: 1, targets: [{ name: "X", host: "e.com", scope: "sideways" }] }), /must be public or private/);
});

test("targets may not reference an undeclared site", () => {
  assert.throws(
    () => validateManifest({ version: 1, sites: [{ id: "glasgow", name: "Glasgow" }], targets: [{ name: "X", url: "https://example.com", site: "london" }] }),
    /unknown site "london"/
  );
});

test("duplicate site ids are rejected", () => {
  assert.throws(
    () => validateManifest({ version: 1, sites: [{ id: "a", name: "A" }, { id: "a", name: "Another" }], targets: [{ name: "X", url: "https://example.com" }] }),
    /site ids must be unique/
  );
});

test("size limits bound a hostile manifest", () => {
  const many = Array.from({ length: 201 }, (_v, i) => ({ name: `T${i}`, url: "https://example.com" }));
  assert.throws(() => validateManifest({ version: 1, targets: many }), /at most 200 targets/);
  const manySites = Array.from({ length: 51 }, (_v, i) => ({ id: `s${i}`, name: `S${i}` }));
  assert.throws(() => validateManifest({ version: 1, sites: manySites, targets: [{ name: "X", url: "https://example.com" }] }), /at most 50 sites/);
});

test("preview explains the private-probe requirement without activating anything", () => {
  const preview = previewManifest(VALID);
  assert.equal(preview.preview, true);
  assert.match(preview.notes.join(" "), /require an authorised private probe/);
  assert.match(preview.notes.join(" "), /No credentials are accepted/);
});

test("preview of an all-public manifest states no private probe is needed", () => {
  const preview = previewManifest({ version: 1, targets: [{ name: "Portal", url: "https://example.com" }] });
  assert.equal(preview.summary.requiresPrivateProbe, false);
  assert.match(preview.notes.join(" "), /All targets are public/);
});

// The live target parser is the other place user input reaches the network.
test("live target parser rejects unsupported and malformed targets", () => {
  assert.throws(() => parseLiveTarget(""), /required/);
  assert.throws(() => parseLiveTarget("ftp://example.com"), /Only HTTP and HTTPS/);
  assert.throws(() => parseLiveTarget("file:///etc/passwd"), /Only HTTP and HTTPS/);
  assert.throws(() => parseLiveTarget("example.com/path"), /must not contain a path/);
  assert.throws(() => parseLiveTarget("exa mple.com"), /not a valid DNS name/);
  assert.throws(() => parseLiveTarget("example.com", 0), /between 1 and 65535/);
  assert.throws(() => parseLiveTarget("a".repeat(600)), /too long/);
});

test("live target parser normalises the supported forms", () => {
  assert.deepEqual(parseLiveTarget("example.com"), { input: "example.com", host: "example.com", port: 443, url: "https://example.com/", scheme: "https", isLiteralIp: false });
  assert.equal(parseLiveTarget("https://example.com/health").url, "https://example.com/health");
  assert.equal(parseLiveTarget("http://example.com").port, 80);
  assert.equal(parseLiveTarget("https://example.com:8443/x").port, 8443);
  const literal = parseLiveTarget("1.1.1.1");
  assert.equal(literal.isLiteralIp, true);
  assert.equal(literal.url, null, "a bare IP gets no synthesised HTTPS URL with an SNI mismatch");
});
