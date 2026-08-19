import test from "node:test";
import assert from "node:assert/strict";

import { canonical, digest, sealIntegrity, verifyIntegrity } from "../src/evidence/integrity.mjs";
import { redactCapsule, REDACTION_MODES, assertRedactionMode } from "../src/evidence/redaction.mjs";
import { buildCapsule, buildTestableConditions, capsuleFilename, groupDifferences } from "../src/evidence/capsule.mjs";
import { embedJson, escapeHtml, renderCapsuleHtml } from "../src/evidence/capsule-html.mjs";
import { buildBisectAttachment, summariseAttachment } from "../src/recorder/attachments.mjs";

// Capsule building, redaction, integrity and offline rendering.
// Pure functions over fixtures: no store, no network, no browser.

// --- fixtures ---------------------------------------------------------------

const SAMPLE = {
  at: "2026-08-19T20:45:51.000Z",
  state: "healthy",
  reasons: [],
  local: {
    activeInterface: "Ethernet",
    gateway: "192.168.1.1",
    route: { destination: "0.0.0.0/0", nextHop: "192.168.1.1", interfaceAlias: "Ethernet", metric: 25 },
    resolvers: ["10.20.0.53"],
    wifi: { ssid: "office-5g", bssid: "aa:bb:cc:dd:ee:01" },
    vpn: { active: false, adapters: [] },
    interfaces: [{ name: "Ethernet", address: "192.168.1.20", family: 4, mac: "aa:bb:cc:00:11:22" }]
  },
  connectivity: {
    ipv4: { state: "PASS", ms: 31, address: "93.184.216.34" },
    ipv6: { state: "PASS", ms: 34, address: "2606:4700::1" },
    gateway: { state: "PASS", lossPct: 0, averageMs: 2 },
    targetDns: { state: "PASS", v4: 1, v6: 2 },
    targetTcp: { state: "PASS", ms: 31 },
    contract: null
  },
  path: { publicIp: { value: "203.0.113.9" }, resolvedAddress: "93.184.216.34", resolvedAddresses: ["93.184.216.34"], fingerprint: "fp" }
};

const INCIDENT = {
  schema: "faultline.flight-recorder-incident",
  id: "FLR-2026-0007",
  source: "measured",
  simulated: false,
  scenario: null,
  evidenceClass: "observed",
  target: { host: "api.example.com", port: 443, input: "api.example.com" },
  trigger: { type: "TARGET_REACHABILITY_TRANSITION", at: "2026-08-19T20:46:18.000Z", summary: "Target TCP reachability changed PASS → FAIL", manual: false },
  concurrentTriggers: [],
  windows: {
    before: { samples: [SAMPLE], from: SAMPLE.at, to: SAMPLE.at },
    during: { samples: [{ ...SAMPLE, at: "2026-08-19T20:46:18.000Z", state: "failed", reasons: ["target TCP unreachable"], connectivity: { ...SAMPLE.connectivity, targetTcp: { state: "FAIL", error: "ETIMEDOUT" }, ipv6: { state: "FAIL" } } }], from: "2026-08-19T20:46:18.000Z", to: "2026-08-19T20:46:18.000Z" },
    after: { samples: [], from: null, to: null }
  },
  deepCapture: { available: true, startedAt: "2026-08-19T20:46:19.000Z", stages: [{ name: "TCP", state: "fail", ms: null, detail: "timed out" }], external: { state: "reachable", meaning: "Independent vantage points reached the target while this endpoint did not." }, resolvedAddress: "93.184.216.34" },
  observedChange: {
    comparable: true,
    hadFailure: true,
    statement: "The target became unreachable at 20:46:18. Compared with the last healthy sample, the failing window differs by active interface.",
    classification: "temporal_association",
    note: "This is an observed temporal association, not proof that any listed change caused the failure.",
    differences: [
      { key: "activeInterface", label: "Active interface", from: "Ethernet", to: "Corp VPN", bisectAxis: "source-interface", testable: true },
      { key: "defaultRoute", label: "Default route", from: "0.0.0.0/0 via 192.168.1.1", to: "0.0.0.0/0 via 10.8.0.1", bisectAxis: "source-interface", testable: true },
      { key: "vpn", label: "VPN state", from: "not connected", to: "connected (Corp VPN)", bisectAxis: "source-interface", testable: true },
      { key: "gateway", label: "Default gateway", from: "192.168.1.1", to: "10.8.0.1", bisectAxis: null, testable: false },
      { key: "ipv4", label: "IPv4 capability to target", from: "PASS", to: "FAIL", bisectAxis: "address-family", testable: true }
    ],
    unchanged: [{ key: "resolvers", label: "DNS servers", value: "10.20.0.53" }],
    recovery: null
  },
  candidateDiscriminators: {
    available: true,
    testable: [
      { condition: "Active interface", axis: "source-interface", healthyValue: "Ethernet", failingValue: "Corp VPN" },
      { condition: "Default route", axis: "source-interface", healthyValue: "0.0.0.0/0 via 192.168.1.1", failingValue: "0.0.0.0/0 via 10.8.0.1" },
      { condition: "VPN state", axis: "source-interface", healthyValue: "not connected", failingValue: "connected" },
      { condition: "IPv4 capability to target", axis: "address-family", healthyValue: "PASS", failingValue: "FAIL" }
    ],
    untestable: [{ condition: "Default gateway", reason: "Network Bisect has no experiment that varies this condition." }],
    bisectAxes: ["source-interface", "address-family"],
    note: "Candidates are differences between two observed windows. They are not causes."
  },
  closedAt: "2026-08-19T20:47:04.000Z",
  closeReason: "after_window_elapsed",
  epistemics: { observed: "Every sample is a real measurement.", limit: "Temporal association is not causation." }
};

