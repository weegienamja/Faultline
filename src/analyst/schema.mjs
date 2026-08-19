// Analyst response schema.
//
// The model's output is untrusted input that happens to be shaped like an
// answer. Two properties matter more than completeness:
//
//   1. An AI hypothesis can never be serialised as a deterministic finding.
//      The schema keeps them in different fields, and the normaliser stamps
//      `classification: "analyst_hypothesis"` on every possibleProblems entry
//      regardless of what the model wrote there.
//   2. Malformed output degrades, it does not crash. A truncated or invalid
//      response still produces a renderable object with the failure recorded
//      in `limitations`, because a stream that dies mid-object is normal.
//
// Citations are checked against the reference table built from real tool
// results, so an invented EXP-07 is dropped rather than rendered as evidence.

/** Schema handed to Ollama's `format` parameter to constrain generation. */
export const RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    answer: { type: "string" },
    observations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } }
        },
        required: ["claim", "evidenceIds"]
      }
    },
    deterministicFindings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          finding: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } }
        },
        required: ["finding", "evidenceIds"]
      }
    },
    possibleProblems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          basis: { type: "array", items: { type: "string" } }
        },
        required: ["description", "basis"]
      }
    },
    recommendedChecks: { type: "array", items: { type: "string" } },
    limitations: { type: "array", items: { type: "string" } }
  },
  required: ["answer", "observations", "possibleProblems", "recommendedChecks", "limitations"]
});

const MAX_TEXT = 4000;
const MAX_ITEM = 600;
const MAX_ITEMS = 12;

function text(value, max = MAX_ITEM) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function stringList(value, max = MAX_ITEMS) {
  if (!Array.isArray(value)) return [];
  return value.map(entry => text(entry)).filter(Boolean).slice(0, max);
}

/**
 * Keep only citations that exist. `knownRefs` is built from actual tool
 * results, so this is what stops a fabricated id being rendered as evidence.
 */
function citations(value, knownRefs) {
  if (!Array.isArray(value)) return { valid: [], invalid: [] };
  const valid = [];
  const invalid = [];
  for (const entry of value.slice(0, MAX_ITEMS)) {
    const id = text(entry, 60);
    if (!id) continue;
    if (!knownRefs || knownRefs.has(id)) {
      if (!valid.includes(id)) valid.push(id);
    } else if (!invalid.includes(id)) {
      invalid.push(id);
    }
  }
  return { valid, invalid };
}

/**
 * Turn raw model text into a validated response.
 *
 * Never throws. `ok: false` means the model's output was unusable and the
 * caller should render the fallback, not that the request failed.
 */
export function parseAnalystResponse(raw, { knownRefs = null } = {}) {
  const source = typeof raw === "string" ? raw.trim() : "";
  if (!source) {
    return degraded("The local model returned an empty response.");
  }

  let parsed = null;
  try {
    parsed = JSON.parse(source);
  } catch {
    // A model that wrapped its JSON in prose or a fence is recoverable.
    parsed = salvageJson(source);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return degraded("The local model did not return a valid Analyst response object.", {
      // The prose is still shown: a readable answer beats an error card.
      answer: text(source, MAX_TEXT)
    });
  }

  const droppedCitations = new Set();

  const observations = (Array.isArray(parsed.observations) ? parsed.observations : [])
    .slice(0, MAX_ITEMS)
    .map(entry => {
      const claim = text(entry?.claim);
      if (!claim) return null;
      const { valid, invalid } = citations(entry?.evidenceIds, knownRefs);
      for (const id of invalid) droppedCitations.add(id);
      return { claim, evidenceIds: valid };
    })
    .filter(Boolean);

  const deterministicFindings = (Array.isArray(parsed.deterministicFindings) ? parsed.deterministicFindings : [])
    .slice(0, MAX_ITEMS)
    .map(entry => {
      const finding = text(entry?.finding);
      if (!finding) return null;
      const { valid, invalid } = citations(entry?.evidenceIds, knownRefs);
      for (const id of invalid) droppedCitations.add(id);
      // A "deterministic finding" the model could not tie to retrieved evidence
      // is exactly the fabrication risk this feature must not ship, so it is
      // demoted to an observation rather than trusted.
      return { finding, evidenceIds: valid, unsupported: valid.length === 0 };
    })
    .filter(Boolean);

  const supportedFindings = deterministicFindings.filter(entry => !entry.unsupported);
  const demoted = deterministicFindings.filter(entry => entry.unsupported);

  const possibleProblems = (Array.isArray(parsed.possibleProblems) ? parsed.possibleProblems : [])
    .slice(0, MAX_ITEMS)
    .map(entry => {
      const description = text(entry?.description);
      if (!description) return null;
      const { valid, invalid } = citations(entry?.basis, knownRefs);
      for (const id of invalid) droppedCitations.add(id);
      return {
        description,
        basis: valid,
        // Stamped by Faultline, not copied from the model: this label is the
        // guarantee that a hypothesis cannot be dressed up as a finding.
        classification: "analyst_hypothesis"
      };
    })
    .filter(Boolean);

  const limitations = stringList(parsed.limitations);
  if (droppedCitations.size) {
    limitations.push(
      `Some evidence references produced by the model did not match any retrieved evidence and were removed (${[...droppedCitations].slice(0, 6).join(", ")}).`
    );
  }
  for (const entry of demoted) {
    limitations.push(`A stated finding was not tied to retrieved evidence and is shown as an unverified observation: "${entry.finding.slice(0, 120)}"`);
  }

  const answer = text(parsed.answer, MAX_TEXT);

  return {
    ok: Boolean(answer),
    degraded: false,
    response: {
      answer: answer || "The local model did not produce an answer for this question.",
      observations: [
        ...observations,
        ...demoted.map(entry => ({ claim: entry.finding, evidenceIds: [], unverified: true }))
      ],
      deterministicFindings: supportedFindings.map(entry => ({ finding: entry.finding, evidenceIds: entry.evidenceIds })),
      possibleProblems,
      recommendedChecks: stringList(parsed.recommendedChecks),
      limitations
    }
  };
}

/** Recover a JSON object embedded in prose or a code fence. */
function salvageJson(source) {
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(source.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function degraded(reason, { answer = null } = {}) {
  return {
    ok: false,
    degraded: true,
    reason,
    response: {
      answer: answer || "The Analyst could not produce a usable answer. Faultline's deterministic findings on this screen are unaffected.",
      observations: [],
      deterministicFindings: [],
      possibleProblems: [],
      recommendedChecks: [],
      limitations: [reason]
    }
  };
}

/**
 * Incrementally pull the `answer` string out of a partially-received JSON
 * object so the drawer can stream prose instead of showing raw JSON.
 *
 * Returns the decoded text so far. Handles escapes, and stops at the closing
 * quote once the field is complete.
 */
export function extractPartialAnswer(buffer) {
  const source = String(buffer ?? "");
  const key = source.indexOf('"answer"');
  if (key < 0) return "";

  let index = source.indexOf(":", key + 8);
  if (index < 0) return "";
  index += 1;

  while (index < source.length && /\s/.test(source[index])) index += 1;
  if (source[index] !== '"') return "";
  index += 1;

  let out = "";
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      const next = source[index + 1];
      if (next === undefined) break;
      const escapes = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
      if (next === "u") {
        const hex = source.slice(index + 2, index + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16) || 0);
        index += 6;
        continue;
      }
      out += escapes[next] ?? next;
      index += 2;
      continue;
    }
    if (char === '"') break;
    out += char;
    index += 1;
  }
  return out;
}
