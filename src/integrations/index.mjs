// Internet-intelligence orchestrator.
//
// PRIVACY BOUNDARY. This module is the only place Faultline talks to public
// third-party APIs, and it will only ever send a globally routable IP address
// or an ASN derived from one. Private/reserved addresses, local hostnames,
// MAC addresses, SSIDs, internal DNS names, VPN routes and topology are never
// passed to an external service. The check reuses the same classifier that
// guards public probe targeting (src/security/target.mjs).
//
// EVIDENCE CLASS. Everything produced here is "external" context. It is
// deliberately kept out of the deterministic diagnosis engine: nothing in this
// module feeds diagnose(), and correlation with an outage or routing event is
// never presented as causation.

import { classifyAddress } from "../security/target.mjs";
import { lookupRouting, lookupRoutingActivity } from "./ripestat.mjs";
import { lookupNetwork } from "./peeringdb.mjs";
import { lookupOutageContext } from "./ioda.mjs";
import { lookupProbeContext } from "./ripe-atlas.mjs";
import { lookupOutageAnnotations, isConfigured as radarConfigured } from "./cloudflare-radar.mjs";
import { skipped } from "./http.mjs";

/**
 * True only for a globally routable public IP literal.
 * Anything else must never be sent to a third-party API.
 */
export function isPubliclyEnrichable(address) {
  if (!address) return false;
  const classified = classifyAddress(address);
  return Boolean(classified.family) && classified.public === true;
}

/**
 * Filter an arbitrary address list down to the public ones only.
 */
export function publicAddressesOnly(addresses = []) {
  return addresses
    .map(item => (typeof item === "string" ? item : item?.address))
    .filter(Boolean)
    .filter(isPubliclyEnrichable);
}

const PRIVACY_NOTE = "Only globally routable public IP addresses are sent to third-party APIs. Private addresses, local hostnames, MAC addresses, SSIDs and VPN routes are never transmitted.";

function blockedContext(reason) {
  return {
    enriched: false,
    reason,
    privacy: PRIVACY_NOTE,
    target: null,
    routing: null,
    routingActivity: null,
    networkMetadata: null,
    outageContext: null,
    measurementNetwork: null,
    radar: null,
    sources: []
  };
}

function sourceState(name, envelope) {
  return {
    name,
    status: envelope?.status || "unavailable",
    error: envelope?.error || null,
    reason: envelope?.reason || null,
    cached: Boolean(envelope?.cached)
  };
}

/**
 * Build the external Internet context for one resolved public IP.
 *
 * @param {string} ip            resolved public IPv4/IPv6 of the target
 * @param {object} options
 * @param {string} options.hostname       target hostname (public DNS name only)
 * @param {string} options.countryCode    optional country for outage/probe context
 * @param {boolean} options.includeActivity  fetch bounded BGP activity
 */
export async function buildInternetContext(ip, {
  hostname = null,
  countryCode = null,
  includeActivity = true,
  now = Date.now(),
  env = process.env
} = {}) {
  if (!ip) return blockedContext("No resolved address was available to enrich.");
  if (!isPubliclyEnrichable(ip)) {
    return blockedContext("Target resolved to a private or reserved address. Public Internet enrichment is intentionally skipped to avoid disclosing internal network information.");
  }

  const routing = await lookupRouting(ip);
  const originAsn = routing.status === "ok" ? routing.data.originAsn : null;
  const prefix = routing.status === "ok" ? routing.data.prefix : null;

  // Remaining sources are independent; one failing must not affect the others.
  const [activity, networkMetadata, outageContext, measurementNetwork, radar] = await Promise.all([
    includeActivity && prefix ? lookupRoutingActivity(prefix, { now }) : Promise.resolve(skipped("ripestat", "No prefix available.")),
    lookupNetwork(originAsn),
    lookupOutageContext({ asn: originAsn, countryCode, now }),
    lookupProbeContext({ asn: originAsn, countryCode }),
    lookupOutageAnnotations({ asn: originAsn, countryCode, env })
  ]);

  return {
    enriched: true,
    reason: null,
    privacy: PRIVACY_NOTE,
    evidenceClass: "external",
    disclaimer: "Routing, ownership and outage information is supporting context. Correlation with an external event does not establish that the event caused this fault.",
    target: { ip, hostname: hostname || null, countryCode: countryCode || null },
    routing: routing.status === "ok" ? routing.data : null,
    routingActivity: activity.status === "ok" ? activity.data : null,
    networkMetadata: networkMetadata.status === "ok" ? networkMetadata.data : null,
    outageContext: outageContext.status === "ok" ? outageContext.data : null,
    measurementNetwork: measurementNetwork.status === "ok" ? measurementNetwork.data : null,
    radar: radar.status === "ok" ? radar.data : null,
    radarConfigured: radarConfigured(env),
    sources: [
      sourceState("ripestat", routing),
      sourceState("ripestat-activity", activity),
      sourceState("peeringdb", networkMetadata),
      sourceState("ioda", outageContext),
      sourceState("ripe-atlas", measurementNetwork),
      sourceState("cloudflare-radar", radar)
    ]
  };
}

export { PRIVACY_NOTE };