const BISECT_REPORT = {
  schema: "faultline.network-bisect",
  schemaVersion: 2,
  mode: "adaptive",
  engineVersion: "1.0",
  target: { input: "api.example.com", host: "api.example.com", port: 443 },
  startedAt: "2026-08-19T20:48:00.000Z",
  completedAt: "2026-08-19T20:48:20.000Z",
  baseline: { state: "FAILED_BASELINE", result: "FAIL", passes: 0, total: 2, stage: "tcp", reason: "ETIMEDOUT" },
  interfaces: [{ name: "Ethernet", address: "192.168.1.20", classification: "PHYSICAL" }],
  executed: [
    { id: "source-interface=a", axisId: "source-interface", label: "via Ethernet (192.168.1.20)", result: "PASS", passes: 2, total: 2, stage: null },
    { id: "source-interface=b", axisId: "source-interface", label: "via Corp VPN (10.8.0.4)", result: "FAIL", passes: 0, total: 2, stage: "tcp" }
  ],
  skipped: [],
  axesUnavailable: [],
  confirmation: { experimentId: "source-interface=a", label: "via Ethernet", confirmed: true, pairs: 2, baselinePasses: 0, variantPasses: 2, sequence: [{ arm: "baseline", verdict: "fail" }, { arm: "variant", verdict: "pass" }, { arm: "baseline", verdict: "fail" }, { arm: "variant", verdict: "pass" }] },
  hypotheses: [{ id: "h1", label: "Egress interface selection is the difference", state: "SUPPORTED" }],
  transcript: [{ step: 1, kind: "experiment", action: "Local source interface: via Ethernet", result: "PASS" }],
  counters: { connections: 12, executed: 2, skipped: 0, inapplicable: 0 },
  verdict: { classification: "FAILURE_DISCRIMINATOR", stop: "ISOLATED", headline: "Source interface changes the outcome", detail: "Changing only the source interface repaired the connection.", claim: "The failure follows the egress interface." }
};

function attachmentFor(incident = INCIDENT) {
  return buildBisectAttachment({
    incident,
    report: BISECT_REPORT,
    requestedAxes: ["source-interface", "address-family"],
    now: () => new Date("2026-08-19T20:48:25.000Z")
  });
}

// --- integrity --------------------------------------------------------------

