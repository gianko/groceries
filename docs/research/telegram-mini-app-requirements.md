# Telegram Mini App requirements vs. a standalone LAN webapp

> Feeds decision ticket [#21](https://github.com/gianko/groceries/issues/21) (child of map issue #19,
> redesigning Pantry Bot's interactive UI): whether to build a Telegram Mini App (WebApp) for the
> household's 2-user pantry bot, or a standalone webapp with zero Telegram integration reachable
> only on the home LAN/NAS.
>
> Researched 2026-07-19 against primary sources: Telegram Bot API docs
> ([core.telegram.org/bots/api](https://core.telegram.org/bots/api)), Telegram Mini Apps docs
> ([core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps)), Telegram bot feature
> docs ([core.telegram.org/bots/features](https://core.telegram.org/bots/features)), the webhook
> TLS guide ([core.telegram.org/bots/webhooks](https://core.telegram.org/bots/webhooks)), and the
> Bot API changelog ([core.telegram.org/bots/api-changelog](https://core.telegram.org/bots/api-changelog)).
> Every claim below is cited to one of these pages; where a claim could not be confirmed against a
> primary source, that gap is stated explicitly rather than filled in from secondary blogs.

## Verdict

**A Mini App requires exactly one thing a LAN-only webapp doesn't: a publicly reachable HTTPS URL
with a browser-trusted (CA-signed) certificate.** Everything else Telegram documents — `initData`
validation, launch mechanism registration via BotFather — is either optional (auth validation is a
security recommendation, not a functional gate, §3) or a few minutes of BotFather configuration
(§2), not an engineering blocker.

The HTTPS-with-trusted-CA requirement is real but **not a blocker for a 2-person household**: a
free tunnel (Cloudflare Tunnel, or ngrok's free tier) puts a CA-signed cert in front of a LAN
service in minutes, satisfying Telegram's WebView with zero public DNS/domain ownership needed
beyond the tunnel provider's subdomain. Critically, this is *not* the same relaxed trust model
Telegram allows for bot **webhooks** (§1) — that pathway explicitly permits self-signed certs
because Telegram's own server does the TLS handshake and can be handed the public key directly
([core.telegram.org/bots/webhooks](https://core.telegram.org/bots/webhooks)). A Mini App's URL is
instead loaded inside the Telegram client's WebView like a normal browser page, so there is no
documented mechanism to pin or upload a self-signed cert for it — it needs a cert an ordinary
browser trust store accepts.

So the real decision for #21 is not "can we technically satisfy Telegram's requirements" (yes,
trivially, via a tunnel) but "is the added moving part (tunnel + BotFather config + optional
`initData` check) worth it" against a standalone webapp that needs literally none of it and works
today over bare HTTP on the LAN (§5). Nothing Telegram documents makes the Mini App path
infeasible; it just adds one always-on dependency (the tunnel) that a LAN-only webapp has no
equivalent of.

---

## 1. Hosting requirements for a Mini App

- **HTTPS is required in practice, though the Mini Apps page itself never states it as a bare
  mandate** — it's established by exception: the docs say that "when working with the test
  environment, you may use HTTP links without TLS in the `url` field of both `LoginUrl` and
  `WebAppInfo`" (test-environment carve-out, confirmed via
  [core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps) and cross-referenced
  in the Bot API docs). The existence of an explicit "no-TLS-needed-for-testing" exception implies
  TLS is otherwise required in the production Bot API for any `WebAppInfo.url` / menu-button URL.
- **No explicit statement of "publicly resolvable domain mandatory."** The docs never say the
  hostname must be in public DNS or CA-issued from a specific list of CAs — only that the
  connection must be HTTPS. A tunnel-issued hostname (e.g. `*.trycloudflare.com`, `*.ngrok-free.app`)
  is a normal publicly-resolvable hostname with a CA-signed cert, so it satisfies this with no
  distinction from a "real" domain in anything Telegram documents.
- **Self-signed certs: documented as acceptable only for the separate webhook mechanism, not for
  Mini App hosting.** [core.telegram.org/bots/webhooks](https://core.telegram.org/bots/webhooks)
  has an explicit section ("A self-signed certificate") stating: "Using a self-signed certificate
  means you'll forfeit on the chain of trust... you have to use the generated public certificate
  as an input file when setting the webhook" (uploaded via `setWebhook`'s `certificate` parameter).
  That page also states webhooks support "any SSL/TLS version TLS1.2 and up... SSLV2/3/TLS1.0/TLS1.1
  are NOT supported." **This machinery is specific to webhooks** — the same page states it does not
  address Mini Apps/WebView hosting at all, and no equivalent "upload your self-signed cert to
  Telegram" mechanism is documented anywhere for the Mini App URL. Because the Mini App URL is
  rendered inside the Telegram client's own WebView (a normal TLS client, not Telegram's server),
  a self-signed cert on the Mini App host would fail exactly as it would in an ordinary browser —
  there is nothing in the docs analogous to the webhook's pinning workaround.
- **Net for the household case**: a tunnel (Cloudflare Tunnel / ngrok) that terminates TLS with a
  CA-signed cert on a tunnel-provided hostname is the documented-compliant path — it needs no
  public domain purchase and no self-signed-cert workaround, because it's already a standard
  browser-trusted cert on a standard public hostname.

## 2. Launch/configuration mechanisms

Per [core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps) and
[core.telegram.org/bots/features](https://core.telegram.org/bots/features), Telegram documents
these launch surfaces, all of which require the same HTTPS-hosted URL as a prerequisite (there is
no launch mode that relaxes the hosting requirement):

| Mechanism | Setup | Notes for a 2-person bot |
|---|---|---|
| **Menu button** (`/setmenubutton`) | BotFather: "the `/setmenubutton` command or _Bot Settings > Menu Button_" (quoted from webapps docs) | Global per-bot button visible in every chat with the bot; simplest, one-time setup, no per-message wiring needed. Best fit for a household bot — both members see the same persistent launcher. |
| **Inline keyboard `web_app` button** | Set programmatically per sent message via `InlineKeyboardButton.web_app` (Bot API) | Needs code in the bot to attach the button to specific messages (e.g. "open the pantry" prompt). More flexible (contextual launches) but is per-message plumbing, not a standing UI element. |
| **Keyboard button (`web_app` reply keyboard)** | `KeyboardButton.web_app`; data returned via `sendData()` as a service message | Different data-return path (message-based, not `initData`-based); more relevant for send-back-a-value micro-UIs than a full app. |
| **Attachment menu** | BotFather `/setattach`; requires the bot be "approved" for a user's attachment menu (per webapps docs: "Mini App Bots can request to be added directly to a user's attachment menu") | Documented as gated/approval-oriented — overkill and possibly unavailable for a private household bot not seeking wide distribution. |
| **Direct link** `t.me/<bot>/<app>[?startapp=...]` | Requires a named Mini App created in BotFather (`/newapp`-style flow) with a short name, distinct from the bot itself | Useful for sharing a link outside Telegram chat UI (e.g. pinned in a household group topic), but adds the extra step of registering a distinctly-named Mini App rather than reusing the bot's own "Main Mini App." |
| **Main Mini App** | BotFather: "`/mybots` > Select bot > _Bot Settings_ > _Configure Mini App_" (quoted from features docs) — accessible via a "Launch app" button on the bot's profile | Simplest registration: one Mini App tied 1:1 to the bot, no separate app identity to manage. |

**Tradeoff summary for a tiny household bot**: none of these require registering a Mini App as an
app store-style "distinct product" — a bot can have exactly one **Main Mini App** configured
against it via BotFather, which is the natural fit here. The **menu button** is the best
discoverability/effort tradeoff (always visible, one BotFather command to set up); the inline
`web_app` keyboard button is worth adding only if specific bot replies (e.g. "confirm this
receipt") should deep-link into a specific in-app view. The attachment menu and separate
`/newapp`-named app + direct link are unnecessary machinery for a 2-person, non-public bot. All of
them still need the same HTTPS URL from §1 — there is no launch mechanism that sidesteps hosting
requirements.

## 3. `initData` auth validation

Documented in the "Validating data received via the Mini App" section of
[core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps):

- **Data-check-string construction**: "chain of all received fields, sorted alphabetically, in the
  format `key=<value>` with a line feed character (`\n`, 0x0A) used as separator," excluding `hash`
  itself. Example given: `'auth_date=<auth_date>\nquery_id=<query_id>\nuser=<user>'`.
- **Secret key derivation**: "the secret key, which is the HMAC-SHA-256 signature of the bot's
  token with the constant string `WebAppData` used as a key" — i.e.
  `secret_key = HMAC_SHA256(key="WebAppData", data=bot_token)`.
- **Hash comparison**: verify with
  `hex(HMAC_SHA256(data_check_string, secret_key)) == hash` (quoted pseudocode from the same
  section).
- **Freshness check**: the docs additionally recommend checking `auth_date` ("a Unix timestamp of
  when it was received by the Mini App") to reject stale payloads.
- **A separate, alternative scheme exists** ("Validating data for Third-Party Use") using Ed25519
  signatures verified against a Telegram-published public key instead of the bot token — intended
  for third parties who don't hold the bot token themselves; not relevant when the bot's own
  backend is doing the validation.
- **Is it mandatory for the Mini App to function?** The docs describe this purely as a
  server-side integrity check the bot's backend should perform on data it receives *from* the Mini
  App (e.g. via `sendData()` or the `web_app_data` payload) — nothing in the cited section states
  that Telegram itself refuses to launch or blocks a Mini App from functioning if the backend skips
  validation. It reads as a security recommendation ("if the received data is genuinely sent by
  your bot's users, [it should validate to true]") rather than a functional gate enforced by
  Telegram's client. For a 2-person household bot where both users are already trusted and the
  Mini App only reaches the bot's own backend on the LAN/tunnel, skipping it is a reduced-attack-
  surface tradeoff, not a broken feature.
- **Implementation burden**: the entire algorithm is roughly 10-15 lines of code — one HMAC-SHA256
  call to derive the secret key, one more to compute the data-check-string's HMAC, a string
  compare, plus optional timestamp-freshness logic. It requires no external library; it's the kind
  of function typically hand-rolled in a few dozen lines in any language with an HMAC-SHA256
  primitive (Node's built-in `crypto` module suffices for a grammY/TS project). Community reference
  implementations exist as small gists across many languages, but Telegram does not publish an
  official SDK/library for this — the spec is the full implementation.

## 4. Hard constraints

- **Origin/domain restriction (new, dated)**: per the
  [Bot API changelog](https://core.telegram.org/bots/api-changelog), Bot API 10.2 (dated in the
  changelog) "Hardened the security of Mini Apps by disallowing the usage of Mini App methods from
  origins different from the original Mini App domain. The protection will be automatically
  enabled for all Mini Apps on July 20, 2026." — i.e. as of the day after this research was
  performed, Mini Apps are locked to calling Telegram WebApp JS methods only from their own
  registered domain by default (bot owners can opt out via BotFather, at their own risk, per the
  same entry). This is same-origin enforcement of the *Mini App's own domain*, not a Telegram-side
  allow-list of arbitrary external domains — it doesn't add any new hosting requirement beyond
  "the Mini App is served consistently from the one domain it was registered/launched from."
- **iframe embedding / CSP**: no primary-source page found addresses this. Neither
  [core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps) nor
  [core.telegram.org/bots/features](https://core.telegram.org/bots/features) documents any CSP
  policy Telegram imposes on the loaded page, or states the Mini App is embedded via `<iframe>`
  (vs. a native WebView). Treat this as **undocumented** rather than assume a specific behavior.
- **Offline/no-connectivity behavior**: not addressed in the primary docs reviewed. No statement
  was found describing what the Telegram client does if the Mini App's HTTPS endpoint is
  unreachable (error screen, retry, silent blank view, etc.). This is a genuine documentation gap
  in the primary sources — plan for it defensively rather than relying on a documented fallback.
- **Client parity (mobile vs. Desktop vs. Web)**: the docs version-gate individual JS-bridge
  features by Bot API version (e.g. features tagged "Bot API 8.0+", with a documented
  `WebApp.isVersionAtLeast(version)` check "returns true if the user's app supports a version of
  the Bot API that is equal to or higher than the version passed"), which by itself confirms
  **client implementations lag each other and feature availability is not uniform** — that's the
  entire reason the version-check API exists. Beyond that generic acknowledgment, no explicit
  feature-availability table contrasting mobile apps vs. Telegram Desktop vs. Telegram Web was
  found on the pages reviewed. There is a documented Android-specific enhancement (richer
  `User-Agent` hardware/performance data for Android devices) confirming at least one concrete,
  named platform asymmetry exists, but a full mobile/desktop/web parity matrix is not published
  where checked. Treat exact cross-client parity as **unverified against primary sources** beyond
  "some version- and platform-gated differences are real and Telegram provides `isVersionAtLeast`
  specifically because of them."

## 5. For comparison: a standalone LAN-only webapp

None of §1-§4 applies. A webapp with zero Telegram integration, no auth, reachable only on the
household's home LAN/NAS needs:

- **No TLS/HTTPS mandate** — a bare `http://` server on the LAN (e.g. serving from the existing
  Raspberry Pi via Docker Compose under OMV) works with any browser today; there is no third party
  (Telegram) imposing a hosting-side requirement at all.
- **No domain** — an IP address or local mDNS/`.local` hostname (or a Pi-hole/router DNS entry) is
  sufficient; nothing needs to resolve outside the LAN.
- **No `initData`/HMAC validation, no auth mechanism at all** — matches the stated requirement:
  2 users, same trust level, no auth differentiation needed.
- **No launch-mechanism registration** — a bookmark, home-screen shortcut, or router/NAS landing
  page link is the entire "launch mechanism"; nothing to configure in a third-party bot-management
  console.
- **Offline behavior is fully in the team's control** — since there's no external platform
  wrapping the page, whatever the app itself does when the Pi is unreachable (e.g. standard
  browser "can't reach this page") is the whole story; no undocumented third-party client behavior
  to hedge against.
- **Client parity is whatever the team's own browser support target is** — no per-platform
  Telegram-client feature gating to track or version-check against.
- **Real-world catch: "secure context" gating in browsers is unrelated to Telegram but still
  matters.** Modern browsers gate a growing list of Web APIs behind a "secure context" (HTTPS, or
  `localhost`) requirement independent of anything Telegram does — e.g. Service Workers (needed for
  offline caching / installable PWA behavior), the Web Crypto `SubtleCrypto` API, clipboard-write,
  geolocation on some browsers, and camera/microphone access via `getUserMedia`. A bare-HTTP LAN
  app that wants PWA-style install/offline support or camera access (e.g. for photographing a
  receipt from the webapp itself) would hit this browser-level restriction — solvable by treating
  the Pi's LAN hostname as `localhost`-equivalent is not possible across devices, so this would
  still require *some* TLS story (e.g. a self-signed cert trusted only on the household's own
  devices, or a lightweight local CA) if those specific APIs are wanted, but this is a browser
  vendor policy, not anything Telegram enforces, and is avoidable entirely by not depending on
  those specific APIs (e.g. uploading a photo via a normal `<input type="file">` works fine over
  plain HTTP).

## Comparison table

| Requirement | Telegram Mini App | Standalone LAN webapp |
|---|---|---|
| HTTPS/TLS | Required in practice (implied by test-environment HTTP exception); must be a browser-trusted CA cert — no documented self-signed-cert path for Mini App hosting (unlike webhooks) [core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps), [core.telegram.org/bots/webhooks](https://core.telegram.org/bots/webhooks) | None — bare HTTP works today |
| Public domain | Not explicitly mandated, but needs a resolvable HTTPS hostname (a tunnel subdomain satisfies this) | None — LAN IP or `.local` hostname |
| Auth mechanism | Optional but recommended: HMAC-SHA-256 `initData` validation, ~10-15 lines, hand-rolled, no official library [core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps) | None needed (2 equally-trusted users, explicit requirement) |
| Launch mechanism | Menu button / inline `web_app` button / attachment menu / direct link / Main Mini App — all via BotFather, all need the HTTPS URL from row 1 [core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps), [core.telegram.org/bots/features](https://core.telegram.org/bots/features) | Bookmark / home-screen shortcut / NAS landing page link |
| Offline behavior | Undocumented in primary sources reviewed — no stated client fallback behavior | Fully in the team's control; standard browser offline handling |
| Client parity | Some version-/platform-gated feature differences confirmed to exist (`isVersionAtLeast` API, Android-specific User-Agent data); no full mobile/Desktop/Web parity table found in primary docs | N/A — one browser target, team's choice |
| Implementation burden | Tunnel setup + BotFather menu-button config + optional ~15-line `initData` validator | Zero extra infrastructure beyond what already runs on the Pi |
