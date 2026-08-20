// Public demo target policy.
//
// This is the only place in Faultline where an UNAUTHENTICATED request can
// cause an outbound connection, so it is written as though it will be attacked,
// because it will be.
//
// The threat is server-side request forgery and resource abuse: a visitor
// naming an internal address, a cloud metadata service, an odd port, or a
// hostname that resolves to something private. Two independent controls apply,
// and a target has to pass both:
//
//   1. ALLOWLIST.   The hostname must be a well-known public service. This is
//                   the control that holds even if the address checks have a
//                   bug, and it is on by default. A constrained demo that
//                   works is worth more than an open probe that is unsafe.
//   2. ADDRESS.     Every address the hostname resolves to - v4 and v6, all of
//                   them, not just the first - must be globally routable. A
//                   hostname string check alone is never sufficient, because
//                   the attacker controls the DNS answer.
//
// Ports are fixed to 80/443. Schemes are fixed to http/https. Methods, headers
// and bodies are not caller-controlled anywhere downstream. No OS command is
// ever executed on this path.

import net from "node:net";
import { lookup } from "node:dns/promises";
import { validateResolvedAddresses } from "../security/target.mjs";

/** The only ports a public demo request may reach. */
export const DEMO_ALLOWED_PORTS = Object.freeze([80, 443]);

/**
 * Default allowlist.
 *
 * Chosen to be recognisable to the audience this demo is for (an engineer
 * checking whether Faultline actually does anything), globally anycast, and
 * uncontroversial to send a handful of requests to. A subdomain of an entry is
 * allowed; a hostname that merely ENDS with the string is not, so
 * "notgithub.com" and "github.com.evil.test" are both rejected.
 */
export const DEFAULT_DEMO_ALLOWLIST = Object.freeze([
  "github.com",
  "cloudflare.com",
  "cisco.com",
  "example.com",
  "google.com",
  "wikipedia.org",
  "mozilla.org",
  "ietf.org",
  "ripe.net",
  "bbc.co.uk"
]);

