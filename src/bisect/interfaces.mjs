// Local interface model.
//
// The previous implementation treated every non-internal IPv4 address as an
// equally valid egress candidate. That is wrong: a VirtualBox host-only
// adapter is "Up" and has an address, but owns no route to the Internet.
// Binding to it produces ENETUNREACH, which the old model scored as FAIL and
// then reported as a discriminator alongside genuine findings.
//
// An interface that has no route to the target cannot carry the connection, so
// the experiment is INAPPLICABLE, not failed. Deciding that requires actual
// routing information rather than adapter-name guessing.
//
// Classification is deliberately conservative. Vendor names are never asserted
// from a description string alone; "VirtualBox Host-Only Ethernet Adapter"
// yields HOST_ONLY because the OS reports no default route through it AND the
// description says host-only, not because the word "VirtualBox" appears.

import { execFile } from "node:child_process";
import os from "node:os";
import net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const IFACE = Object.freeze({
  PRIMARY: "PRIMARY",       // owns the lowest-metric default route
  ETHERNET: "ETHERNET",
  WIFI: "WIFI",
  VPN: "VPN",
  VIRTUAL: "VIRTUAL",
  HOST_ONLY: "HOST_ONLY",   // has a subnet but demonstrably no default route
  LOOPBACK: "LOOPBACK",
  UNKNOWN: "UNKNOWN"
});

export const ROUTE = Object.freeze({
  HAS_ROUTE: "HAS_ROUTE",
  NO_ROUTE: "NO_ROUTE",
  UNKNOWN: "UNKNOWN"
});

async function powershellJson(script, timeout = 12_000) {
  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout, maxBuffer: 1024 * 1024 }
    );
    const text = (result.stdout || "").trim();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Classify one adapter from OS facts only.
 *
 * `ownsDefaultRoute` is the decisive signal: an adapter that is Up, has an
 * address, but participates in no default route cannot reach off-link
 * destinations regardless of what it is called.
 */
export function classifyInterface({ name = "", description = "", ownsDefaultRoute = false, isBestDefault = false, addresses = [] } = {}) {
  const text = `${name} ${description}`.toLowerCase();

  if (addresses.some(a => a === "127.0.0.1" || a === "::1")) return IFACE.LOOPBACK;
  if (isBestDefault) return IFACE.PRIMARY;

  // Tunnel adapters describe themselves consistently across vendors.
  if (/\bvpn\b|tunnel|tap-|tun\b|wireguard|openvpn|anyconnect|globalprotect|zerotier|tailscale/.test(text)) {
    return IFACE.VPN;
  }
  // "Host-only" is a self-description, and the routing table corroborates it.
  if (/host-only|hostonly/.test(text) && !ownsDefaultRoute) return IFACE.HOST_ONLY;
  if (/virtual|vethernet|hyper-v|vmnet|loopback adapter/.test(text)) return IFACE.VIRTUAL;
  if (/wi-?fi|wireless|802\.11/.test(text)) return IFACE.WIFI;
  if (/ethernet|gbe|gigabit/.test(text)) return IFACE.ETHERNET;

  // No default route and no recognisable description: still not a general
  // egress path, so say so without guessing a vendor.
  if (!ownsDefaultRoute) return IFACE.VIRTUAL;
  return IFACE.UNKNOWN;
}

/**
 * Collect the local interface model. Windows uses routing data; other
 * platforms degrade to address-only knowledge with UNKNOWN route state, which
 * the planner treats as "cannot decide" rather than "no route".
 */
