import { defineMiddleware } from "astro:middleware";
import { fetchPersonTokens } from "../../src/personTokens.js";
import { PERSON_TOKEN_COOKIE, validatePersonToken } from "./lib/personAuth.js";
import { getDb } from "./lib/webDb.js";

// Any normal (non-Action) navigation with no valid cookie lands here — per
// #45 there's no in-app recovery/reset flow, just a plain message pointing
// at the bootstrap link a household admin already has.
const REJECTION_HTML = `<!doctype html>
<html>
<head><title>Pantry</title></head>
<body>
<p>You need a bootstrap link to use this app. Ask whoever set up the household Pi for yours.</p>
</body>
</html>`;

// Gates every route on a per-person bootstrap token cookie (#45, replacing
// the Telegram initData gate). /bootstrap/[token] is deliberately exempt —
// it's the one route a visitor reaches with no cookie yet, and it does its
// own token check before issuing one.
export const onRequest = defineMiddleware((context, next) => {
  if (context.url.pathname.startsWith("/bootstrap/")) {
    return next();
  }

  const db = getDb();
  const raw = context.cookies.get(PERSON_TOKEN_COOKIE)?.value ?? "";
  const result = validatePersonToken(raw, fetchPersonTokens(db), new Date());

  if (!result.valid) {
    if (context.url.pathname.startsWith("/_actions")) {
      return new Response(JSON.stringify({ error: "missing or invalid bootstrap token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(REJECTION_HTML, {
      status: 401,
      headers: { "content-type": "text/html" },
    });
  }

  // Sliding window: every authenticated request re-issues the cookie with a
  // fresh one-year expiry (result.expiresAt, computed from `now`), so the
  // horizon is always "a year from the last visit," not a fixed date from
  // bootstrap time.
  context.cookies.set(PERSON_TOKEN_COOKIE, raw, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires: result.expiresAt,
  });

  context.locals.userId = result.personId;
  context.locals.userName = result.name;
  return next();
});
