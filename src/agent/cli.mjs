#!/usr/bin/env node
import { collectWindowsDiagnostics } from "./network.mjs";

function help() {
  console.log(`Faultline Agent v0.2\n\nUsage:\n  npm run agent -- --target <hostname|IP|URL> [options]\n\nOptions:\n  --target <value>          Target hostname, IP or URL (required)\n  --port <number>           TCP port when target is not a URL (default: 443)\n  --api <url>               Faultline ingestion endpoint\n                            (default: http://localhost:3000/api/agent-runs)\n  --expected-route <CIDR>   Require an exact IPv4 route, e.g. 10.40.0.0/16\n  --vpn-required            Mark the target as requiring a VPN\n  --no-trace                Skip traceroute collection\n  --dry-run                 Collect and print telemetry without uploading\n  --json                    Print the full JSON payload\n  --help                    Show this help\n\nExamples:\n  npm run agent -- --target microsoft.com\n  npm run agent -- --target https://example.com/health\n  npm run agent -- --target 10.40.12.25 --port 443 --vpn-required --expected-route 10.40.0.0/16\n`);
}

function parseArgs(argv) {
  const options = { trace: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--vpn-required") options.vpnRequired = true;
    else if (arg === "--no-trace") options.trace = false;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (["--target", "--port", "--api", "--expected-route"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      index += 1;
      if (arg === "--target") options.target = value;
      if (arg === "--port") options.port = Number(value);
      if (arg === "--api") options.api = value;
      if (arg === "--expected-route") options.expectedRoute = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function upload(endpoint, payload) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Faultline API returned HTTP ${response.status}.`);
  return body;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}\n`);
    help();
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    help();
    return;
  }

  if (!options.target) {
    console.error("Error: --target is required.\n");
    help();
    process.exitCode = 1;
    return;
  }

  const endpoint = options.api || "http://localhost:3000/api/agent-runs";
  console.log(`Faultline: collecting endpoint evidence for ${options.target}...`);

  try {
    const payload = await collectWindowsDiagnostics(options);
    const m = payload.metrics;

    console.log(`  Gateway: ${m.gatewayLatencyMs} ms · ${m.gatewayLoss}% loss`);
    console.log(`  DNS: ${m.dnsResolved ? "resolved" : "failed"} · ${m.dnsLookupMs} ms`);
    if (m.wifiSignalPct != null) console.log(`  Wi-Fi signal: ${m.wifiSignalPct}%`);
    console.log(`  Internet: ${m.internetReachable ? "reachable" : "unreachable"}`);
    console.log(`  Target TCP: ${m.targetReachable ? "reachable" : "unreachable"} · ${m.targetTcpMs} ms`);
    console.log(`  Target ICMP loss: ${m.upstreamLoss}% · jitter ${m.jitterMs} ms`);

    if (options.json || options.dryRun) console.log(JSON.stringify(payload, null, 2));

    if (options.dryRun) {
      console.log("Dry run complete. Nothing was uploaded.");
      return;
    }

    const run = await upload(endpoint, payload);
    console.log(`\nDiagnosis: ${run.diagnosis.faultDomainLabel} (${run.diagnosis.confidence}% confidence)`);
    console.log(run.diagnosis.summary);
    console.log(`Run ${run.id} is now available in the Faultline dashboard.`);
  } catch (error) {
    console.error(`Faultline agent failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