test("canonicalisation is key-order independent but preserves array order", () => {
  assert.deepEqual(canonical({ b: 1, a: 2 }), { a: 2, b: 1 });
  assert.equal(digest({ b: 1, a: 2 }), digest({ a: 2, b: 1 }));
  assert.notEqual(digest([1, 2]), digest([2, 1]), "sequence is evidence");
});

test("sealing and verifying round-trips", () => {
  const sealed = sealIntegrity({ answer: 42 }, { scope: "test-scope" });
  assert.equal(sealed.integrity.algorithm, "sha256");
  assert.equal(sealed.integrity.scope, "test-scope");
  const verified = verifyIntegrity(sealed);
  assert.equal(verified.verifiable, true);
  assert.equal(verified.matches, true);
});

test("a modified payload fails verification", () => {
  const sealed = sealIntegrity({ answer: 42 });
  const tampered = { ...sealed, answer: 43 };
  assert.equal(verifyIntegrity(tampered).matches, false);
});

test("integrity states what it does and does not prove", () => {
  const sealed = sealIntegrity({ answer: 42 });
  // Over-claiming here would undermine the whole product's argument.
  assert.match(sealed.integrity.note, /does not prove authorship/);
  assert.match(sealed.integrity.note, /not tamper-proof/);
  assert.ok(!/tamper-proof\./.test(sealed.integrity.note.replace("not tamper-proof", "")));
});

test("an unverifiable payload is reported, not thrown", () => {
  assert.equal(verifyIntegrity({}).verifiable, false);
  assert.equal(verifyIntegrity({ integrity: { algorithm: "md5", digest: "x" } }).verifiable, false);
});

// --- redaction --------------------------------------------------------------

test("redaction removes identifiers but preserves what happened", () => {
  const capsule = buildCapsule({ incident: INCIDENT, attachments: [attachmentFor()], redaction: "network-identifiers" });
  const json = JSON.stringify(capsule);

  // Identifiers gone.
  for (const identifier of ["192.168.1.1", "10.8.0.1", "aa:bb:cc:dd:ee:01", "office-5g", "203.0.113.9", "93.184.216.34", "10.20.0.53"]) {
    assert.ok(!json.includes(identifier), `identifier leaked: ${identifier}`);
  }

  // The diagnostic evidence the key-name redactor would have destroyed.
  const during = capsule.evidence.recorder.windows.during.samples[0];
  assert.equal(during.connectivity.ipv6.state, "FAIL", "IPv6 capability result must survive redaction");
  assert.equal(during.connectivity.targetTcp.state, "FAIL");
  assert.equal(during.connectivity.gateway.lossPct, 0, "gateway loss is a measurement, not an identifier");
  assert.equal(during.connectivity.targetDns.v6, 2, "AAAA count is evidence");

  // Which property changed is preserved even though the values are hidden.
  const properties = capsule.evidence.comparison.groups.flatMap(group => group.changes.map(change => change.property));
  assert.ok(properties.includes("Active interface"));
  assert.ok(properties.includes("IPv4 capability to target"));
  assert.equal(capsule.evidence.comparison.differenceCount, 5);

  // And the conclusion still stands.
  assert.equal(capsule.conclusion.available, true);
  assert.equal(capsule.conclusion.classification, "FAILURE_DISCRIMINATOR");
  assert.equal(capsule.redaction.applied, true);
  assert.match(capsule.redaction.preserved, /What happened is intact/);
});

test("redaction keeps capability transitions but hides identifier transitions", () => {
  // The same field holds both kinds of value, so the decision is made by what
  // the value IS. "PASS -> FAIL" is the evidence; "Ethernet -> Corp VPN" is not.
  const capsule = buildCapsule({ incident: INCIDENT, attachments: [], redaction: "network-identifiers" });
  const changes = capsule.evidence.comparison.groups.flatMap(group => group.changes);

  const capability = changes.find(change => change.key === "ipv4");
  assert.equal(capability.from, "PASS", "a capability result is not an identifier");
  assert.equal(capability.to, "FAIL");

  const iface = changes.find(change => change.key === "activeInterface");
  assert.equal(iface.from, "[redacted]");
  assert.equal(iface.to, "[redacted]");

  // The property names always survive, so the reader still knows what changed.
  assert.deepEqual(
    changes.map(change => change.property).sort(),
    ["Active interface", "Default gateway", "Default route", "IPv4 capability to target", "VPN state"]
  );
});

