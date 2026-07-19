# Deploy as a single Docker container on the household Pi

> **Amended by #19/#21/#22 (2026-07-19):** the "no public inbound URL" consequence below is
> superseded for the Mini App only. The bot container itself is unchanged (still outbound-only,
> long polling); a second container, `pantry-web`, now serves a Telegram Mini App fronted by a
> named Cloudflare Tunnel, added to the same docker-compose stack. See #21 for why a public
> HTTPS URL is unavoidable for a Mini App (Telegram's WebView requires a CA-signed cert) and #22
> for why it's a new service rather than folded into the bot's own container.

Pantry Bot serves exactly one household — two users, a handful of Telegram messages a day, one daily digest. We decided it runs as a single Docker container on the household Raspberry Pi (OpenMediaVault, existing Docker setup), talking to Telegram via long polling, with SQLite on a Docker volume as the only store and the Expiry Digest fired by an in-process scheduler. The bot only ever makes outbound connections — to the Telegram API and to the OCR/LLM API for receipt parsing — so nothing is exposed from the home network: no webhooks, port forwarding, reverse proxy, TLS, or public URL.

The rejected alternative was a hosted platform (Cloudflare Workers' free tier covers this load easily). It was rejected because it constrains the runtime and storage model, while the design wants a boring long-running process with a local file: at this scale the whole Catalog and Stock Lot history is one SQLite file, and backup is folding that file into the existing OMV backup routine.

## Consequences

- Availability is household availability. If the Pi is down at digest time, the nudge is late or skipped — acceptable, and safe under ADR 0002: stored state only changes on human taps, so downtime can never corrupt it.
- Images must target arm64 (build on the Pi or multi-arch).
- Receipt parsing stays an outbound API call; the Pi never needs the compute for OCR.
- Anything that assumes a public inbound URL (Telegram webhooks, web dashboards) is off the table unless this decision is revisited.
