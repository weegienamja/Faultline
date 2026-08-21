// One runtime capability model for the whole product.
//
// Faultline runs in two shapes and they can observe genuinely different things:
//
//   local    an operator's own machine. It can read adapters, Wi-Fi, routes,
//            neighbours and the VPN state, and it can run ping/traceroute.
//   hosted   a public deployment (Vercel). It can reach the public Internet
//            and nothing else. It cannot see the visitor's LAN, and saying
//            otherwise would be the single most damaging lie this product
//            could tell.
//
// Every hosted assumption lives here rather than being re-derived in each
// route and each frontend module. A panel asks what is available; it never
// sniffs for `process.env.VERCEL` itself.

export const RUNTIME = Object.freeze({ LOCAL: "local", HOSTED: "hosted" });

/**
 * Vantage identity.
 *
 * `label` is what the interface is allowed to print next to a measurement.
 * The hosted label deliberately never contains "local" or "this machine":
 * a visitor reading LOCAL on a hosted result would reasonably conclude that
 * Faultline had measured their own network.
 */
export const LOCAL_VANTAGE = Object.freeze({
  id: "local",
  label: "LOCAL",
  longLabel: "This Faultline control plane",
  region: null,
  description: "Measurements originate from the machine running this Faultline control plane."
});

/**
 * The hosted vantage's identity, named after the platform actually running it.
 *
 * A Vercel deployment says VERCEL VANTAGE because that is a fact a reader can
 * check; a hosted deployment somewhere else says HOSTED VANTAGE rather than
 * claiming a platform it is not on. Neither ever says LOCAL.
 */
export function hostedVantage(env = process.env) {
  const onVercel = Boolean(env.VERCEL);
  const region = env.VERCEL_REGION ? String(env.VERCEL_REGION).slice(0, 16) : null;
  return Object.freeze({
    id: "hosted",
    label: onVercel ? "VERCEL VANTAGE" : "HOSTED VANTAGE",
    longLabel: onVercel ? "Faultline's hosted Vercel vantage" : "Faultline's hosted vantage",
    region,
    description: onVercel
      ? "These measurements originate from Faultline's hosted Vercel deployment, not from your device or LAN."
      : "These measurements originate from Faultline's hosted deployment, not from your device or LAN."
  });
}

export function vantageFor(env = process.env) {
  return isHosted(env) ? hostedVantage(env) : LOCAL_VANTAGE;
}

function flag(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return null;
}

/**
 * Which runtime is this?
 *
 * An explicit FAULTLINE_RUNTIME always wins so a hosted-shaped deployment can
 * be reproduced locally. Otherwise the presence of VERCEL decides it, because
 * a Vercel Function genuinely cannot do the endpoint-local half of the product
 * whatever the operator intended.
 */
export function detectRuntime(env = process.env) {
  const declared = String(env.FAULTLINE_RUNTIME || "").trim().toLowerCase();
  if (declared === RUNTIME.HOSTED) return RUNTIME.HOSTED;
  if (declared === RUNTIME.LOCAL) return RUNTIME.LOCAL;
  return env.VERCEL ? RUNTIME.HOSTED : RUNTIME.LOCAL;
}

export function isHosted(env = process.env) {
  return detectRuntime(env) === RUNTIME.HOSTED;
}

/**
 * Is the unauthenticated public demo surface enabled?
 *
 * Hosted implies it, because a hosted deployment with no public surface is a
 * control plane on the open Internet with nothing for a visitor to do. An
 * operator can still force it either way.
 */
export function isPublicDemo(env = process.env) {
  const explicit = flag(env.FAULTLINE_PUBLIC_DEMO);
  if (explicit !== null) return explicit;
  return isHosted(env);
}

/**
 * The complete capability set, safe to serve to an unauthenticated browser.
 *
 * Nothing here is a secret: it is a description of what this deployment can
 * and cannot observe. It deliberately does NOT reveal whether an admin
 * credential is configured, only that admin surfaces exist and are protected.
 */
export function capabilities(env = process.env) {
  const runtime = detectRuntime(env);
  const hosted = runtime === RUNTIME.HOSTED;
  const publicDemo = isPublicDemo(env);
  const vantage = vantageFor(env);

  return {
    schema: "faultline.runtime-capabilities",
    schemaVersion: 1,
    runtime,
    publicDemo,
    vantage,

    // What this process can measure itself.
    serverVantage: true,
    publicInternetDiagnostics: true,
    distributedVantage: true,

    // What it cannot, when hosted. These are the claims the interface must
    // never make on a hosted deployment.
    endpointLocal: !hosted,
    localEnvironment: !hosted,
    windowsEndpointAgent: !hosted,
    icmpAndTraceroute: !hosted,
    endpointFlightRecorder: !hosted,

    // Storage. A hosted Faultline writes to /tmp, which a Function may discard
    // between invocations. The interface must not imply an archive.
    durablePersistence: !hosted,
    persistenceNote: hosted
      ? "Hosted storage is /tmp on an ephemeral Function instance. Runs are returned to you directly and are not retained as an archive."
      : "Runs, cases and closed incidents are written to the configured Faultline store.",

    // The Analyst is a LOCAL model. A hosted deployment has no Ollama, and the
    // correct answer is to say so rather than to substitute a cloud API.
    analyst: {
      available: !hosted,
      requires: "A local Faultline Agent running Ollama.",
      note: hosted
        ? "Faultline Analyst requires a local Faultline Agent/Ollama runtime. It is an interpretation layer and is never required for a deterministic diagnosis."
        : "Faultline Analyst runs against a loopback Ollama endpoint. Network evidence is never sent to a remote inference host."
    },

    // Everything a hosted visitor cannot get without installing the agent.
    endpointOnly: hosted
      ? [
          { id: "wifi", label: "Wi-Fi SSID, BSSID and signal" },
          { id: "gateway", label: "Default gateway health" },
          { id: "routes", label: "Routing table and route changes" },
          { id: "vpn", label: "VPN adapter and tunnel state" },
          { id: "neighbours", label: "Neighbour / ARP table" },
          { id: "adapters", label: "Adapter and link state" },
          { id: "icmp", label: "ICMP ping and traceroute" },
          { id: "recorder", label: "Flight Recorder endpoint capture" }
        ]
      : [],

    // Admin surfaces exist in both runtimes and stay credentialled in both.
    adminApiProtected: true
  };
}
