// Network manifest — a small, strictly validated JSON description of a user's
// own environment (sites + targets) so Faultline can test a real network rather
// than only demo scenarios.
//
// SECURITY: manifests are user-supplied data. Validation is allow-list based;
// any unknown field is rejected rather than silently carried through, and any
// credential-shaped field is rejected outright. A manifest can never grant a
// PUBLIC probe access to a private address — private targets are marked as
// requiring an authorised private probe.

import { classifyAddress } from "../security/target.mjs";

export const MANIFEST_VERSION = 1;

const SITE_FIELDS = new Set(["id", "name", "location"]);
const TARGET_FIELDS = new Set(["name", "url", "host", "port", "scope", "site", "contract", "tags", "owner"]);
// Rejected outright rather than ignored, so a user cannot believe a secret was stored.
const FORBIDDEN_FIELDS = ["password", "secret", "token", "apikey", "api_key", "credential", "auth", "authorization", "privatekey", "private_key", "passphrase"];

function fail(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function text(value, { field, max = 120, required = true, fallback = "" }) {
  const result = String(value ?? fallback).trim();
  if (!result) {
    if (required) fail(`${field} is required.`);
    return null;
  }
  if (result.length > max) fail(`${field} must be ${max} characters or fewer.`);
  return result;
}

function assertNoForbiddenFields(object, where) {
  for (const key of Object.keys(object || {})) {
    const normalised = key.toLowerCase().replace(/[^a-z_]/g, "");
    if (FORBIDDEN_FIELDS.some(bad => normalised === bad || normalised.includes(bad))) {
      fail(`${where} must not contain credential fields ("${key}"). Faultline manifests never carry secrets.`);
    }
  }
}

function assertKnownFields(object, allowed, where) {
  for (const key of Object.keys(object || {})) {
    if (!allowed.has(key)) fail(`${where} contains an unsupported field "${key}".`);
  }
}

function slug(value, field) {
  const result = text(value, { field, max: 60 }).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!result) fail(`${field} is invalid.`);
  return result;
}

/**
 * Normalise one target entry. Determines the effective scope and whether a
 * private probe is required to execute it.
 */
