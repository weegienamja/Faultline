# Faultline inferred topology

The v0.6 topology preview turns endpoint network observations into an interactive local-network map.

The purpose is diagnostic: show the support engineer what Faultline can directly observe around the affected endpoint, what relationships are only inferred, and which part of that path aligns with the current fault-domain diagnosis.

## Current discovery model

The first implementation is deliberately passive.

On Windows, Faultline reads:

- active IPv4 interface and address
- default gateway
- adapter MAC address
- current Wi-Fi SSID, BSSID, signal, radio type and channel when available
- the existing Windows IPv4 neighbour table

It does **not** sweep the subnet or actively probe every private address in this preview.

This means the first map may not contain every device on the LAN. It represents devices Windows has already learned about and relationships Faultline can justify from endpoint evidence.

Use `--no-topology` to omit topology evidence from an endpoint diagnostic.

## Observed versus inferred

Faultline records each node and link with a confidence level and whether the relationship was directly observed.

Examples:

```text
Endpoint -> serving BSSID
observed: true
confidence: high
```

```text
Separate access point -> default gateway
observed: false
confidence: medium or low
```

An Ethernet endpoint can prove that its active route reaches the default gateway, but it cannot prove that there is no unmanaged switch in between. The UI therefore labels the relationship as an Ethernet path rather than claiming a direct cable.

## Topology classification

The preview currently produces one of these classifications:

- `star`: the evidence is consistent with a gateway-centred LAN
- `tree`: a separate wireless access layer is visible between the endpoint and gateway
- `mesh`: a distinct serving BSSID shares the gateway MAC OUI, which is treated as low-confidence mesh/same-vendor AP evidence
- `unknown`: insufficient gateway evidence

A `mesh` result is intentionally low confidence. Matching OUIs do not prove a mesh relationship. The dashboard describes it as evidence consistent with a mesh or same-vendor wireless hop.

## Graph model

Topology telemetry is stored under:

```text
telemetry.topology
```

The structure contains:

```json
{
  "version": 1,
  "kind": "tree",
  "confidence": "medium",
  "summary": "...",
  "nodes": [],
  "links": [],
  "affectedPath": [],
  "discovery": {
    "mode": "passive",
    "activeScan": false
  }
}
```

Node types in the initial model include:

- laptop / endpoint
- router / gateway
- wireless access point
- likely mesh node
- Internet boundary
- unknown local device

The renderer already supports additional icons for future switch, printer, server/NAS, phone and tablet classification.

## Interactive dashboard

When a live incident contains topology telemetry, the dashboard displays a draggable network map.

The map shows:

- device-type glyphs
- IP addresses where available
- confidence markers
- solid observed relationships
- dashed inferred relationships
- the affected endpoint-to-Internet path
- fault overlays derived from the deterministic diagnosis

For example, a `local_network` diagnosis can highlight the endpoint/access/gateway section, while an `upstream` diagnosis highlights the gateway-to-Internet boundary.

## Privacy

Topology evidence can include local operational metadata such as:

- private IPv4 addresses
- adapter MAC address
- gateway MAC address
- Wi-Fi BSSID
- neighbouring-device MAC addresses

This is useful for diagnosis but should be treated as potentially sensitive network metadata.

The current CLI supports `--no-topology`. The planned ephemeral-diagnostic flow should also expose a clear consent/preview step before topology evidence is uploaded.

## Next topology work

The current preview intentionally stops short of active device fingerprinting.

Later v0.6 work can add, with explicit consent:

1. bounded local discovery rather than relying only on the neighbour cache
2. MAC OUI vendor identification
3. reverse-DNS and mDNS hints
4. conservative device-type fingerprints
5. better star / tree / mesh / mixed classification
6. router/controller integrations for authoritative topology where available
7. richer health overlays such as Wi-Fi signal and mesh-backhaul quality
8. user redaction controls before evidence leaves the endpoint

Router/controller integrations are expected to be the route to high-confidence physical topology. Endpoint-only inference should continue to distinguish facts from guesses.
