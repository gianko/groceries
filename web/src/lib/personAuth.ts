import { timingSafeEqual } from "node:crypto";
import type { PersonToken } from "../../../src/personTokens.js";

export const PERSON_TOKEN_COOKIE = "person_token";

// One year, per #45 — a household member bootstraps once and the cookie's
// sliding window is meant to outlast weeks-long gaps between visits.
export const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export type PersonAuthResult =
  | { valid: true; personId: number; name: string; expiresAt: Date }
  | { valid: false };

// Pure per #45's acceptance criteria — no DB/HTTP involved, so this is unit
// testable the same way validateInitData was. `records` is the full
// person_tokens table (a household is a handful of rows, never paginated),
// passed straight through from fetchPersonTokens with no reshaping needed.
// A match re-issues the sliding-window expiry from `now`, independent of how
// much of the previous window was left.
export function validatePersonToken(
  raw: string,
  records: PersonToken[],
  now: Date,
  maxAgeSeconds = COOKIE_MAX_AGE_SECONDS,
): PersonAuthResult {
  if (!raw) {
    return { valid: false };
  }

  const match = records.find((record) => timingSafeEqualStr(record.token, raw));
  if (!match) {
    return { valid: false };
  }

  return {
    valid: true,
    personId: match.id,
    name: match.name,
    expiresAt: new Date(now.getTime() + maxAgeSeconds * 1000),
  };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Lengths differ in practice all the time (a mistyped/truncated token) —
  // comparing against a fixed-length buffer keeps this branch itself from
  // being the timing leak.
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
