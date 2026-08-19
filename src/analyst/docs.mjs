// Documentation retrieval.
//
// The repository's own markdown is the authority on what Faultline means by a
// term, so the Analyst reads it rather than relying on the model's memory of
// networking in general.
//
// Deliberately not a vector database. The corpus is ~4,000 lines across ~25
// files: an in-process section index with term scoring answers "what does
// TARGET_PROPERTY mean" accurately, adds no dependency, needs no embedding
// model, and stays inspectable. Revisit only if the corpus outgrows it.
//
// Only files under the repository's own docs allow-list are indexed, and paths
// are resolved once at build time - the model never supplies a filename.

import { readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Stop words carry no discriminating power in a technical corpus. */
const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "of", "in", "on", "at", "to",
  "for", "with", "by", "from", "as", "into", "about", "does", "do", "did", "what", "why", "how",
  "when", "where", "which", "who", "can", "could", "should", "would", "will", "shall", "may",
  "i", "you", "we", "they", "me", "my", "our", "so", "not", "no", "yes", "mean", "means"
]);

export function tokenise(value) {
  return String(value ?? "")
    .toLowerCase()
    // Keep underscores: TARGET_PROPERTY must survive as one token as well as two.
    .split(/[^a-z0-9_]+/)
    .filter(token => token.length > 1 && !STOP.has(token));
}

/** Split one markdown file into addressable sections at heading boundaries. */
export function splitSections(path, text) {
  const lines = String(text).split(/\r?\n/);
  const sections = [];
  let current = { path, heading: null, level: 0, lines: [], line: 1 };

  lines.forEach((line, index) => {
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      if (current.lines.some(entry => entry.trim())) sections.push(current);
      current = {
        path,
        heading: heading[2].trim(),
        level: heading[1].length,
        lines: [],
        line: index + 1
      };
      return;
    }
    current.lines.push(line);
  });
  if (current.lines.some(entry => entry.trim())) sections.push(current);

  return sections.map(section => {
    const body = section.lines.join("\n").trim();
    return {
      id: `${section.path}#${section.line}`,
      path: section.path,
      heading: section.heading || section.path.replace(/\.md$/i, ""),
      level: section.level,
      line: section.line,
      body,
      terms: countTerms(`${section.heading || ""} ${body}`)
    };
  });
}

function countTerms(text) {
  const counts = new Map();
  for (const token of tokenise(text)) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
}

async function markdownFiles() {
  const files = ["README.md", "ROADMAP.md"];
  try {
    for (const entry of await readdir(join(repoRoot, "docs"))) {
      if (extname(entry).toLowerCase() === ".md") files.push(`docs/${entry}`);
    }
  } catch {
    // A docs directory is expected but its absence must not break the Analyst.
  }
  return files;
}

/**
 * Build the index once per process.
 *
 * `loader` is injectable so tests can index a fixture corpus without touching
 * the real repository.
 */
export async function buildDocIndex({ loader = null } = {}) {
  const sections = [];
  const documentFrequency = new Map();

  const entries = loader
    ? await loader()
    : await Promise.all(
        (await markdownFiles()).map(async relative => {
          try {
            return { path: relative, text: await readFile(resolve(repoRoot, relative), "utf8") };
          } catch {
            return null;
          }
        })
      );

  for (const entry of entries) {
    if (!entry?.text) continue;
    for (const section of splitSections(entry.path, entry.text)) {
      sections.push(section);
      for (const term of section.terms.keys()) {
        documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
      }
    }
  }

  const total = Math.max(1, sections.length);

  /** Rarer terms discriminate more; a heading hit is worth more than a body hit. */
  function score(section, queryTerms) {
    let value = 0;
    const headingTerms = new Set(tokenise(section.heading));
    for (const term of queryTerms) {
      const inSection = section.terms.get(term) || 0;
      if (!inSection) continue;
      const rarity = Math.log(1 + total / (1 + (documentFrequency.get(term) || 0)));
      value += (1 + Math.log(inSection)) * rarity;
      if (headingTerms.has(term)) value += 2.5 * rarity;
    }
    return value;
  }

  return {
    size: sections.length,
    files: [...new Set(sections.map(section => section.path))],

    search(query, { limit = 4, maxChars = 1200 } = {}) {
      const queryTerms = tokenise(query);
      if (!queryTerms.length) return [];
      return sections
        .map(section => ({ section, value: score(section, queryTerms) }))
        .filter(entry => entry.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, Math.max(1, Math.min(8, limit)))
        .map(entry => ({
          source: entry.section.path,
          heading: entry.section.heading,
          line: entry.section.line,
          relevance: Number(entry.value.toFixed(3)),
          excerpt: excerpt(entry.section.body, queryTerms, maxChars)
        }));
    }
  };
}