test("strict redaction also hides the target's identity", () => {
  const capsule = buildCapsule({ incident: INCIDENT, attachments: [attachmentFor()], redaction: "strict" });
  const json = JSON.stringify(capsule);
  assert.ok(!json.includes("api.example.com"), "the target host should be hidden in strict mode");
  // Results survive even so.
  assert.equal(capsule.evidence.recorder.windows.during.samples[0].connectivity.ipv6.state, "FAIL");
  assert.equal(capsule.conclusion.classification, "FAILURE_DISCRIMINATOR");
});

test("redaction integrity is sealed over the redacted payload", () => {
  const capsule = buildCapsule({ incident: INCIDENT, attachments: [], redaction: "network-identifiers" });
  assert.equal(verifyIntegrity(capsule).matches, true, "a redacted capsule must verify against its own digest");
});

test("unsupported redaction modes are refused", () => {
  assert.throws(() => assertRedactionMode("everything"), /Unsupported redaction mode/);
  for (const mode of REDACTION_MODES) assert.equal(assertRedactionMode(mode), mode);
});

// --- structure --------------------------------------------------------------

test("the capsule keeps evidence classes separate", () => {
  const capsule = buildCapsule({ incident: INCIDENT, attachments: [attachmentFor()] });
  assert.equal(capsule.schema, "faultline.incident-capsule");
  assert.equal(capsule.evidence.recorder.evidenceClass, "observed");
  assert.equal(capsule.evidence.comparison.evidenceClass, "deterministic-comparison");
  assert.equal(capsule.evidence.experiments[0].evidenceClass, "deterministic");
  assert.equal(capsule.evidence.interpretation, null);
  // A reader must be able to look up what each class means.
  assert.ok(Object.keys(capsule.provenance.evidenceClasses).length >= 5);
});

test("differences are grouped semantically rather than listed flat", () => {
  const grouped = groupDifferences(INCIDENT.observedChange.differences);
  const names = grouped.map(group => group.group);
  assert.deepEqual(names, ["Network path", "Connectivity"]);
  assert.equal(grouped[0].changes.length, 4, "interface, route, VPN and gateway are one event seen four ways");
  assert.equal(grouped[1].changes.length, 1);
});

test("many simultaneous differences collapse to few testable axes", () => {
  // The vpn-route-loss shape: five observed changes, but not five hypotheses.
  const testable = buildTestableConditions(INCIDENT, [attachmentFor()]);
  assert.equal(testable.count, 2, "five differences must not become five candidates");

  const sourceInterface = testable.conditions.find(entry => entry.axis === "source-interface");
  assert.equal(sourceInterface.derivedFromCount, 3);
  assert.match(sourceInterface.note, /multiple simultaneous observed changes/);
  assert.equal(sourceInterface.tested, true);
  assert.equal(sourceInterface.experiment.confirmed, true);

  // An untestable observation is surfaced, not dropped.
  assert.equal(testable.untestable[0].condition, "Default gateway");
});

test("an untested incident says so instead of implying a conclusion", () => {
  const capsule = buildCapsule({ incident: INCIDENT, attachments: [] });
  assert.equal(capsule.conclusion.available, false);
  assert.equal(capsule.conclusion.observedOnly, true);
  assert.match(capsule.conclusion.reason, /nothing was tested/);
  assert.ok(capsule.evidence.testableConditions.conditions.every(entry => entry.tested === false));
});

test("the conclusion states both what it establishes and what it does not", () => {
  const capsule = buildCapsule({ incident: INCIDENT, attachments: [attachmentFor()] });
  assert.match(capsule.conclusion.establishes, /changed the outcome reproducibly/);
  assert.match(capsule.conclusion.doesNotEstablish, /association, not a cause/);
});

