import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function generateCredential(prefix = "fl") {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function hashCredential(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

export function verifyCredential(value, expectedHash) {
  if (!value || !expectedHash) return false;
  const actual = Buffer.from(hashCredential(value), "hex");
  const expected = Buffer.from(String(expectedHash), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function bearerToken(req) {
  const header = String(req?.headers?.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function isSessionExpired(session, now = Date.now()) {
  if (!session?.expiresAt) return false;
  return Date.parse(session.expiresAt) <= now;
}

export function verifySessionRole(session, token, role) {
  if (!session || !["endpoint", "probe"].includes(role)) return false;
  const field = role === "endpoint" ? "endpointTokenHash" : "probeTokenHash";
  return verifyCredential(token, session[field]);
}