/**
 * Return the part of a section that actually discusses the query, rather than
 * its first N characters - definitions are often mid-section.
 */
function excerpt(body, queryTerms, maxChars) {
  if (body.length <= maxChars) return body;
  const lower = body.toLowerCase();
  let best = 0;
  let bestHits = -1;
  const window = maxChars;
  for (let start = 0; start < body.length; start += Math.floor(window / 3)) {
    const slice = lower.slice(start, start + window);
    let hits = 0;
    for (const term of queryTerms) if (slice.includes(term)) hits += 1;
    if (hits > bestHits) {
      bestHits = hits;
      best = start;
    }
  }
  const prefix = best > 0 ? "…" : "";
  const suffix = best + window < body.length ? "…" : "";
  return `${prefix}${body.slice(best, best + window).trim()}${suffix}`;
}

/**
 * Faultline's own state vocabulary.
 *
 * These are transcribed from the engine's frozen enums (src/bisect/results.mjs,
 * hypotheses.mjs, interfaces.mjs) because their precise meaning is the thing
 * users most often get wrong, and a model paraphrasing "INAPPLICABLE" as
 * "failed" is exactly the error this feature exists to prevent.
 */
export const GLOSSARY = Object.freeze({
  PASS: "The connection completed under this condition. One of only two states that carry information about connectivity.",
  FAIL: "The connection did not complete, and it could have. Evidence about connectivity.",
  INAPPLICABLE: "The condition cannot be applied to this target/machine pair (for example an IPv4 source address to an IPv6-only target). A statement about the experiment, NOT about the network. Never report it as a failure.",
  UNSUPPORTED: "The machine cannot perform the experiment at all (no IPv6 stack, no second interface, tool unavailable). A statement about the machine, NOT about the network. Never report it as a failure.",
  UNSTABLE: "Repeated trials disagreed, so no single result state applies.",
  HEALTHY_BASELINE: "Normal connectivity to the target succeeded before any condition was varied.",
  FAILED_BASELINE: "Normal connectivity to the target failed before any condition was varied.",
  INTERMITTENT_BASELINE: "Normal connectivity produced inconsistent results across repeats.",
  UNSUPPORTED_BASELINE: "The baseline measurement itself could not be performed on this machine.",
  FAILURE_DISCRIMINATOR: "The baseline was failing and changing exactly one condition repaired it. The strongest isolation result Network Bisect produces.",
  WORKAROUND_CANDIDATE: "A condition that restores service. Useful operationally, but it identifies a workaround rather than a root cause.",
  LOCAL_CAPABILITY_DEFICIENCY: "This machine cannot do something the target can. The deficiency is on the local side.",
  TARGET_PROPERTY: "The target does not offer the capability being tested. This is a property of the target, NOT a fault on the endpoint. Do not report it as an endpoint problem.",
  NO_MEANINGFUL_DIFFERENCE: "No tested condition changed the outcome, so the failure is not specific to any condition that was varied.",
  UNSTABLE_BASELINE: "The baseline changed during the run, so condition comparisons cannot be trusted.",
  INAPPLICABLE_CONDITION: "No applicable experiment was available for this target on this machine.",
  INSUFFICIENT_EVIDENCE: "The evidence gathered does not separate the remaining explanations.",
  ISOLATED: "The engine stopped because a condition was isolated and confirmed.",
  NO_DISCRIMINATOR: "The engine stopped because no condition changed the outcome.",
  EXHAUSTED: "The engine stopped because every applicable experiment had been run.",
  BUDGET: "The engine stopped because it reached its experiment budget.",
  SUPPORTED: "An observation matched a distinctive prediction of this hypothesis.",
  STILL_POSSIBLE: "No observation has yet distinguished this hypothesis either way.",
  WEAKENED: "An observation fits this hypothesis poorly but does not exclude it.",
  CONTRADICTED: "An observation is incompatible with this hypothesis.",
  NOT_TESTABLE: "This machine or target cannot test this hypothesis.",
  HAS_ROUTE: "The interface has a route to the target.",
  NO_ROUTE: "The interface has no route to the target, so measuring from it would be meaningless.",
  UNKNOWN: "Route support for this interface could not be determined."
});

/** Exact-then-fuzzy lookup, so "target property" finds TARGET_PROPERTY. */
export function lookupTerm(term) {
  const raw = String(term ?? "").trim();
  if (!raw) return null;
  const key = raw.toUpperCase().replace(/[\s-]+/g, "_");
  if (GLOSSARY[key]) return { term: key, definition: GLOSSARY[key], source: "faultline-engine-vocabulary" };
  const match = Object.keys(GLOSSARY).find(entry => entry.replace(/_/g, "") === key.replace(/_/g, ""));
  return match ? { term: match, definition: GLOSSARY[match], source: "faultline-engine-vocabulary" } : null;
}
