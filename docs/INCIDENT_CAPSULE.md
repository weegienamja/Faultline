# Portable Incident Capsule

One file. Open it on another machine. No Faultline installation, no server, no
API, no Internet connection, no external CSS, JavaScript, fonts or images.

```
FLR-2026-0007
      │
      ├── original recorder incident
      ├── deep capture
      ├── observed differences
      ├── candidate discriminators
      ├── Network Bisect experiments
      ├── deterministic conclusions
      ├── provenance
      └── integrity metadata
                │
                ▼
      faultline-FLR-2026-0007.html
```

```bash
npm run capsule -- FLR-2026-0007
npm run capsule -- FLR-2026-0007 --redaction network-identifiers
npm run capsule -- --list
```

The CLI reads the store directly, so an export works with the control plane
stopped and the machine offline. The evidence is already on disk; writing it
into one file needs no server.

---

## Evidence classes are never flattened

Four kinds of statement live in a capsule, and a reader never has to infer which
is which:

| Class | Meaning |
|---|---|
| `observed` | Flight Recorder samples, measured from the recording machine |
| `deterministic-comparison` | A fixed-rule comparison of two observed windows. Association, never cause. |
| `deterministic` | A controlled experiment that varied one condition, with paired confirmation |
| `simulated` | Generated from a scenario file. Not a measurement of any real network. |
| `interpretation` | A language model's explanation. Not a Faultline determination. |

Every capsule carries this table, so the file explains its own vocabulary.

## The conclusion states both halves

```
DETERMINISTIC CONCLUSION
IPv6 only fails although the target publishes 2 AAAA record(s)
LOCAL_CAPABILITY_DEFICIENCY

THIS ESTABLISHES              THIS DOES NOT ESTABLISH
Changing this condition       Why that condition fails.
changed the outcome           A confirmed discriminator is
reproducibly, under           an association, not a cause.
interleaved A/B confirmation.
```

An incident with no experiment says so explicitly rather than leaving a gap:
*"No experiment was run against this incident, so nothing was tested and no
deterministic conclusion exists."*

## Many observations, few testable conditions

A VPN coming up produces interface, route, gateway and VPN-state changes at
once. Rendering those as four peers invites a reader to treat them as four
independent hypotheses when they are one event seen four ways.

So differences are grouped semantically, and the conditions they collapse into
are counted:

```
OBSERVED DIFFERENCES                              5

Network path
  Active interface      Ethernet → Corp VPN
  Default route         Ethernet → Corp VPN
  Gateway               192.168.1.1 → 10.8.0.1
  VPN state             inactive → active

Connectivity
  IPv4 capability       PASS → FAIL

TESTABLE CONDITIONS                               1

source-interface
Derived from multiple simultaneous observed changes.
```

Observations with no corresponding Bisect axis are listed separately as
**observed but not testable**, rather than dropped.

---

## Durable evidence attachments

A closed incident is immutable — PR #20 established it as a finished record of
what was observed, and running a later experiment must not rewrite it. So
experimental evidence is stored **alongside** it, not merged into it:

```
incidentEvidence: [
  {
    "id": "FLE-…",
    "incidentId": "FLR-2026-0007",
    "kind": "network-bisect",
    "evidenceClass": "deterministic",
    "createdAt": "…",
    "origin": { "requestedAxes": ["source-interface"] },
    "payload": { … }
  }
]
```

Store v7. A v6 file loads unchanged and gains an empty collection. Deleting an
incident removes its attachments too — an attachment pointing at an incident
nobody can read is not evidence.

This closed a real hole: before it, a Bisect run started from an incident lived
only in the in-memory Analyst registry, so restarting Faultline left an incident
that recorded a failure with no trace of the experiment that isolated it.

## Provenance belongs to each artefact

A capsule does not stamp one `simulated` flag at the root and imply it covers
everything. A **simulated incident followed by a real Bisect run** is a
legitimate combination, and a good demonstration of the evidence model:

```
SIMULATED        Recorder incident
REAL MEASUREMENT Network Bisect experiment
DETERMINISTIC    Bisect conclusion
```

The capsule reports `containsSimulated` and `fullySimulated` separately, and the
provenance table marks each artefact individually. When the two differ, the
banner says so: *"Not everything here is simulated."*

---

## Redaction is schema-aware

The case packager redacts by key name. That is actively wrong for Recorder data,
where the same names hold results rather than addresses:

