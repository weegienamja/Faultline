function isPrivateIpv4(value) {
  const parts = String(value || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function normaliseMac(value) {
  const hex = String(value || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(":");
}

function oui(value) {
  const mac = normaliseMac(value);
  return mac ? mac.split(":").slice(0, 3).join(":") : null;
}

function cleanNeighbours(neighbours = []) {
  const seen = new Set();
  return neighbours
    .map(item => ({
      ip: String(item?.ip || item?.IPAddress || "").trim(),
      mac: normaliseMac(item?.mac || item?.LinkLayerAddress),
      state: String(item?.state || item?.State || "unknown").toLowerCase()
    }))
    .filter(item => isPrivateIpv4(item.ip) && item.mac)
    .filter(item => {
      const key = `${item.ip}|${item.mac}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function edge(id, source, target, type, confidence, observed, reason) {
  return { id, source, target, type, confidence, observed, reason };
}

function node(id, type, label, role, confidence, details = {}) {
  return { id, type, label, role, confidence, ...details };
}

function findByIp(neighbours, ip) {
  return neighbours.find(item => item.ip === ip) || null;
}

export function buildTopology(input = {}) {
  const endpoint = input.endpoint || {};
  const gatewayIp = String(input.gateway?.ip || input.gatewayIp || "").trim() || null;
  const neighbours = cleanNeighbours(input.neighbours);
  const gatewayNeighbour = gatewayIp ? findByIp(neighbours, gatewayIp) : null;
  const gatewayMac = normaliseMac(input.gateway?.mac || gatewayNeighbour?.mac);
  const endpointMac = normaliseMac(endpoint.mac);
  const bssid = normaliseMac(input.wifi?.bssid);
  const wireless = Boolean(input.wifi?.ssid || bssid || /wi-?fi|wireless/i.test(String(endpoint.connection || "")));

  const nodes = [];
  const links = [];
  const reasons = [];

  nodes.push(node(
    "endpoint",
    "laptop",
    endpoint.hostname || "Affected endpoint",
    "endpoint",
    "high",
    {
      ip: endpoint.ip || null,
      mac: endpointMac,
      connection: endpoint.connection || (wireless ? "Wi-Fi" : "Endpoint"),
      observed: true
    }
  ));

  if (!gatewayIp) {
    return {
      version: 1,
      kind: "unknown",
      confidence: "low",
      summary: "The endpoint was observed, but no default gateway was available to infer the local topology.",
      nodes,
      links,
      reasons: ["No IPv4 default gateway was observed."],
      discovery: { mode: "passive", neighbourCount: neighbours.length }
    };
  }

  nodes.push(node(
    "gateway",
    "router",
    "Default gateway",
    "gateway",
    "high",
    {
      ip: gatewayIp,
      mac: gatewayMac,
      observed: true
    }
  ));

  nodes.push(node(
    "internet",
    "internet",
    "Internet",
    "boundary",
    "high",
    { observed: false }
  ));

  links.push(edge(
    "gateway-internet",
    "gateway",
    "internet",
    "wan",
    "high",
    false,
    "The default gateway represents the endpoint's route toward external networks."
  ));

  let kind = "star";
  let confidence = "medium";
  let accessNodeId = "gateway";

  if (wireless && bssid && bssid !== gatewayMac) {
    const sameOui = Boolean(gatewayMac && oui(bssid) === oui(gatewayMac));
    const apType = sameOui ? "mesh-node" : "access-point";
    const apLabel = sameOui ? "Likely mesh / AP node" : "Wireless access point";
    nodes.push(node(
      "wireless-access",
      apType,
      apLabel,
      "access",
      sameOui ? "medium" : "high",
      {
        mac: bssid,
        ssid: input.wifi?.ssid || null,
        signalPct: input.wifi?.signalPct ?? null,
        observed: true,
        inferenceReason: sameOui
          ? "The connected BSSID is distinct from the gateway but shares its MAC OUI."
          : "The endpoint is associated to a BSSID that does not match the gateway MAC."
      }
    ));
    links.push(edge(
      "endpoint-wireless",
      "endpoint",
      "wireless-access",
      "wifi",
      "high",
      true,
      "Windows reported the BSSID currently serving the endpoint."
    ));
    links.push(edge(
      "wireless-gateway",
      "wireless-access",
      "gateway",
      sameOui ? "mesh-backhaul" : "inferred-uplink",
      sameOui ? "low" : "medium",
      false,
      sameOui
        ? "A separate same-vendor wireless node suggests a mesh or AP hop, but Windows cannot prove the backhaul relationship."
        : "The BSSID is separate from the gateway, so an upstream AP-to-gateway relationship is inferred."
    ));
    accessNodeId = "wireless-access";
    kind = sameOui ? "mesh" : "tree";
    confidence = sameOui ? "low" : "medium";
    reasons.push(sameOui
      ? "A distinct BSSID sharing the gateway MAC OUI suggests a mesh or same-vendor AP topology."
      : "A distinct BSSID indicates at least one wireless access layer between endpoint and gateway.");
  } else {
    links.push(edge(
      "endpoint-gateway",
      "endpoint",
      "gateway",
      wireless ? "wifi" : "ethernet-path",
      wireless ? "high" : "medium",
      wireless,
      wireless
        ? "The endpoint's connected BSSID matches the gateway MAC, so the gateway is treated as the serving Wi-Fi node."
        : "The active Ethernet interface and default route establish a logical path to the gateway, but unmanaged switches may be invisible."
    ));
    reasons.push(wireless
      ? "The Wi-Fi radio appears to terminate on the default gateway."
      : "The endpoint reaches the default gateway over an Ethernet path; intermediate unmanaged switches cannot be proven from endpoint data alone.");
  }

  const excludedMacs = new Set([endpointMac, gatewayMac, bssid].filter(Boolean));
  const localDevices = neighbours.filter(item => item.ip !== gatewayIp && !excludedMacs.has(item.mac)).slice(0, 24);

  for (const [index, neighbour] of localDevices.entries()) {
    const id = `neighbour-${index + 1}`;
    nodes.push(node(
      id,
      "unknown",
      `Local device ${neighbour.ip}`,
      "neighbour",
      "high",
      {
        ip: neighbour.ip,
        mac: neighbour.mac,
        state: neighbour.state,
        observed: true
      }
    ));
    links.push(edge(
      `gateway-${id}`,
      "gateway",
      id,
      "inferred-local",
      "low",
      false,
      "The device exists in the endpoint neighbour table, but its exact physical attachment point is not visible from this endpoint."
    ));
  }

  if (localDevices.length && kind === "star") {
    reasons.push(`${localDevices.length} additional local device${localDevices.length === 1 ? "" : "s"} were observed in the endpoint neighbour table.`);
  }

  const summary = kind === "mesh"
    ? "Faultline sees evidence consistent with a mesh or same-vendor wireless hop between the affected endpoint and its gateway."
    : kind === "tree"
      ? "Faultline sees a separate wireless access layer between the affected endpoint and its default gateway."
      : wireless
        ? "Faultline sees the endpoint attached by Wi-Fi directly to the device acting as its default gateway."
        : "Faultline sees a gateway-centred local network; hidden Ethernet switches may exist between the endpoint and gateway.";

  return {
    version: 1,
    kind,
    confidence,
    summary,
    nodes,
    links,
    reasons,
    affectedPath: ["endpoint", accessNodeId, "gateway", "internet"].filter((value, index, array) => index === 0 || value !== array[index - 1]),
    discovery: {
      mode: "passive",
      neighbourCount: neighbours.length,
      renderedNeighbourCount: localDevices.length,
      activeScan: false
    }
  };
}
