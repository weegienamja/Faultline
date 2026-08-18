# Faultline Incident Intelligence

Faultline's incident-intelligence preview applies classical Data Science to a question that is separate from root-cause diagnosis:

> **Have we seen other diagnostics with a similar measured evidence pattern?**

The deterministic diagnosis engine remains authoritative for fault-domain decisions. The intelligence layer does not train on, predict, or overwrite the fault domain.

## Why this layer exists

A single support case can show that one endpoint has local, DNS, VPN, upstream, access-path or target-service evidence. A support team handling many independent cases has a different problem: recognising when separate tickets may be manifestations of the same broader pattern.

Faultline therefore treats each visible diagnostic as a feature vector and compares cases using their measured network evidence.

## Feature engineering

The current model uses three feature families.

### Numerical telemetry

- gateway latency
- gateway packet loss
- upstream packet loss
- jitter
- DNS lookup latency
- target TCP latency
- target HTTP latency
- Connectivity Contract pass rate
- failed required contract-check count

Each numerical feature is fitted against the currently visible incident set. Missing values are median-imputed, then values are standardised with a z-score and clipped before distance calculation.

### Binary network states

- DNS resolved
- general Internet reachable
- endpoint target reachable
- independent remote target reachable
- VPN required
- VPN connected
- expected VPN route present
- Connectivity Contract passed

Known true/false states are encoded as 1/0. Missing states use a neutral midpoint so absence of an optional measurement is not automatically treated as a failure.

### Categorical evidence

The core mixed-feature model can encode categorical values such as Connectivity Contract ID and first failing contract condition using one-hot representation.

The dashboard's evidence-pattern wrapper deliberately removes the deterministic `faultDomain` before fitting the model. This prevents clustering from simply rediscovering a label Faultline has already assigned.

## Distance and similarity

Feature groups have explicit weights. The model calculates weighted Euclidean distance across the standardised/encoded vector.

A monotonic exponential transform converts that distance into a presentation-oriented similarity score:

```text
small distance -> high similarity
large distance -> low similarity
```

The percentage is a relative evidence-similarity measure for the current fitted dataset. It is **not** a calibrated probability that two incidents share a root cause.

## DBSCAN clustering

The first unsupervised model is DBSCAN.

Current preview defaults:

```text
epsilon   0.34
minPts    3
```

DBSCAN is useful for the prototype because:

- the number of incident patterns does not have to be specified in advance
- dense groups can be discovered from evidence similarity
- sparse incidents can remain noise/outliers
- Faultline does not have to force every support case into a cluster

A production system would tune and validate the density parameters against a substantially larger evidence set rather than treating these prototype values as universal thresholds.

## Demo pattern

The deterministic demo dataset contains six incidents.

Three independent support scenarios intentionally share an upstream-degradation signature:

```text
FL-1042
FL-1040
FL-1038
```

Their common measured characteristics include healthy local-gateway loss, elevated upstream loss, elevated jitter, successful DNS and a healthy independent remote vantage.

The DNS, VPN and local-network scenarios are sufficiently different to remain outliers at the preview density threshold.

This gives the repository a repeatable demonstration of both clustering **and** valid noise handling.

## Dashboard behaviour

The Incident Intelligence panel is client-side and only analyses incidents the existing UI is already authorised to view.

```text
locked dashboard
      -> public demo incidents only

admin-unlocked dashboard
      -> authorised live incidents + demo incidents
```

No new endpoint exposes private incident data solely for the Data Science feature.

For the selected incident the panel shows:

- cluster membership or explicit outlier status
- cluster size
- common measurable characteristics
- the three most similar visible diagnostics
- similarity percentages
- human-readable reasons for close comparisons
- DBSCAN parameters and feature-space summary

## Explainability

The model does not produce free-form AI explanations.

Cluster summaries and pairwise reasons are deterministic descriptions of observable conditions, for example:

```text
healthy local-gateway loss across cases
upstream packet loss is elevated
independent remote vantage remains healthy
similar jitter
same contract failure stage
```

This is intended to make the Data Science feature inspectable during a portfolio demonstration.

## Relationship to Connectivity Contracts

v0.7 Connectivity Contracts provide structured application-level features that improve later incident comparison:

```text
contract ID/version
pass rate
required failures
first failing condition
DNS/TCP/TLS/HTTP outcomes
```

As real contract-backed diagnostics accumulate, these fields can distinguish two incidents that have similar basic path telemetry but fail at different application connectivity stages.

## What the model does not do

The preview does **not**:

- predict the authoritative fault domain
- train a supervised root-cause classifier
- call an AI or LLM API
- claim that similarity proves a common root cause
- force every incident into a group
- learn globally from private customer data

## Validation

Automated tests cover:

- repeatable feature-space construction
- vector compatibility and finite distances
- discovery of the expected three-case demo cluster
- DNS/VPN/local-network outlier handling
- similarity ranking within the upstream family
- proof that changing only fault-domain labels does not change evidence-only similarity
- explicit DBSCAN noise behaviour on sparse vectors

## Future extensions

If the project were taken further, useful analytical work would include:

- compare DBSCAN against hierarchical clustering
- silhouette/cohesion analysis where the assumptions are appropriate
- time-window features for emerging incident detection
- ASN/provider and geography features after reliable enrichment exists
- contract-check state vectors rather than only summary fields
- before/after cluster stability analysis
- engineer-confirmed resolution labels for evaluation, not automatic root-cause replacement

The portfolio objective remains to demonstrate appropriate use of Data Science on structured network evidence while keeping the primary support diagnosis reproducible.
