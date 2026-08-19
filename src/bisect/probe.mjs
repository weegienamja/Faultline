// Controlled trial executor.
//
// Runs one connection attempt under an exact, fully specified set of network
// conditions and returns a single comparable outcome. Every condition is
// applied to THIS connection only - no system state is read for configuration
// or written at any point.
//
// The outcome is deliberately reduced to pass/fail plus the stage that
// decided it, because bisection compares outcomes across trials and a rich
// but incomparable result would defeat that.

import { Resolver, lookup as osLookup } from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import { classifyAddress } from "../security/target.mjs";

export const STAGE = Object.freeze({ DNS: "dns", TCP: "tcp", TLS: "tls", HTTP: "http" });

// Errors that mean "this source address cannot be used for this destination",
// as opposed to "the network did not carry the connection".
const UNBINDABLE = new Set(["EADDRNOTAVAIL", "EINVAL", "EAFNOSUPPORT"]);

function ms(started) {
  return Number((performance.now() - started).toFixed(1));
}

/**
 * Translate a condition assignment into a concrete connection plan.
 * Returns { plan } or { blocked } when the assignment cannot be honoured.
 */
export function planFromAssignment(target, assignment) {
  const plan = {
    host: target.host,
    port: target.port,
    scheme: target.scheme,
    url: target.url,
    family: null,          // 4 | 6 | null(auto)
    address: null,         // pinned literal address, or null to resolve
    resolver: null,        // nameserver for this lookup, or null for system
    localAddress: null,    // source interface binding
    tlsVersion: null,      // "TLSv1.2" | "TLSv1.3" | null
    alpn: null,            // "h2" | "http/1.1" | null
    sni: true,
    // Stage at which this trial's verdict is decided. Some conditions are only
    // meaningful up to TLS; carrying them into an HTTP/1.1 request would
    // measure this client rather than the network.
    stopAt: null
  };

  for (const [axisId, value] of Object.entries(assignment || {})) {
    if (value === undefined || value === null) continue;
    switch (axisId) {
      case "address-family":
        if (value === "ipv4") plan.family = 4;
        else if (value === "ipv6") plan.family = 6;
        break;
      case "resolver":
        if (value !== "system") plan.resolver = value;
        break;
      case "address":
        if (value !== "auto") {
          plan.address = value;
          const classified = classifyAddress(value);
          plan.family = classified.family || null;
        }
        break;
      case "source-interface":
        if (value !== "auto") plan.localAddress = value;
        break;
      case "tls-version":
        if (value !== "auto") plan.tlsVersion = value;
        break;
      case "alpn":
        if (value !== "auto") plan.alpn = value;
        break;
      case "sni":
        if (value === "off") plan.sni = false;
        break;
      case "port":
        plan.port = Number(value);
        plan.scheme = Number(value) === 80 ? "http" : plan.scheme;
        break;
      case "__stopAt":
        plan.stopAt = value;
        break;
      default:
        break;
    }
  }

  // Binding an IPv4 source address to an IPv6 connection cannot work; report
  // it as inapplicable rather than as a network failure.
  if (plan.localAddress && plan.family === 6) {
    return { blocked: "An IPv4 source interface cannot be bound to an IPv6 connection." };
  }
  return { plan };
}

