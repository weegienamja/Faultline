// Content integrity for evidence artefacts.
//
// Extracted from the case evidence packager so capsules and case packages share
// one implementation. The canonicalisation and digest are byte-for-byte what
// case packages already produced, so existing digests are unchanged.
//
// WHAT THIS PROVES, precisely:
//
//   A SHA-256 digest establishes that a payload matches a particular digest.
//   That is all. It is a content-integrity checksum.
//
//   It is NOT tamper-proof: anyone who edits the payload can recompute the
//   digest. It does NOT prove authenticity or authorship: an unsigned digest
//   says nothing about who produced the file.
//
// Those distinctions are stated here, in the documentation and in the viewer,
// because "integrity" is routinely over-claimed and Faultline's whole argument
// is that it does not overclaim. Digital signing would be a separate feature.

import { createHash } from "node:crypto";

export const INTEGRITY_ALGORITHM = "sha256";

/**
 * Order-independent representation of a value.
 *
 * Object keys are sorted recursively so two structurally equal payloads always
 * hash the same regardless of the order their keys happen to be constructed in.
 * Arrays keep their order: sequence is meaningful evidence.
 */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

export function digest(value) {
  return createHash(INTEGRITY_ALGORITHM).update(canonicalJson(value)).digest("hex");
}

/**
 * Attach an integrity block to a payload.
 *
 * The digest is computed with `integrity` set to null rather than absent, so a
 * verifier can reproduce it by nulling the field it already has. `scope` names
 * exactly what was hashed, because a digest whose coverage is unstated is not
 * checkable by anyone who did not write the code.
 */
export function sealIntegrity(payload, { scope = "canonical-payload-without-integrity" } = {}) {
  const base = { ...payload, integrity: null };
  return {
    ...payload,
    integrity: {
      algorithm: INTEGRITY_ALGORITHM,
      scope,
      digest: digest(base),
      // Said plainly on the artefact itself, not only in the docs.
      note: "Content integrity only. Confirms the payload matches this digest; it does not prove authorship and is not tamper-proof."
    }
  };
}

/** Recompute and compare. Never throws: an unverifiable payload is an answer. */
export function verifyIntegrity(payload) {
  const embedded = payload?.integrity;
  if (!embedded?.digest) {
    return { verifiable: false, matches: false, reason: "No integrity digest is embedded." };
  }
  if (embedded.algorithm !== INTEGRITY_ALGORITHM) {
    return { verifiable: false, matches: false, reason: `Unsupported digest algorithm ${embedded.algorithm}.` };
  }
  const recomputed = digest({ ...payload, integrity: null });
  return {
    verifiable: true,
    matches: recomputed === embedded.digest,
    expected: embedded.digest,
    actual: recomputed,
    scope: embedded.scope ?? null
  };
}
