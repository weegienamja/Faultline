# Faultline Analyst (optional local AI)

The Faultline Analyst explains Faultline's evidence in natural language. It runs
entirely on the machine hosting the control plane, through a local
[Ollama](https://ollama.com) runtime.

It is optional. Every measurement, diagnosis, isolation run and evidence package
in Faultline works identically with the Analyst absent, uninstalled or switched
off.

---

## The boundary that matters

Faultline's value is that its conclusions are deterministic and traceable. The
Analyst does not change that, and is architecturally prevented from changing it:

```
measurements
    -> deterministic Faultline diagnosis      <- authoritative
    -> evidence
    -> local model                            <- explanation only
    -> explanation / summary / suggested investigation
```

Never:

```
measurements -> AI decides what is broken
```

The engine decides. The Analyst describes. Two categories are kept separate in
the API, in the response schema and in the UI:

| | Faultline finding | Analyst interpretation |
|---|---|---|
| Produced by | the deterministic engine | the local language model |
| Status | authoritative | a hypothesis |
| Evidence | required, cited | may be cited, may be absent |
| Rendered as | solid panel, "deterministic" label | dashed panel, "hypotheses, not findings" |
| Serialised as | `deterministicFindings[]` | `possibleProblems[]`, always `classification: "analyst_hypothesis"` |

A model-produced "finding" that cannot be tied to retrieved evidence is demoted
to an unverified observation and the demotion is disclosed in `limitations`.

---

## Requirements

* Ollama installed and running locally.
* One local model. The default is `qwen3:8b` (~5.2 GB, tool-calling capable).

Faultline does not install Ollama for you and never launches a terminal.

## Using it

1. Start Ollama.
2. Open the Faultline dashboard and unlock live data.
3. Click **Analyst** in the top bar.

If `qwen3:8b` is not installed, the drawer offers a one-click install and streams
the download progress into the UI. Nothing is downloaded until you ask for it.

You never need to run `ollama run qwen3:8b` yourself. Ollama is the inference
runtime; Faultline owns the experience.

## What it can answer

The drawer is page-aware and offers starter questions per screen.

* *What is this screen telling me?*
* *What actually failed?*
* *Why did Network Bisect test IPv4 first?*
* *What evidence ruled out DNS?*
* *What is observed versus inferred?*
* *What does `TARGET_PROPERTY` mean?*
* *Summarise this incident.*

Answers about the current network cite evidence references — `BASE-01`,
`EXP-01`, `CONF-01`, `DIAG-01`, `STG-TCP`, `PATH-01`, `CASE-…` — which are
clickable and navigate to the panel holding the record.

---

## Architecture

```
Browser (drawer)
    -> Faultline server        admin-authenticated, SSE
    -> Analyst gateway         tool loop, schema validation, citation checking
    -> Ollama                  http://127.0.0.1:11434
    -> qwen3:8b
```

The browser never talks to Ollama. It posts a question and the name of the
screen it is on; the server decides everything else.

| Module | Role |
|---|---|
| `src/analyst/ollama.mjs` | Transport. Loopback enforcement, cloud-model exclusion, streaming. |
| `src/analyst/lifecycle.mjs` | Runtime states, model-name validation, pull-progress parsing. |
| `src/analyst/registry.mjs` | Bounded in-memory store of recent bisect/live runs. |
| `src/analyst/evidence.mjs` | Compact projections and stable evidence references. |
| `src/analyst/tools.mjs` | The read-only tool gateway. |
| `src/analyst/docs.mjs` | Documentation index and engine glossary. |
| `src/analyst/prompt.mjs` | System prompt and epistemic rules. |
| `src/analyst/schema.mjs` | Response schema, safe parsing, citation validation. |
| `src/analyst/conversation.mjs` | Bounded, memory-only conversation state. |
| `src/analyst/gateway.mjs` | Two-phase orchestration. |
| `src/analyst/routes.mjs` | `/api/analyst/*`. |

### Two-phase request

1. **Retrieval** — tools enabled, no output schema. The model calls read-only
   tools; the gateway records every evidence reference the results contain.
2. **Answer** — tools removed, JSON schema applied, response streamed. Removing
   the tools makes the final turn decisive; the recorded references become the
   only citations the answer may use.

### Evidence retention

Network Bisect and Live Diagnostics return their reports straight to the browser
and never write them to disk. To give the Analyst something to retrieve, both
routes now also record the completed report in a **bounded in-memory registry**
(10 per kind). Nothing reaches disk, nothing survives a restart, and removing the
Analyst removes the retention.

### Keep-alive

Requests set `keep_alive: "12m"`. Long enough that a conversation does not pay a
~14 s model load on every question; short enough that several GB are not pinned
after someone walks away.

---

## Security boundaries

1. **Admin-authenticated.** Every `/api/analyst/*` route requires the Faultline
   admin credential, matching the live and bisect routes.
2. **No proxy.** There is no `/api/proxy?url=…` and no route that forwards a
   caller-supplied URL, path or payload to Ollama.
3. **Loopback only.** The endpoint must be `127.0.0.1` or `::1`, with no path,
   query or credentials. `localhost` is refused because a name can be
   re-pointed. The check runs at construction and again on every request. A
   non-loopback `FAULTLINE_ANALYST_ENDPOINT` disables the Analyst and leaves the
   rest of Faultline working.
4. **No cloud models.** A local Ollama can register cloud-backed models such as
   `kimi-k3:cloud` or `glm-5.2:cloud`, which proxy inference to `ollama.com`.
   These appear in `/api/tags` but would send network evidence off the machine.
   They are excluded from discovery by metadata (`remote_host`, `remote_model`)
   and by the `:cloud` tag, and refused as configuration.
5. **Read-only tools.** The tool table contains only getters and searches. The
   store is passed through a facade exposing read accessors only, so a write
   method is not merely unused — it is absent.
6. **Untrusted model output.** Tool names are looked up in a fixed table; an
   unknown name is refused, never dispatched. Every argument is parsed by that
   tool's validator. No model-supplied value becomes a path, host, URL, command
   or object key.
7. **Prompt injection.** Text inside evidence — hostnames, banners, holder
   names, case notes, documentation — is data. Instructions found there gain no
   privilege: the tool table is fixed and the gateway executes only registered
   names with validated arguments.
8. **Citation integrity.** Evidence ids are validated against references
   actually returned by tools. Invented ids are dropped and disclosed.
9. **Bounded everything.** Question length, tool rounds, tool calls, response
   fields, conversation turns and conversation count are all capped.
10. **No telemetry.** No prompt, evidence or response leaves the machine.

### Privacy

* No cloud LLM, and no fallback to one. If Ollama is unavailable, the Analyst is
  unavailable.
* Conversations are memory-only, capped at 8 turns, evicted after an idle hour,
  and cleared by **New**.
* Existing private-target and probe-scope boundaries are untouched: the Analyst
  reads projections of evidence Faultline already holds and initiates no
  measurement.

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `FAULTLINE_ANALYST_ENDPOINT` | `http://127.0.0.1:11434` | Must be loopback. |
| `FAULTLINE_ANALYST_MODEL` | `qwen3:8b` | Must be a local, non-cloud model. |

Settings → **Inference** shows provider, model, endpoint and status.

## API

| Route | Purpose |
|---|---|
| `GET /api/analyst/status` | Runtime state, installed models, privacy properties. |
| `GET /api/analyst/capabilities` | Tool list with the reason each exists; starter questions. |
| `POST /api/analyst/ask` | Ask a question. SSE. |
| `POST /api/analyst/install` | Install a model. SSE progress. |
| `POST /api/analyst/conversation/clear` | Drop a conversation. |

`ask` streams `status`, `tool`, `answer_delta`, `result` and `error` events.

### Response schema

```json
{
  "answer": "...",
  "observations":          [{ "claim": "...", "evidenceIds": ["EXP-01"] }],
  "deterministicFindings": [{ "finding": "...", "evidenceIds": ["CONF-01"] }],
  "possibleProblems":      [{ "description": "...", "basis": ["EXP-02"],
                              "classification": "analyst_hypothesis" }],
  "recommendedChecks": ["..."],
  "limitations": ["..."]
}
```

Malformed output never crashes a request: it degrades to a rendered answer with
the failure recorded in `limitations`.

## Read-only tools

`get_current_view`, `get_current_target`, `get_current_diagnosis`,
`get_live_diagnostic`, `get_latest_bisect_run`, `get_bisect_run`,
`get_bisect_experiment_path`, `get_bisect_hypotheses`, `get_topology`,
`get_recent_cases`, `get_case`, `get_probe_fleet`, `search_faultline_docs`,
`get_faultline_term`.

`GET /api/analyst/capabilities` returns the reason each one exists.

There are **no write tools**. The Analyst cannot change network configuration,
routes, DNS or VPN state; cannot run commands or scans; and cannot create,
modify or delete cases, evidence, contracts, probes or environments. It cannot
start a Network Bisect — it can recommend one.

## Documentation retrieval

Questions about Faultline itself are answered from this repository's own
markdown, indexed in-process by heading section with rarity-weighted term
scoring and heading boosting. Engine state names (`INAPPLICABLE`,
`TARGET_PROPERTY`, `FAILURE_DISCRIMINATOR`, …) resolve against a glossary
transcribed from the frozen enums in `src/bisect/`.

No vector database. The corpus is ~4,000 lines across ~25 files; an index
answers accurately, adds no dependency and stays inspectable. Revisit only if
the corpus outgrows it.

---

## Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| "Local AI runtime not running" | Ollama is not reachable on loopback. | Start Ollama. |
| "qwen3:8b not installed" | Runtime up, model absent. | Use **Install model**. |
| Status 500, "must be loopback" | `FAULTLINE_ANALYST_ENDPOINT` is not loopback. | Unset it or point it at `127.0.0.1`. |
| First answer is slow | Cold model load (~14 s). | Subsequent questions reuse the loaded model for 12 minutes. |
| "did not respond in time" | Model call exceeded 120 s. | Ask a narrower question; check machine load. |
| Answer cites no evidence | The model retrieved nothing. | Run a diagnostic or bisect first; `limitations` will say so. |
| Analyst unavailable | Any runtime problem. | Faultline's deterministic features are unaffected. |

### Removing the model

```
ollama rm qwen3:8b
```

Faultline reverts to the "not installed" state and keeps working. To disable the
Analyst entirely, stop Ollama; to remove the runtime, uninstall Ollama.

---

## Limitations

* An 8B model does not always retrieve every relevant artefact. When it
  retrieves nothing, it produces no findings and says so, rather than guessing.
* Answers are explanations, not determinations. Anything under **Analyst
  interpretation** is a hypothesis.
* Flight Recorder is not implemented, so no tool reports pre-fault history and
  the starter questions do not imply otherwise.
* Evidence retention is per-process. Restarting the control plane clears it.