export class DemoPolicyError extends Error {
  constructor(message, { code = "DEMO_TARGET_POLICY", statusCode = 400 } = {}) {
    super(message);
    this.name = "DemoPolicyError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** ASCII control characters, which must never survive into a log or a render. */
function hasControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Parse FAULTLINE_DEMO_ALLOWLIST, falling back to the built-in list. */
export function readAllowlist(env = process.env) {
  const raw = String(env.FAULTLINE_DEMO_ALLOWLIST || "").trim();
  if (!raw) return [...DEFAULT_DEMO_ALLOWLIST];
  const entries = raw
    .split(/[\s,]+/)
    .map(entry => entry.trim().toLowerCase().replace(/\.$/, ""))
    .filter(entry => entry && HOSTNAME.test(entry));
  return entries.length ? [...new Set(entries)] : [...DEFAULT_DEMO_ALLOWLIST];
}

/** Exact host, or a true subdomain of an allowed apex. Never a suffix match. */
export function isAllowlisted(host, allowlist) {
  const value = String(host || "").toLowerCase();
  return allowlist.some(entry => value === entry || value.endsWith(`.${entry}`));
}

/**
 * Parse and statically validate a caller-supplied target.
 *
 * Accepts a bare hostname or a full http(s) URL. Everything else - a literal
 * IP, credentials in the authority, a non-web scheme, a non-web port - is
 * refused here rather than being normalised into something that looks safe.
 */
export function parseDemoTarget(value, { allowlist = readAllowlist() } = {}) {
  const input = String(value ?? "").trim();
  if (!input) throw new DemoPolicyError("A target hostname is required.");
  if (input.length > 255) throw new DemoPolicyError("Target is too long.");
  if (hasControlCharacter(input)) throw new DemoPolicyError("Target contains control characters.");

  let host = input;
  let port = 443;
  let scheme = "https";
  let url = null;

  if (input.includes("://")) {
    if (!/^https?:\/\//i.test(input)) {
      throw new DemoPolicyError("The public demo accepts http:// and https:// targets only.");
    }
    let parsed;
    try {
      parsed = new URL(input);
    } catch {
      throw new DemoPolicyError("Target URL could not be parsed.");
    }
    // Credentials in a URL are a classic way to confuse a naive host check.
    if (parsed.username || parsed.password) {
      throw new DemoPolicyError("Target URL must not contain credentials.");
    }
    scheme = parsed.protocol.replace(":", "");
    host = parsed.hostname;
    port = Number(parsed.port || (scheme === "http" ? 80 : 443));
    // The path is preserved, the query and fragment are not: neither is needed
    // to demonstrate reachability and both widen what a caller can express.
    url = `${scheme}://${parsed.host}${parsed.pathname || "/"}`;
  } else {
    if (input.includes("/") || input.includes("@") || input.includes("?") || input.includes("#")) {
      throw new DemoPolicyError("Provide a hostname, or a full https:// URL.");
    }
    if (input.includes(":")) {
      throw new DemoPolicyError("The public demo does not accept an explicit port. Ports 80 and 443 are used.");
    }
  }

  host = String(host).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

  // A literal address bypasses the hostname allowlist entirely, so the public
  // demo simply does not accept one. Naming an address is the whole shape of
  // the attack this endpoint has to refuse.
  if (net.isIP(host)) {
    throw new DemoPolicyError("The public demo tests hostnames, not literal IP addresses.");
  }
  if (!HOSTNAME.test(host)) {
    throw new DemoPolicyError("Target is not a valid DNS hostname.");
  }
  if (!host.includes(".")) {
    throw new DemoPolicyError("Target must be a fully qualified hostname.");
  }
  if (!DEMO_ALLOWED_PORTS.includes(port)) {
    throw new DemoPolicyError(`The public demo may only reach ports ${DEMO_ALLOWED_PORTS.join(" and ")}.`);
  }
  if (!isAllowlisted(host, allowlist)) {
    throw new DemoPolicyError(
      `${host} is not on the public demo allowlist. This hosted demo probes a fixed set of public services so it cannot be used to scan the Internet.`,
      { code: "DEMO_TARGET_NOT_ALLOWED", statusCode: 403 }
    );
  }

  if (!url) url = `${scheme}://${host}/`;
  return { input, host, port, scheme, url, allowlist };
}

/**
 * Resolve a target and validate EVERY answer.
 *
 * `validateResolvedAddresses` is the same boundary the registered probe fleet
 * uses, reused rather than reimplemented: loopback, RFC1918, CGNAT, link-local,
 * ULA, multicast, documentation, benchmark and reserved ranges are all refused,
 * for v4, v6 and IPv4-mapped v6 alike.
 *
 * Because the caller is handed back concrete addresses and every later stage
 * connects to those addresses rather than re-resolving the name, a DNS answer
 * that changes after this check cannot move the connection anywhere.
 */
export async function resolveDemoTarget(host, { timeoutMs = 4_000 } = {}) {
  let answers;
  try {
    answers = await withTimeout(lookup(host, { all: true, verbatim: true }), timeoutMs, "DNS lookup timed out.");
  } catch (error) {
    if (error instanceof DemoPolicyError) throw error;
    throw new DemoPolicyError(`${host} did not resolve (${error?.code || error?.message || "lookup failed"}).`, {
      code: "DEMO_TARGET_UNRESOLVED"
    });
  }

  // Throws if ANY address is non-public. All of them, not just the one we
  // intend to use.
  const classified = validateResolvedAddresses(answers, "public");
  if (!classified.length) throw new DemoPolicyError(`${host} did not resolve to a usable address.`);
  return classified;
}

/**
 * The redirect guard.
 *
 * A redirect is a fresh target chosen by the remote server, so it gets the
 * same treatment as the original: allowlist, then address validation. Anything
 * that fails returns null, and the HTTP measurement reports the chain as
 * blocked rather than following it.
 */
export function createRedirectGuard({ allowlist = readAllowlist(), timeoutMs = 3_000 } = {}) {
  return async function resolveHop(hostname) {
    const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!host || net.isIP(host) || !HOSTNAME.test(host)) return null;
    if (!isAllowlisted(host, allowlist)) return null;
    try {
      const addresses = await resolveDemoTarget(host, { timeoutMs });
      return addresses[0] || null;
    } catch {
      return null;
    }
  };
}

/** Reject a promise that overruns its budget, so no stage can hang a Function. */
export function withTimeout(promise, ms, message = "Operation timed out.") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DemoPolicyError(message, { code: "DEMO_TIMEOUT", statusCode: 504 })), ms);
    timer.unref?.();
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}