async function resolveUnder(plan, timeoutMs) {
  const started = performance.now();
  if (plan.address) {
    return { ok: true, elapsedMs: 0, addresses: [plan.address], pinned: true };
  }
  if (net.isIP(plan.host)) {
    return { ok: true, elapsedMs: 0, addresses: [plan.host], pinned: true };
  }

  const wantV6 = plan.family === 6;
  const wantV4 = plan.family === 4;

  // No explicit resolver means "resolve the way an application would", which on
  // every platform includes the hosts file and any OS-level resolution order.
  // Using a pure DNS query here would fail for localhost and for the internal
  // names that enterprise machines commonly carry in their hosts file.
  if (!plan.resolver) {
    try {
      const hints = wantV4 ? { family: 4 } : wantV6 ? { family: 6 } : {};
      const answers = await osLookup(plan.host, { all: true, verbatim: true, ...hints });
      const addresses = answers.map(a => a.address);
      return { ok: addresses.length > 0, elapsedMs: ms(started), addresses, via: "system" };
    } catch (error) {
      return { ok: false, elapsedMs: ms(started), addresses: [], error: error.code || error.message, via: "system" };
    }
  }

  // An explicit resolver must be queried directly. Falling back to the system
  // path here would silently defeat the experiment.
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  try { resolver.setServers([plan.resolver]); }
  catch { return { ok: false, elapsedMs: ms(started), addresses: [], error: "resolver-unusable" }; }

  try {
    if (wantV6) {
      const v6 = await resolver.resolve6(plan.host);
      return { ok: v6.length > 0, elapsedMs: ms(started), addresses: v6 };
    }
    if (wantV4) {
      const v4 = await resolver.resolve4(plan.host);
      return { ok: v4.length > 0, elapsedMs: ms(started), addresses: v4 };
    }
    // Auto: prefer A, fall back to AAAA, mirroring common client behaviour.
    try {
      const v4 = await resolver.resolve4(plan.host);
      if (v4.length) return { ok: true, elapsedMs: ms(started), addresses: v4 };
    } catch { /* fall through to AAAA */ }
    const v6 = await resolver.resolve6(plan.host);
    return { ok: v6.length > 0, elapsedMs: ms(started), addresses: v6 };
  } catch (error) {
    return { ok: false, elapsedMs: ms(started), addresses: [], error: error.code || error.message };
  }
}

function connectTcp(address, port, localAddress, timeoutMs) {
  return new Promise(resolve => {
    const started = performance.now();
    let settled = false;
    const options = { host: address, port };
    if (localAddress) options.localAddress = localAddress;
    let socket;
    try { socket = net.createConnection(options); }
    catch (error) { return resolve({ ok: false, elapsedMs: ms(started), error: error.code || error.message }); }

    const finish = (ok, error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, elapsedMs: ms(started), error });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", error => finish(false, error.code || error.message));
  });
}

function handshakeTls(plan, address, timeoutMs) {
  return new Promise(resolve => {
    const started = performance.now();
    let settled = false;
    const options = {
      host: address,
      port: plan.port,
      rejectUnauthorized: false,
      ...(plan.sni && !net.isIP(plan.host) ? { servername: plan.host } : {}),
      ...(plan.localAddress ? { localAddress: plan.localAddress } : {}),
      ...(plan.tlsVersion ? { minVersion: plan.tlsVersion, maxVersion: plan.tlsVersion } : {}),
      ...(plan.alpn ? { ALPNProtocols: [plan.alpn] } : {})
    };

    let socket;
    try { socket = tls.connect(options); }
    catch (error) { return resolve({ ok: false, elapsedMs: ms(started), error: error.code || error.message }); }

    const finish = payload => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(payload);
    };
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => finish({ ok: false, elapsedMs: ms(started), error: "timeout" }));
    socket.once("error", error => finish({ ok: false, elapsedMs: ms(started), error: error.code || error.message }));
    socket.once("secureConnect", () => finish({
      ok: true,
      elapsedMs: ms(started),
      protocol: socket.getProtocol(),
      cipher: socket.getCipher()?.name || null,
      alpn: socket.alpnProtocol || null,
      authorized: socket.authorized,
      authorizationError: socket.authorized ? null : String(socket.authorizationError || "")
    }));
  });
}

function requestHttp(plan, address, family, timeoutMs) {
  return new Promise(resolve => {
    const started = performance.now();
    let settled = false;
    const scheme = plan.port === 80 ? "http" : plan.scheme || "https";
    const base = plan.url && plan.port !== 80 ? new URL(plan.url) : new URL(`${scheme}://${plan.host}/`);
    base.protocol = `${scheme}:`;
    base.port = String(plan.port);
    const transport = scheme === "https" ? https : http;

    const options = {
      method: "GET",
      rejectUnauthorized: false,
      headers: { "user-agent": "Faultline-Bisect/1.5", accept: "*/*", connection: "close" },
      ...(plan.localAddress ? { localAddress: plan.localAddress } : {}),
      ...(scheme === "https" && plan.sni && !net.isIP(plan.host) ? { servername: plan.host } : {}),
      ...(scheme === "https" && plan.tlsVersion ? { minVersion: plan.tlsVersion, maxVersion: plan.tlsVersion } : {}),
      ...(scheme === "https" && plan.alpn ? { ALPNProtocols: [plan.alpn] } : {}),
      // Pin to the address this trial actually selected.
      lookup: (_host, opts, callback) => (opts && opts.all
        ? callback(null, [{ address, family }])
        : callback(null, address, family))
    };

    const finish = payload => {
      if (settled) return;
      settled = true;
      resolve({ ...payload, elapsedMs: ms(started) });
    };

    let request;
    try { request = transport.request(base, options, response => {
      const status = Number(response.statusCode) || 0;
      response.resume();
      response.once("end", () => finish({ ok: status > 0, status, error: null }));
      response.once("error", () => finish({ ok: status > 0, status, error: null }));
    }); }
    catch (error) { return finish({ ok: false, status: 0, error: error.code || error.message }); }

    request.setTimeout(timeoutMs, () => { request.destroy(); finish({ ok: false, status: 0, error: "timeout" }); });
    request.once("error", error => finish({ ok: false, status: 0, error: error.code || error.message }));
    request.end();
  });
}

