// Capsule export CLI.
//
//   npm run capsule -- FLR-2026-0007
//   npm run capsule -- FLR-2026-0007 --redaction network-identifiers
//   npm run capsule -- --list
//
// Reads the Faultline store directly rather than going through the API, so an
// export works on a machine whose control plane is not running - and, more to
// the point, with no network at all. The evidence is already on disk; nothing
// about writing it into one file needs a server.

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createStore } from "../storage/store.mjs";
import { buildCapsule, capsuleFilename } from "./capsule.mjs";
import { renderCapsuleHtml } from "./capsule-html.mjs";
import { assertRedactionMode, REDACTION_MODES } from "./redaction.mjs";

const PRODUCT_VERSION = "v1.5";

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) args.flags[key] = true;
      else {
        args.flags[key] = next;
        index += 1;
      }
    } else args._.push(value);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataFile = resolve(args.flags.data || process.env.FAULTLINE_DATA_FILE || "data/faultline.json");
  const store = createStore(dataFile);

  const incidents = await store.listIncidents(50);

  if (args.flags.list || (!args._[0] && !args.flags.latest)) {
    if (!incidents.length) {
      console.error("No retained incidents. Record one first:");
      console.error("  npm run recorder -- example.com");
      console.error("  npm run recorder -- --simulate ipv6-path-loss");
      process.exitCode = 1;
      return;
    }
    console.log("");
    console.log(`Retained incidents in ${dataFile}`);
    console.log("");
    for (const incident of incidents) {
      const attachments = await store.listIncidentEvidence(incident.id);
      const marks = [
        incident.simulated ? "SIMULATED" : null,
        attachments.length ? `+${attachments.length} experiment(s)` : "recorder only"
      ].filter(Boolean).join(" · ");
      console.log(`  ${incident.id.padEnd(18)} ${String(incident.target?.host || "—").padEnd(24)} ${marks}`);
    }
    console.log("");
    console.log("  npm run capsule -- <incident-id>");
    console.log(`  --redaction ${REDACTION_MODES.join(" | ")}`);
    console.log("");
    return;
  }

  const incidentId = args.flags.latest === true ? incidents[0]?.id : args._[0];
  if (!incidentId) {
    console.error("No incident to export.");
    process.exitCode = 1;
    return;
  }

  const incident = await store.getIncident(incidentId);
  if (!incident) {
    console.error(`No retained incident ${incidentId}. Run with --list to see what is available.`);
    process.exitCode = 1;
    return;
  }

  const redaction = assertRedactionMode(args.flags.redaction === true ? "none" : args.flags.redaction || "none");
  const attachments = await store.listIncidentEvidence(incident.id);

  const capsule = buildCapsule({ incident, attachments, redaction, faultlineVersion: PRODUCT_VERSION });
  const html = renderCapsuleHtml(capsule);
  const outputPath = resolve(args.flags.out || capsuleFilename(incident.id));
  await writeFile(outputPath, html, "utf8");

  const experiments = capsule.evidence.experiments.length;
  console.log("");
  console.log(`Capsule written  ${outputPath}`);
  console.log("");
  console.log(`  Incident       ${incident.id}${incident.simulated ? "  (SIMULATED)" : ""}`);
  console.log(`  Target         ${incident.target?.host ?? "—"}:${incident.target?.port ?? "—"}`);
  console.log(`  Contents       Recorder${experiments ? ` + ${experiments} experiment(s)` : " only"}`);
  console.log(`  Conclusion     ${capsule.conclusion.available ? capsule.conclusion.classification : "none — nothing was tested"}`);
  console.log(`  Redaction      ${capsule.redaction.mode}`);
  console.log(`  Integrity      sha256 ${capsule.integrity.digest.slice(0, 16)}…`);
  console.log("");
  console.log("  Self-contained. Opens from file:// with no Faultline, no server and no network.");
  console.log("");

  if (args.flags.json) {
    const jsonPath = resolve(String(args.flags.json) === "true" ? capsuleFilename(incident.id, { extension: "json" }) : args.flags.json);
    await writeFile(jsonPath, `${JSON.stringify(capsule, null, 2)}\n`, "utf8");
    console.log(`  JSON written   ${jsonPath}`);
    console.log("");
  }
}

main().catch(error => {
  console.error(error?.message || error);
  process.exitCode = 1;
});

export { parseArgs };