```json
"ipv6": { "state": "FAIL" }
"gateway": { "state": "PASS", "lossPct": 0 }
```

Blind key-name recursion would erase exactly the diagnostic evidence the capsule
exists to carry. Capsule redaction instead names identifier-bearing **paths**,
and decides transition values by **what they contain**:

| | |
|---|---|
| `Active interface: Ethernet → Corp VPN` | redacted — an identifier pair |
| `IPv6 capability: PASS → FAIL` | preserved — a capability result |
| `VPN state: not connected → connected (Corp VPN)` | `not connected` preserved, the adapter-bearing value redacted |

The governing rule: **redaction removes who and where, never what happened.**
After redacting, a reader still sees which property changed, every capability
result, every experiment outcome and every deterministic conclusion.

| Mode | Removes |
|---|---|
| `none` | nothing |
| `network-identifiers` | addresses, interface names, SSIDs, BSSIDs, resolvers, public IP, and prose that quotes them |
| `strict` | the above plus the target's identity and engine headlines |

A redacted capsule is re-sealed, so it verifies against its own digest.

---

## Content integrity

```
SHA-256   8ec4b7…
Scope     canonical capsule payload excluding the integrity field
✓ Payload matches embedded digest
```

The viewer recomputes the digest in the browser and reports the result.

**What this proves, precisely:** the payload matches this digest. That is all.

It is **not tamper-proof** — anyone who edits the payload can recompute the
digest. It does **not prove authenticity or authorship** — an unsigned digest
says nothing about who produced the file. Digital signing would be a separate
feature; the capsule deliberately does not imply it has one.

## The offline viewer

Six surfaces, everything else progressive disclosure:

1. **Summary** — incident, target, trigger, time, recovery, provenance, and the deterministic conclusion if one exists
2. **Timeline** — recording, trigger, deep capture, recovery, experiments, close
3. **Observed differences** — grouped semantically, with the association caveat
4. **Testable conditions** — what collapsed into which axis, and the experiment that tested it
5. **Before / during / after** — expandable sample windows, meaningful fields rather than a JSON dump
6. **Provenance and raw evidence** — per-artefact provenance, evidence-class glossary, redaction state, integrity, and the complete embedded JSON

Print-friendly and responsive. The page makes **no network requests of any
kind** — a capsule that phoned home would leak the evidence it exists to
preserve.

### Embedded evidence cannot break out

Evidence gathered from a network is untrusted input: SSIDs, target strings,
error text and case notes all reach the page. Two escapes cover the two routes
in:

* **HTML text** — `escapeHtml()` at every interpolation.
* **Embedded JSON** — `<` `>` `&` and U+2028/9 become unicode escapes, so nothing
  can terminate the script element or open a comment.

The payload lives in `<script type="application/json">` and is read with
`JSON.parse`, never executed. The escaping is reversible, so the parsed payload
still verifies against its digest.

---

## API

| Route | Purpose |
|---|---|
| `GET /api/recorder/incidents/{id}/capsule` | Download the HTML capsule |
| `GET …/capsule?format=json` | The capsule payload as JSON |
| `GET …/capsule?redaction=network-identifiers` | Apply redaction |
| `GET /api/recorder/incidents/{id}/evidence` | Attached experimental evidence |

The dashboard offers **Export capsule · Recorder + Bisect** or **Export capsule ·
Recorder only**, so the label states what is inside without opening the file.

## The Analyst is never a dependency

An Analyst explanation is an optional `interpretation` artefact. The model is
never invoked during export, and `npm run capsule` cannot fail because Ollama is
not running. The evidence is the product.

---

## Acceptance

The test that matters is mundane: capture an incident, run Bisect, restart
Faultline, take the machine offline, export, copy the HTML to a computer that
has never had Faultline installed, and open it.

Verified end to end. On the receiving machine, with zero non-`file://` requests:

* what was observed — the statement and the grouped differences
* what was tested — the axis and its experiments
* what was ruled out — 13 tracked hypotheses and their states
* what Faultline concluded — `LOCAL_CAPABILITY_DEFICIENCY`, confirmed discriminator
* what it explicitly did not conclude — *why* that condition fails
* which parts were simulated and which were measured

## Limitations

* Attachments are Network Bisect runs today. The envelope supports other kinds; nothing else produces one yet.
* An unsigned digest is an integrity checksum, not proof of origin.
* Redaction paths are maintained by hand. A new field carrying identifiers needs a path added, and the tests assert the known ones.
* One incident per capsule. Bundling several is not supported.
