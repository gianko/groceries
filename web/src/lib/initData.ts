import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_AGE_SECONDS = 24 * 60 * 60;

export type InitDataResult =
  | { valid: true; userId: number; firstName: string }
  | { valid: false; reason: string };

// Validates Telegram Mini App initData per
// docs/research/telegram-mini-app-requirements.md §3: HMAC-SHA256 over the
// sorted "key=value" fields (excluding hash), keyed by HMAC-SHA256(bot
// token, "WebAppData"). Two users, same trust level (per #19) — this only
// gates "is this actually Telegram, and is it one of our two users," not
// per-user permissions.
export function validateInitData(
  raw: string,
  botToken: string,
  allowedUserIds: number[],
  now: Date,
  maxAgeSeconds = MAX_AGE_SECONDS,
): InitDataResult {
  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  if (!hash) {
    return { valid: false, reason: "missing hash" };
  }
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (!timingSafeEqualHex(computedHash, hash)) {
    return { valid: false, reason: "signature mismatch" };
  }

  const authDate = params.get("auth_date");
  if (!authDate || !/^\d+$/.test(authDate)) {
    return { valid: false, reason: "missing auth_date" };
  }
  const ageSeconds = now.getTime() / 1000 - Number.parseInt(authDate, 10);
  if (ageSeconds > maxAgeSeconds) {
    return { valid: false, reason: "stale auth_date" };
  }

  const userRaw = params.get("user");
  if (!userRaw) {
    return { valid: false, reason: "missing user" };
  }
  let userId: number;
  let firstName: string;
  try {
    const user = JSON.parse(userRaw);
    userId = user.id;
    firstName = user.first_name;
  } catch {
    return { valid: false, reason: "malformed user" };
  }
  if (typeof userId !== "number" || !allowedUserIds.includes(userId)) {
    return { valid: false, reason: "user not allowed" };
  }

  return { valid: true, userId, firstName };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
