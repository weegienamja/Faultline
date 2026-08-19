#!/usr/bin/env node

function help() {
  console.log(`Faultline Probe Registration v1.5\n\nUsage:\n  npm run probe:register -- --name <probe-name> [options]\n\nOptions:\n  --name <value>            Friendly probe name (required)\n  --location <value>        Human-readable location, e.g. London, UK\n  --country <value>         Scheduling country label, e.g. gb\n  --region <value>          Scheduling region label, e.g. europe-west\n  --scope <public|private>  Public probes block private/reserved targets (default: public)\n  --tags <csv>              Comma-separated scheduling tags\n  --api-base <url>          Faultline control-plane base URL\n                            (default: http://localhost:3000)\n  --admin-token <token>     Admin bearer token (or FAULTLINE_ADMIN_TOKEN)\n  --json                    Print the full registration response\n  --help                    Show this help\n\nExample:\n  npm run probe:register -- --name london-1 --location "London, UK" --country gb --region europe-west --scope public --tags uk,vps --admin-token <admin-token>\n`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (["--name", "--location", "--country", "--region", "--scope", "--tags", "--api-base", "--admin-token"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      index += 1;
      if (arg === "--name") options.name = value;
      if (arg === "--location") options.location = value;
      if (arg === "--country") options.country = value;
      if (arg === "--region") options.region = value;
      if (arg === "--scope") options.scope = value;
      if (arg === "--tags") options.tags = value.split(",");
      if (arg === "--api-base") options.apiBase = value.replace(/\/+$/, "");
      if (arg === "--admin-token") options.adminToken = value;
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
  if (!options.name) throw new Error("--name is required.");

  const adminToken = options.adminToken || process.env.FAULTLINE_ADMIN_TOKEN;
  if (!adminToken) throw new Error("Provide --admin-token or set FAULTLINE_ADMIN_TOKEN.");

  const base = options.apiBase || "http://localhost:3000";
  const response = await fetch(`${base}/api/probes`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      name: options.name,
      location: options.location,
      country: options.country,
      region: options.region,
      scope: options.scope || "public",
      tags: options.tags
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Faultline API returned HTTP ${response.status}.`);

  if (options.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`Faultline probe ${body.probe.id} registered.`);
  console.log(`Name: ${body.probe.name}`);
  if (body.probe.location) console.log(`Location: ${body.probe.location}`);
  if (body.probe.country) console.log(`Country: ${body.probe.country}`);
  if (body.probe.region) console.log(`Region: ${body.probe.region}`);
  console.log(`Scope: ${body.probe.scope}`);
  console.log("\nStart the registered worker with:");
  console.log(`  npm run probe -- --probe ${body.probe.id} --token ${body.credential} --api-base ${base} --watch`);
  console.log("\nThe raw probe credential is shown once. Faultline stores only its SHA-256 hash.");
}

main().catch(error => {
  console.error(`Faultline probe registration failed: ${error.message}`);
  process.exitCode = 1;
});
