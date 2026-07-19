import { defineMiddleware } from "astro:middleware";
import { bootstrapHtml } from "./lib/bootstrapHtml.js";
import { validateInitData } from "./lib/initData.js";
import { getConfig } from "./lib/webDb.js";

const INIT_DATA_COOKIE = "tg_init_data";

// Gates every route on a validated Telegram initData cookie (per #21 — a
// household of 2 same-trust users, so this only answers "is this actually
// Telegram, and one of our two users," not per-user permissions). The
// cookie is set by bootstrapHtml's client-side script on first launch,
// before this middleware ever sees a request carrying it.
export const onRequest = defineMiddleware((context, next) => {
  const config = getConfig();
  const raw = context.cookies.get(INIT_DATA_COOKIE)?.value ?? "";
  const result = validateInitData(raw, config.telegramBotToken, config.allowedUserIds, new Date());

  if (!result.valid) {
    if (context.url.pathname.startsWith("/_actions")) {
      return new Response(JSON.stringify({ error: result.reason }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(bootstrapHtml(), {
      status: 401,
      headers: { "content-type": "text/html" },
    });
  }

  context.locals.userId = result.userId;
  return next();
});