test("the timeline is ordered and includes the experiment", () => {
  const capsule = buildCapsule({ incident: INCIDENT, attachments: [attachmentFor()] });
  const kinds = capsule.timeline.map(event => event.kind);
  assert.ok(kinds.includes("trigger"));
  assert.ok(kinds.includes("experiment"));
  const times = capsule.timeline.map(event => Date.parse(event.at));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "timeline must be chronological");
});

// --- provenance -------------------------------------------------------------

test("provenance is per artefact, not just per capsule", () => {
  const simulatedIncident = { ...INCIDENT, simulated: true, source: "simulation", scenario: "ipv6-path-loss", evidenceClass: "simulated" };
  const capsule = buildCapsule({ incident: simulatedIncident, attachments: [attachmentFor(simulatedIncident)] });

  // The capsule contains simulated evidence, but is not entirely simulated.
  assert.equal(capsule.provenance.containsSimulated, true);
  assert.equal(capsule.provenance.fullySimulated, false, "a real experiment must not be marked simulated");

  const [recorder, experiment] = capsule.provenance.artefacts;
  assert.equal(recorder.simulated, true);
  assert.equal(recorder.scenario, "ipv6-path-loss");
  assert.equal(experiment.simulated, false);
  assert.equal(experiment.evidenceClass, "deterministic");

  // And the relationship is spelled out on the artefact itself.
  assert.match(capsule.evidence.experiments[0].epistemics.relationToIncident, /incident was simulated; this experiment was not/);
});

test("a fully measured capsule is not marked as containing simulated evidence", () => {
  const capsule = buildCapsule({ incident: INCIDENT, attachments: [attachmentFor()] });
  assert.equal(capsule.provenance.containsSimulated, false);
  assert.equal(capsule.provenance.fullySimulated, false);
});

test("an attachment summary carries its own provenance", () => {
  const summary = summariseAttachment(attachmentFor());
  assert.equal(summary.simulated, false);
  assert.equal(summary.evidenceClass, "deterministic");
  assert.equal(summary.classification, "FAILURE_DISCRIMINATOR");
  assert.deepEqual(summary.requestedAxes, ["source-interface", "address-family"]);
});

// --- offline rendering ------------------------------------------------------