export function normaliseManifestTarget(input, { siteIds = new Set(), index = 0 } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(`Target ${index + 1} must be an object.`);
  assertNoForbiddenFields(input, `Target ${index + 1}`);
  assertKnownFields(input, TARGET_FIELDS, `Target ${index + 1}`);

  const name = text(input.name, { field: `Target ${index + 1} name`, max: 120 });

  if (!input.url && !input.host) fail(`Target "${name}" requires either a url or a host.`);
  if (input.url && input.host) fail(`Target "${name}" must specify either url or host, not both.`);

  let host = null;
  let url = null;
  let port = null;

  if (input.url) {
    const raw = text(input.url, { field: `Target "${name}" url`, max: 512 });
    if (!/^https?:\/\//i.test(raw)) fail(`Target "${name}" url must start with http:// or https://.`);
    let parsed;
    try { parsed = new URL(raw); } catch { fail(`Target "${name}" url is not a valid URL.`); }
    if (!parsed.hostname) fail(`Target "${name}" url has no hostname.`);
    url = parsed.toString();
    host = parsed.hostname;
    port = Number(parsed.port || (parsed.protocol === "http:" ? 80 : 443));
  } else {
    host = text(input.host, { field: `Target "${name}" host`, max: 253 });
    if (host.includes("/") || host.includes(" ")) fail(`Target "${name}" host must be a hostname or IP address.`);
    port = input.port == null ? 443 : Number(input.port);
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Target "${name}" port must be an integer between 1 and 65535.`);

  const declaredScope = input.scope == null ? null : String(input.scope).trim().toLowerCase();
  if (declaredScope && !["public", "private"].includes(declaredScope)) fail(`Target "${name}" scope must be public or private.`);

  // A literal private/reserved address is ALWAYS private regardless of what the
  // manifest declares. This prevents a manifest from asking a public probe to
  // reach into a private network.
  const classified = classifyAddress(host);
  const literalPrivate = Boolean(classified.family) && classified.public === false;
  const scope = literalPrivate ? "private" : (declaredScope || "public");
  if (literalPrivate && declaredScope === "public") {
    fail(`Target "${name}" resolves to a private or reserved address and cannot be declared public.`);
  }

  const site = input.site == null ? null : slug(input.site, `Target "${name}" site`);
  if (site && siteIds.size && !siteIds.has(site)) fail(`Target "${name}" references unknown site "${site}".`);

  const tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.map(tag => text(tag, { field: `Target "${name}" tag`, max: 40 }).toLowerCase()))].slice(0, 12)
    : [];

  return {
    name,
    host,
    url,
    port,
    scope,
    site,
    contract: input.contract == null ? null : slug(input.contract, `Target "${name}" contract`),
    owner: input.owner == null ? null : text(input.owner, { field: `Target "${name}" owner`, max: 120 }),
    tags,
    // Enforcement flag consumed by the UI and the execution path.
    requiresPrivateProbe: scope === "private",
    addressClass: classified.family ? (classified.public ? "public-literal" : "private-literal") : "hostname"
  };
}

export function normaliseManifestSite(input, index = 0) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(`Site ${index + 1} must be an object.`);
  assertNoForbiddenFields(input, `Site ${index + 1}`);
  assertKnownFields(input, SITE_FIELDS, `Site ${index + 1}`);
  const name = text(input.name, { field: `Site ${index + 1} name`, max: 120 });
  return {
    id: slug(input.id ?? name, `Site ${index + 1} id`),
    name,
    location: input.location == null ? null : text(input.location, { field: `Site "${name}" location`, max: 120 })
  };
}

/**
 * Strictly validate a manifest. Throws a 400-tagged Error on any problem.
 */
export function validateManifest(input) {
  if (typeof input === "string") {
    try { input = JSON.parse(input); }
    catch { fail("Manifest is not valid JSON."); }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Manifest must be a JSON object.");
  assertNoForbiddenFields(input, "Manifest");

  for (const key of Object.keys(input)) {
    if (!["version", "name", "sites", "targets"].includes(key)) fail(`Manifest contains an unsupported field "${key}".`);
  }

  const version = Number(input.version);
  if (version !== MANIFEST_VERSION) fail(`Manifest version must be ${MANIFEST_VERSION}.`);

  const rawSites = Array.isArray(input.sites) ? input.sites : [];
  if (rawSites.length > 50) fail("A manifest may define at most 50 sites.");
  const sites = rawSites.map((site, index) => normaliseManifestSite(site, index));
  const siteIds = new Set(sites.map(site => site.id));
  if (siteIds.size !== sites.length) fail("Manifest site ids must be unique.");

  const rawTargets = Array.isArray(input.targets) ? input.targets : [];
  if (!rawTargets.length) fail("A manifest must define at least one target.");
  if (rawTargets.length > 200) fail("A manifest may define at most 200 targets.");
  const targets = rawTargets.map((target, index) => normaliseManifestTarget(target, { siteIds, index }));

  const privateTargets = targets.filter(target => target.requiresPrivateProbe).length;
  return {
    version: MANIFEST_VERSION,
    name: input.name == null ? "Imported environment" : text(input.name, { field: "Manifest name", max: 120 }),
    sites,
    targets,
    summary: {
      siteCount: sites.length,
      targetCount: targets.length,
      publicTargets: targets.length - privateTargets,
      privateTargets,
      requiresPrivateProbe: privateTargets > 0
    }
  };
}

/**
 * Preview payload — validation result plus an explicit statement of what will
 * and will not be runnable, shown before anything is activated.
 */
export function previewManifest(input) {
  const manifest = validateManifest(input);
  return {
    ...manifest,
    preview: true,
    notes: [
      manifest.summary.privateTargets > 0
        ? `${manifest.summary.privateTargets} private target(s) require an authorised private probe registered to the matching site. Public probes will never be asked to reach them.`
        : "All targets are public and can be measured from the control plane or public vantages.",
      "No credentials are accepted or stored in a manifest."
    ]
  };
}