/**
 * Run one controlled trial.
 *
 * Verdict semantics: a trial PASSES when the full stack completes to an HTTP
 * response (or to TCP for a non-HTTP target). Anything else fails, and the
 * failing stage is recorded so two failures can be told apart.
 */
export async function runTrial(target, assignment, { timeoutMs = 5_000, maxStatus = 599 } = {}) {
  const { plan, blocked } = planFromAssignment(target, assignment);
  if (blocked) {
    return { verdict: "inapplicable", stage: null, reason: blocked, stages: {}, plan: null };
  }

  const stages = {};

  const dns = await resolveUnder(plan, timeoutMs);
  stages.dns = { ok: dns.ok, elapsedMs: dns.elapsedMs, addresses: dns.addresses, error: dns.error || null };
  if (!dns.ok || !dns.addresses.length) {
    return { verdict: "fail", stage: STAGE.DNS, reason: dns.error || "no address returned", stages, plan };
  }

  const address = dns.addresses[0];
  const family = net.isIP(address);

  const tcp = await connectTcp(address, plan.port, plan.localAddress, timeoutMs);
  stages.tcp = { ok: tcp.ok, elapsedMs: tcp.elapsedMs, address, error: tcp.error || null };
  if (!tcp.ok) {
    // A bound source that the kernel refuses for this destination is a scope
    // mismatch (for example a LAN address to a loopback target), not evidence
    // about the network. Report it as inapplicable so it cannot become a
    // discriminator.
    if (plan.localAddress && UNBINDABLE.has(String(tcp.error))) {
      return {
        verdict: "inapplicable", stage: null, stages, plan,
        reason: `Source ${plan.localAddress} cannot originate a connection to ${address} (${tcp.error}).`
      };
    }
    return { verdict: "fail", stage: STAGE.TCP, reason: tcp.error, stages, plan };
  }

  const wantsTls = (plan.port === 80 ? "http" : plan.scheme) === "https";
  if (wantsTls) {
    const handshake = await handshakeTls(plan, address, timeoutMs);
    stages.tls = {
      ok: handshake.ok, elapsedMs: handshake.elapsedMs, protocol: handshake.protocol || null,
      cipher: handshake.cipher || null, alpn: handshake.alpn || null,
      authorized: handshake.authorized ?? null, error: handshake.error || null
    };
    if (!handshake.ok) {
      return { verdict: "fail", stage: STAGE.TLS, reason: handshake.error, stages, plan };
    }
    if (plan.stopAt === STAGE.TLS) {
      const negotiated = [handshake.protocol, handshake.alpn].filter(Boolean).join(" / ");
      return { verdict: "pass", stage: null, reason: negotiated || "TLS established", stages, plan };
    }
  }

  if (plan.stopAt === STAGE.TLS) {
    // A TLS-scoped condition against a non-TLS target cannot be evaluated.
    return { verdict: "inapplicable", stage: null, reason: "Condition only applies to a TLS target.", stages, plan };
  }

  const httpResult = await requestHttp(plan, address, family, timeoutMs);
  stages.http = { ok: httpResult.ok, elapsedMs: httpResult.elapsedMs, status: httpResult.status || null, error: httpResult.error || null };
  if (!httpResult.ok || httpResult.status > maxStatus) {
    return { verdict: "fail", stage: STAGE.HTTP, reason: httpResult.error || `HTTP ${httpResult.status}`, stages, plan };
  }

  return { verdict: "pass", stage: null, reason: `HTTP ${httpResult.status}`, stages, plan };
}