export async function collectInterfaces() {
  if (os.platform() !== "win32") {
    const fallback = [];
    for (const [name, addresses] of Object.entries(os.networkInterfaces() || {})) {
      for (const address of addresses || []) {
        if (address.internal) continue;
        if (address.family !== "IPv4" && address.family !== 4) continue;
        if (address.address.startsWith("169.254.")) continue;
        fallback.push({
          name, description: name, address: address.address,
          classification: IFACE.UNKNOWN, ownsDefaultRoute: null,
          isBestDefault: null, metric: null, status: "unknown",
          routeSupport: ROUTE.UNKNOWN,
          reason: `Route information is only collected on Windows; this control plane is running on ${os.platform()}.`
        });
      }
    }
    return { supported: false, platform: os.platform(), interfaces: fallback };
  }

  const script = `
$routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object InterfaceIndex, RouteMetric, InterfaceMetric, NextHop)
$adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | Select-Object Name, InterfaceDescription, Status, InterfaceIndex)
$addrs = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object InterfaceIndex, IPAddress, PrefixLength)
$v6 = @(Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue | Where-Object { $_.PrefixOrigin -ne 'WellKnown' } | Select-Object InterfaceIndex, IPAddress)
[pscustomobject]@{ routes=$routes; adapters=$adapters; addresses=$addrs; v6=$v6 } | ConvertTo-Json -Depth 5 -Compress`;

  const state = await powershellJson(script);
  if (!state) return { supported: false, platform: "win32", interfaces: [], reason: "Windows network state could not be read." };

  const routes = asArray(state.routes);
  const adapters = asArray(state.adapters);
  const addresses = asArray(state.addresses);
  const v6 = asArray(state.v6);

  // The best default route is the one Windows would actually pick.
  const ranked = [...routes].sort((a, b) =>
    (Number(a.RouteMetric) + Number(a.InterfaceMetric)) - (Number(b.RouteMetric) + Number(b.InterfaceMetric)));
  const bestIndex = ranked.length ? Number(ranked[0].InterfaceIndex) : null;
  const defaultIndexes = new Set(routes.map(r => Number(r.InterfaceIndex)));

  const interfaces = [];
  for (const address of addresses) {
    const index = Number(address.InterfaceIndex);
    const adapter = adapters.find(a => Number(a.InterfaceIndex) === index) || {};
    if (String(adapter.Status || "").toLowerCase() === "disconnected") continue;

    const ownsDefaultRoute = defaultIndexes.has(index);
    const isBestDefault = bestIndex === index;
    const route = routes.find(r => Number(r.InterfaceIndex) === index);

    interfaces.push({
      name: adapter.Name || `index ${index}`,
      description: adapter.InterfaceDescription || "",
      status: adapter.Status || "unknown",
      interfaceIndex: index,
      address: address.IPAddress,
      prefixLength: address.PrefixLength ?? null,
      hasIpv6: v6.some(entry => Number(entry.InterfaceIndex) === index),
      ownsDefaultRoute,
      isBestDefault,
      metric: route ? Number(route.RouteMetric) + Number(route.InterfaceMetric) : null,
      classification: classifyInterface({
        name: adapter.Name || "",
        description: adapter.InterfaceDescription || "",
        ownsDefaultRoute,
        isBestDefault,
        addresses: [address.IPAddress]
      })
    });
  }

  return { supported: true, platform: "win32", bestDefaultIndex: bestIndex, interfaces };
}

/**
 * Does this interface plausibly have a route to `targetAddress`?
 *
 * Uses Find-NetRoute, which performs the OS's own route selection for the
 * destination, then checks whether the selected egress is this interface. This
 * is authoritative: it is the same decision the stack makes when connecting.
 */
export async function routeSupportForTarget(iface, targetAddress) {
  if (!targetAddress || !net.isIP(targetAddress)) return { support: ROUTE.UNKNOWN, reason: "No resolved address to test a route against." };
  if (os.platform() !== "win32") {
    return { support: ROUTE.UNKNOWN, reason: "Route lookup is implemented for Windows only." };
  }

  const script = `
$r = @(Find-NetRoute -RemoteIPAddress '${String(targetAddress).replace(/[^0-9a-fA-F:.]/g, "")}' -ErrorAction SilentlyContinue | Select-Object InterfaceIndex, IPAddress)
$r | ConvertTo-Json -Depth 3 -Compress`;

  const selected = await powershellJson(script, 8_000);
  if (!selected) return { support: ROUTE.UNKNOWN, reason: "The operating system did not return a route for this destination." };

  const entries = asArray(selected);
  const indexes = new Set(entries.map(e => Number(e.InterfaceIndex)).filter(Number.isFinite));
  const sourceAddresses = new Set(entries.map(e => e.IPAddress).filter(Boolean));

  // Either the OS picked this interface index, or it picked this exact source
  // address as the local endpoint for the destination.
  if (indexes.has(Number(iface.interfaceIndex)) || sourceAddresses.has(iface.address)) {
    return { support: ROUTE.HAS_ROUTE, reason: `The operating system selects ${iface.name} for this destination.` };
  }
  return {
    support: ROUTE.NO_ROUTE,
    reason: `The operating system does not select ${iface.name} (${iface.address}) for this destination; it has no route to it.`
  };
}

/**
 * Annotate every interface with its route support for one target.
 */
export async function interfacesForTarget(targetAddress) {
  const model = await collectInterfaces();
  const annotated = [];
  for (const iface of model.interfaces) {
    const route = await routeSupportForTarget(iface, targetAddress);
    annotated.push({ ...iface, routeSupport: route.support, routeReason: route.reason });
  }
  return { ...model, interfaces: annotated };
}

/**
 * Human-readable label used by the CLI and UI.
 */
export function describeInterface(iface) {
  const bits = [iface.classification];
  if (iface.routeSupport === ROUTE.NO_ROUTE) bits.push("NO TARGET ROUTE");
  return bits.join(" / ");
}
