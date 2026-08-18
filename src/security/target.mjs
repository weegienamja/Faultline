import { lookup } from "node:dns/promises";
import net from "node:net";

export const PUBLIC_PROBE_ALLOWED_PORTS = Object.freeze([53, 80, 443, 853, 8080, 8443]);

function policyError(message) {
  const error = new Error(message);
  error.code = "TARGET_POLICY";
  error.statusCode = 400;
  return error;
}

export function normaliseProbeScope(value) {
  const scope = String(value || "public").trim().toLowerCase();
  if (!["public", "private"].includes(scope)) {
    throw new Error("Probe scope must be either public or private.");
  }
  return scope;
}

function ipv4ToInt(address) {
  const parts = String(address).split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function inIpv4Range(value, base, prefix) {
  const address = ipv4ToInt(value);
  const network = ipv4ToInt(base);
  if (address == null || network == null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (network & mask);
}

function classifyIpv4(address) {
  const blocked = [
    ["0.0.0.0", 8, "unspecified/reserved IPv4"],
    ["10.0.0.0", 8, "RFC1918 private IPv4"],
    ["100.64.0.0", 10, "shared/CGNAT IPv4"],
    ["127.0.0.0", 8, "loopback IPv4"],
    ["169.254.0.0", 16, "link-local IPv4"],
    ["172.16.0.0", 12, "RFC1918 private IPv4"],
    ["192.0.0.0", 24, "IETF protocol/reserved IPv4"],
    ["192.0.2.0", 24, "documentation IPv4"],
    ["192.168.0.0", 16, "RFC1918 private IPv4"],
    ["198.18.0.0", 15, "benchmark IPv4"],
    ["198.51.100.0", 24, "documentation IPv4"],
    ["203.0.113.0", 24, "documentation IPv4"],
    ["224.0.0.0", 4, "multicast IPv4"],
    ["240.0.0.0", 4, "reserved IPv4"]
  ];

  for (const [base, prefix, reason] of blocked) {
    if (inIpv4Range(address, base, prefix)) return { public: false, reason };
  }
  return { public: true, reason: "globally routable IPv4" };
}

function canonicalIpv6(address) {
  const clean = String(address).toLowerCase().split("%")[0];
  try {
    const hostname = new URL(`http://[${clean}]/`).hostname;
    return hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return clean;
  }
}

function mappedIpv4(address) {
  const lower = canonicalIpv6(address);
  const dotted = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];

  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

function classifyIpv6(address) {
  const lower = canonicalIpv6(address);
  const mapped = mappedIpv4(lower);
  if (mapped) {
    const result = classifyIpv4(mapped);
    return { ...result, reason: `IPv4-mapped ${result.reason}` };
  }

  if (lower === "::") return { public: false, reason: "unspecified IPv6" };
  if (lower === "::1") return { public: false, reason: "loopback IPv6" };
  if (/^(fc|fd)/.test(lower)) return { public: false, reason: "unique-local IPv6" };
  if (/^fe[89ab]/.test(lower)) return { public: false, reason: "link-local IPv6" };
  if (/^fe[c-f]/.test(lower)) return { public: false, reason: "site-local/reserved IPv6" };
  if (/^ff/.test(lower)) return { public: false, reason: "multicast IPv6" };
  if (/^2001:db8(?::|$)/.test(lower)) return { public: false, reason: "documentation IPv6" };
  if (/^64:ff9b(?::|$)/.test(lower)) return { public: false, reason: "IPv4 translation IPv6 prefix" };

  return { public: true, reason: "globally routable IPv6" };
}

export function classifyAddress(address) {
  const value = String(address || "").trim().replace(/^\[|\]$/g, "");
  const family = net.isIP(value);
  if (family === 4) return { address: value, family, ...classifyIpv4(value) };
  if (family === 6) return { address: canonicalIpv6(value), family, ...classifyIpv6(value) };
  return { address: value, family: 0, public: false, reason: "not an IP address" };
}

export function assertPortAllowed(port, scope = "public") {
  const numeric = Number(port);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
    throw policyError("Probe target port must be an integer between 1 and 65535.");
  }
  if (normaliseProbeScope(scope) === "public" && !PUBLIC_PROBE_ALLOWED_PORTS.includes(numeric)) {
    throw policyError(`Public probes may only test approved ports: ${PUBLIC_PROBE_ALLOWED_PORTS.join(", ")}.`);
  }
  return numeric;
}

export function validateResolvedAddresses(addresses, scope = "public") {
  const mode = normaliseProbeScope(scope);
  const values = Array.isArray(addresses) ? addresses : [];
  if (!values.length) throw policyError("Probe target did not resolve to an address.");

  const classified = values.map(item => {
    const address = typeof item === "string" ? item : item.address;
    const result = classifyAddress(address);
    return {
      address: result.address,
      family: Number(item?.family || result.family),
      public: result.public,
      reason: result.reason
    };
  });

  if (mode === "public") {
    const blocked = classified.find(item => !item.public);
    if (blocked) {
      throw policyError(`Public probe target resolved to blocked address ${blocked.address} (${blocked.reason}).`);
    }
  }

  return classified;
}

export async function resolveProbeTarget(host, scope = "public") {
  const literal = classifyAddress(host);
  if (literal.family) return validateResolvedAddresses([literal], scope);
  const addresses = await lookup(host, { all: true, verbatim: true });
  return validateResolvedAddresses(addresses, scope);
}

export function assertLiteralTargetAllowed(value, port, scope = "public") {
  const mode = normaliseProbeScope(scope);
  assertPortAllowed(port, mode);
  const input = String(value || "").trim();
  if (!input) throw policyError("Probe target is required.");

  let host = input;
  if (/^https?:\/\//i.test(input)) host = new URL(input).hostname;
  host = host.replace(/^\[|\]$/g, "");
  const classified = classifyAddress(host);
  if (mode === "public" && classified.family && !classified.public) {
    throw policyError(`Public probes cannot target ${classified.address} (${classified.reason}).`);
  }
  return true;
}