test("the rendered capsule makes no external requests", () => {
  const html = renderCapsuleHtml(buildCapsule({ incident: INCIDENT, attachments: [attachmentFor()] }));

  for (const [pattern, label] of [
    [/src\s*=\s*["']https?:/i, "remote script or image"],
    [/href\s*=\s*["']https?:/i, "remote stylesheet or link"],
    [/@import/i, "css import"],
    [/url\(\s*["']?https?:/i, "remote css url"],
    [/\bfetch\s*\(/i, "fetch call"],
    [/XMLHttpRequest|WebSocket|EventSource/i, "network client"],
    [/<link\b/i, "external link element"]
  ]) {
    assert.ok(!pattern.test(html), `capsule must not contain a ${label}`);
  }
});

test("untrusted evidence cannot break out of the HTML", () => {
  const hostile = structuredClone(INCIDENT);
  const payload = `</script><script>window.__pwned=1</script>`;
  hostile.target.host = payload;
  hostile.trigger.summary = `<img src=x onerror=alert(1)>`;
  hostile.observedChange.statement = `"><svg onload=alert(1)>`;
  hostile.windows.during.samples[0].local.wifi = { ssid: `</script><img src=x onerror=alert(2)>`, bssid: "aa" };

  const html = renderCapsuleHtml(buildCapsule({ incident: hostile, attachments: [] }));

  // Nothing may close the data script element early or inject a live handler.
  assert.ok(!html.includes("</script><script>window.__pwned"), "script breakout in embedded JSON");
  assert.ok(!html.includes("<img src=x onerror"), "unescaped markup in rendered text");
  assert.ok(!html.includes("<svg onload"), "unescaped markup in prose");
  // The literal text "onerror=" may appear inside ESCAPED prose - that is inert.
  // What matters is that no tag or handler is ever in an active position, so the
  // payloads must be present only in their escaped form.
  assert.ok(html.includes("&lt;img src=x onerror"), "the payload should survive as escaped text");
  assert.ok(!/<img/i.test(html), "no live img element");
  assert.ok(!/<svg/i.test(html), "no live svg element");
  // Checked against the rendered markup only. Inside the JSON data island the
  // payload survives as <-escaped text, which is inert by construction:
  // it is parsed with JSON.parse and never interpreted as HTML.
  const markup = html.replace(/<script type="application\/json"[\s\S]*?<\/script>/, "");
  assert.ok(!/\son\w+\s*=\s*["']?\w/i.test(markup.replace(/&lt;[^&]*?&gt;/g, "")), "no live event handler attribute");

  // Exactly two script elements: the JSON data island and the viewer.
  assert.equal((html.match(/<script/g) || []).length, 2);
  assert.equal((html.match(/<\/script>/g) || []).length, 2);
});

test("embedded JSON escapes the sequences that would end the script element", () => {
  const embedded = embedJson({ evil: "</script><!--", unicode: "line sep" });
  assert.ok(!embedded.includes("</script"), "closing tag must be escaped");
  assert.ok(!embedded.includes("<"), "angle brackets must be escaped");
  assert.ok(!embedded.includes(" "), "line separators must be escaped");
  // Still valid JSON that parses back to the original.
  assert.deepEqual(JSON.parse(embedded), { evil: "</script><!--", unicode: "line sep" });
});

test("escaped evidence still verifies against the embedded digest", () => {
  // Escaping must be reversible: JSON.parse in the viewer has to reproduce the
  // exact payload the digest was computed over.
  const capsule = buildCapsule({ incident: INCIDENT, attachments: [attachmentFor()] });
  const html = renderCapsuleHtml(capsule);
  const match = html.match(/<script type="application\/json" id="capsule-data">([\s\S]*?)<\/script>/);
  assert.ok(match, "the data island should be present");
  const parsed = JSON.parse(match[1]);
  assert.equal(verifyIntegrity(parsed).matches, true);
});

test("the rendered capsule shows the simulation banner only when relevant", () => {
  const measured = renderCapsuleHtml(buildCapsule({ incident: INCIDENT, attachments: [] }));
  assert.ok(!measured.includes("Simulated incident"));

  const simulatedIncident = { ...INCIDENT, simulated: true, source: "simulation", scenario: "ipv6-path-loss", evidenceClass: "simulated" };
  const simulated = renderCapsuleHtml(buildCapsule({ incident: simulatedIncident, attachments: [attachmentFor(simulatedIncident)] }));
  assert.ok(simulated.includes("Simulated incident"));
  // And says plainly that the experiment inside it is not simulated.
  assert.match(simulated, /Not everything here is simulated/);
});

test("escapeHtml handles the characters that matter", () => {
  assert.equal(escapeHtml(`<&">'`), "&lt;&amp;&quot;&gt;&#039;");
  assert.equal(escapeHtml(null), "");
});

test("capsule filenames are safe", () => {
  assert.equal(capsuleFilename("FLR-2026-0007"), "faultline-FLR-2026-0007.html");
  // Identifier characters only: no separators and no leading dots either, so
  // the result cannot traverse or become a hidden file.
  assert.equal(capsuleFilename("../../etc/passwd"), "faultline-etcpasswd.html");
  assert.equal(capsuleFilename("..\..\win.ini"), "faultline-winini.html");
  assert.equal(capsuleFilename(""), "faultline-incident.html");
  assert.equal(capsuleFilename("FLR-1", { extension: "json" }), "faultline-FLR-1.json");
});

test("building a capsule without an incident is refused", () => {
  assert.throws(() => buildCapsule({ incident: null }), /incident is required/);
});

// --- repeated experiments ---------------------------------------------------
//
// Re-running Bisect must update the answer. Selecting the first attachment ever
// stored would leave the capsule headlining a superseded result while the newer
// one sat further down the same file.

function attachmentAt(createdAt, classification, { axes = ["source-interface"], confirmed = true } = {}) {
  const attachment = buildBisectAttachment({
    incident: INCIDENT,
    report: { ...BISECT_REPORT, verdict: { ...BISECT_REPORT.verdict, classification }, confirmation: { ...BISECT_REPORT.confirmation, confirmed } },
    requestedAxes: axes,
    now: () => new Date(createdAt)
  });
  return attachment;
}

test("the capsule headlines the latest experimental run, not the first", () => {
  const older = attachmentAt("2026-08-19T20:10:00.000Z", "INSUFFICIENT_EVIDENCE", { confirmed: false });
  const newer = attachmentAt("2026-08-19T20:20:00.000Z", "LOCAL_CAPABILITY_DEFICIENCY", { confirmed: true });

  // Supplied oldest-first, exactly as the store returns them.
  const capsule = buildCapsule({ incident: INCIDENT, attachments: [older, newer] });

  assert.equal(capsule.conclusion.available, true);
  assert.equal(capsule.conclusion.classification, "LOCAL_CAPABILITY_DEFICIENCY", "the newest run is the current answer");
  assert.equal(capsule.conclusion.evidenceId, newer.id);
  assert.equal(capsule.conclusion.confirmed, true);
});

test("a superseded run is disclosed rather than hidden", () => {
  const older = attachmentAt("2026-08-19T20:10:00.000Z", "INSUFFICIENT_EVIDENCE", { confirmed: false });
  const newer = attachmentAt("2026-08-19T20:20:00.000Z", "LOCAL_CAPABILITY_DEFICIENCY");
  const capsule = buildCapsule({ incident: INCIDENT, attachments: [older, newer] });

  assert.equal(capsule.conclusion.runCount, 2);
  assert.deepEqual(capsule.conclusion.supersededRuns.map(entry => entry.classification), ["INSUFFICIENT_EVIDENCE"]);
  // Both remain embedded as evidence.
  assert.equal(capsule.evidence.experiments.length, 2);

  const html = renderCapsuleHtml(capsule);
  assert.match(html, /2 experimental runs/);
  assert.match(html, /INSUFFICIENT_EVIDENCE/);
});

test("each axis uses the latest run that tested that axis", () => {
  const oldInterface = attachmentAt("2026-08-19T20:10:00.000Z", "INSUFFICIENT_EVIDENCE", { axes: ["source-interface"], confirmed: false });
  const newInterface = attachmentAt("2026-08-19T20:30:00.000Z", "FAILURE_DISCRIMINATOR", { axes: ["source-interface"] });
  const family = attachmentAt("2026-08-19T20:20:00.000Z", "LOCAL_CAPABILITY_DEFICIENCY", { axes: ["address-family"] });

  const capsule = buildCapsule({ incident: INCIDENT, attachments: [oldInterface, family, newInterface] });
  const conditions = capsule.evidence.testableConditions.conditions;

  const iface = conditions.find(entry => entry.axis === "source-interface");
  assert.equal(iface.experiment.evidenceId, newInterface.id, "latest run for this axis");
  assert.equal(iface.runCount, 2);
  assert.equal(iface.supersededRuns.length, 1);

  // A different axis is unaffected by the newer run on another one.
  const addressFamily = conditions.find(entry => entry.axis === "address-family");
  assert.equal(addressFamily.experiment.evidenceId, family.id);
  assert.equal(addressFamily.runCount, 1);
  assert.deepEqual(addressFamily.supersededRuns, []);
});

test("the timeline stays chronological even though selection is newest-first", () => {
  const older = attachmentAt("2026-08-19T20:10:00.000Z", "INSUFFICIENT_EVIDENCE");
  const newer = attachmentAt("2026-08-19T20:20:00.000Z", "LOCAL_CAPABILITY_DEFICIENCY");
  const capsule = buildCapsule({ incident: INCIDENT, attachments: [newer, older] });

  const experiments = capsule.timeline.filter(event => event.kind === "experiment");
  assert.equal(experiments.length, 2);
  assert.ok(Date.parse(experiments[0].at) < Date.parse(experiments[1].at), "reading a timeline forward is the point of it");
});
