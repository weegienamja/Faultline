#!/usr/bin/env node

function help() {
  console.log(`Faultline Session CLI v0.5\n\nUsage:\n  npm run session -- --target <hostname|IP|URL> [options]\n\nOptions:\n  --target <value>          Diagnostic target (required)\n  --port <number>           Target TCP port (default inferred from target)\n  --api-base <url>          Faultline control-plane base URL\n                           (default: http://localhost:3000)\n  --admin-token <token>     Admin bearer token (or FAULTLINE_ADMIN_TOKEN)\n  --probe <id>              Assign a registered probe to this session\n  --ttl <minutes>           Session lifetime, 5-1440 minutes (default: 60)\n  --title <value>           Incident title\n  --customer <value>        Customer or case label\n  --vpn-required            Mark target as VPN-dependent\n  --expected-route <CIDR>   Expected IPv4 route for endpoint validation\n  --json                    Print the full creation response\n  --help                    Show this help\n\nExamples:\n  npm run session -- --target microsoft.com --admin-token <admin-token>\n  npm run session -- --target microsoft.com --probe PRB-ABC123 --admin-token <admin-token>\n`);
}

function parseNumber(value, label, { min, max, integer = false }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || parsed < min || parsed > max) {
    throw new Error(`${label} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}.`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--vpn-required") options.vpnRequired = true;
    else if (arg === "--json") options.json = true;
    else if (["--target", "--port", "--api-base", "--admin-token", "--probe", "--ttl", "--title", "--customer", "--expected-route"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      index += 1;
      if (arg === "--target") options.target = value;
      if (arg === "--port") options.port = parseNumber(value, "--port", { min: 1, max: 65535, integer: true });
      if (arg === "--api-base") options.apiBase = value.replace(/\/+$/, "");
      if (arg === "--admin-token") options.adminToken = value;
      if (arg === "--probe") options.assignedProbeId = value;
      if (arg === "--ttl") options.ttlMinutes = parseNumber(value, "--ttl", { min: 5, max: 1440 });
      if (arg === "--title") options.title = value;
      if (arg === "--customer") options.customer = value;
      if (arg === "--expected-route") options.expectedRoute = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
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

  if (options.help) return help();
  if (!options.target) {
    console.error("Error: --target is required.\n");
    help();
    process.exitCode = 1;
    return;
  }

  const adminToken = options.adminToken || process.env.FAULTLINE_ADMIN_TOKEN;
  if (!adminToken) {
    console.error("Error: provide --admin-token or set FAULTLINE_ADMIN_TOKEN.");
    process.exitCode = 1;
    return;
  }

  const base = options.apiBase || "http://localhost:3000";
  const response = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      target: options.target,
      port: options.port,
      ttlMinutes: options.ttlMinutes,
      title: options.title,
      customer: options.customer,
      vpnRequired: options.vpnRequired,
      expectedRoute: options.expectedRoute,
      assignedProbeId: options.assignedProbeId
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Faultline API returned HTTP ${response.status}.`);

  if (options.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const { session, credentials } = body;
  console.log(`Faultline session ${session.id} created.`);
  console.log(`Target: ${session.target.input}:${session.target.port}`);
  console.log(`Expires: ${session.expiresAt}`);
  if (session.assignedProbeId) console.log(`Registered probe: ${session.assignedProbeId}`);

  console.log("\nRun the affected Windows endpoint:");
  console.log(`  npm run agent -- --session ${session.id} --token ${credentials.endpointToken} --api-base ${base}`);

  if (session.assignedProbeId) {
    console.log("\nThe registered probe worker will discover this session automatically after endpoint evidence arrives.");
    console.log(`Ensure probe ${session.assignedProbeId} is running in --watch mode.`);
  } else {
    console.log("\nRun the one-off independent probe from another network or host:");
    console.log(`  npm run probe -- --session ${session.id} --token ${credentials.probeToken} --api-base ${base}`);
  }

  console.log("\nRaw session credentials are shown once and are not stored by Faultline.");
}

main().catch(error => {
  console.error(`Faultline session creation failed: ${error.message}`);
  process.exitCode = 1;
});
