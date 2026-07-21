# Pantry Bot

A household food + pantry inventory assistant for two users, driven by Tesco Ireland receipt photos through a Telegram group. Snap a receipt, confirm the parse, and Pantry Bot tracks what's in the house, nudges you before food expires, suggests what to cook, and keeps a shopping list in sync — all through one Telegram chat.

## What it does

- **Receipt-photo ingestion** — send a photo of a Tesco receipt (or reply to one) and Gemini extracts line items into Products and Stock Lots. Known raw receipt strings (e.g. `T.FIN B/BEANS 420G`) are remembered permanently, so the same product never needs re-parsing.
- **Inventory tracking** — `/inventory` lists everything in stock, soonest-expiring food first, each with a one-tap Finish button. Stock only ever changes on a human tap — nothing auto-expires or auto-finishes.
- **Expiry Digest** — a daily message listing what's expiring within 2 days and what just expired, with Gone / Still-good buttons to resolve each.
- **Shopping list** — `/list` and `/shopping` show what's queued, plus "probably low" Cycle Guesses derived from purchase history and "use soon" nudges from lots close to expiry.
- **Recipe suggestions** — `/cook` surfaces favorite recipes fully covered by what's on hand, then asks Gemini for more, split into "cook tonight" (nothing missing) and "almost there" (a few items away, one tap to queue them).
- **Free-text add** — `/add` (or replying with free text) parses a plain-English pantry list into Products/Lots without needing a receipt.
- **Staples & Auto-Relist** — mark products that are always assumed present (`/staple`) or that should re-queue themselves the moment they're finished, no prompt needed.
- **Preferences** — `/prefs` holds household size and a free-text cooking-constraints blurb that shapes recipe suggestions.

## Why it exists

Built for a two-person household to replace mental tracking of "do we still have X" and "what's about to go off." Design decisions are recorded as ADRs in [`docs/adr/`](docs/adr/); the domain vocabulary (Product, Stock Lot, Raw Name, Cycle Guess, etc.) is defined in [`CONTEXT.md`](CONTEXT.md).

Three decisions shape everything else:

- **Product vs. Stock Lot** ([ADR 0001](docs/adr/0001-product-stock-lot-split.md)) — catalog identity (name, category, staple flag) is split from purchase state (quantity, purchase date, expiry, status), so recipes/shopping reason about Products while expiry/finish/decrement reason about Lots.
- **Human-confirmed state only** ([ADR 0002](docs/adr/0002-human-confirmed-state-only.md)) — estimated expiry, "probably low," and decremented quantities are all derived at query time. Nothing about stored state changes without a one-tap human confirmation; no cron job silently flips a status.
- **Single Pi container** ([ADR 0003](docs/adr/0003-deploy-on-household-pi.md)) — this serves one household, so it runs as one Docker container on a household Raspberry Pi, outbound-only (Telegram long polling + Gemini API calls), with SQLite as the only store. No inbound ports, no webhooks, no public URL.

## Commands

All commands are restricted to a fixed set of Telegram user IDs inside one group chat (`ALLOWED_USER_IDS` + `GROUP_CHAT_ID`); everything else is silently ignored.

| Command | Does |
|---|---|
| `/ping` | Liveness check — replies "pong". |
| `/inventory` | Lists in-stock lots (🍎 food, soonest-expiring first; 🧽 household, alphabetical), each with a Finish button. Finishing a product flagged Auto-Relist re-queues it automatically; others prompt "always re-add?". |
| `/list [text]` | Shows the open shopping list; optional trailing text is added as a manual entry. |
| `/shopping` | Pre-shop summary: shopping list + "use soon / don't rebuy" (expiring ≤2 days) + "probably low" Cycle Guesses with Add/Skip buttons. Reply to add more items any time. |
| `/staple <name>` | Marks a product as always-present; staples are never treated as missing in recipe suggestions. |
| `/cook` | Favorite recipes fully covered by current stock, then 2–3 Gemini suggestions split into "cook tonight" and "almost there." "Cooking this" decrements stock and asks for a 👍/👎 rating. |
| `/prefs` | Shows/edits household size and a free-text cooking-constraints blurb; reply with `size: 3` or plain text to update. |
| `/add <items>` | Free-text pantry list parsed into items, shown with Confirm/Edit/Discard. |
| photo captioned `/receipt` (or a photo reply) | Extracts a Tesco receipt via Gemini, shown with Confirm/Edit/Discard. Confirming creates Products/Lots, maps the raw receipt strings for future bypasses, and closes matching shopping-list entries. |
| *(no command)* | **Expiry Digest** — daily, automatic. Lists expiring-soon and just-expired lots with Gone/Still-good buttons, plus a "🍳 Recipe ideas?" shortcut into `/cook`. |

Every confirm/finish/rate button is first-tap-wins, so double-taps and concurrent taps from both household members never double-write.

## Architecture

- **Runtime**: Node 22 + TypeScript, [grammY](https://grammy.dev/) for Telegram (long polling, no webhooks), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) + [Drizzle ORM](https://orm.drizzle.team/) for storage.
- **Brain seam** ([`src/brain.ts`](src/brain.ts)): a single Zod-validated interface (`extractReceipt`, `reviseReceipt`, `suggestRecipes`, `estimateShelfLife`, `parseFreeTextItems`, `reviseFreeTextItems`) that every LLM-touching flow goes through. [`src/brain/gemini.ts`](src/brain/gemini.ts) is the only implementation (Gemini 2.5 Flash), with JSON-only prompts, one retry on parse failure, and exponential backoff before raising `BrainUnavailableError` (surfaced to users as "🧠 busy, try again in a minute"). Shelf-life estimation first consults the free USDA FoodKeeper dataset before falling back to Gemini, per the spec amendment in issue #1.
- **Data model** ([`src/db/schema.ts`](src/db/schema.ts)): `products` (catalog identity), `stock_lots` (one purchase, `in_stock`/`finished`), `shopping_list_entries`, `raw_name_map` (permanent receipt-string → product), `prefs`, `pendings`, `recipes` (rating history), `expiry_verdicts` (outstanding gone/still-good prompts).
- **Ops**: an in-process heartbeat file backs a Docker `HEALTHCHECK`; a nightly cron `VACUUM INTO`s a snapshot file onto the host filesystem for the existing backup routine to pick up; the Expiry Digest runs on its own cron. All three log and continue on failure rather than crashing the bot.

```
src/
  bot.ts           command routing + access control
  brain.ts         LLM seam interface
  brain/gemini.ts  Gemini implementation
  db.ts, db/schema.ts
  add.ts, cook.ts, digest.ts, finish.ts, inventory.ts,
  list.ts, prefs.ts, receipt.ts, reconcile.ts, shopping.ts, staple.ts
  config.ts        env var loading/validation
  healthcheck.ts, heartbeat.ts, snapshot.ts   ops
  index.ts         entry point
```

## Getting started

### Prerequisites

- Node ≥22, [pnpm](https://pnpm.io/) 10
- A Telegram bot token ([@BotFather](https://t.me/BotFather))
- A Gemini API key

### Setup

```bash
pnpm install
cp .env.example .env   # fill in the values below
pnpm dev                # tsx watch, runs against a local SQLite file
```

`.env`:

| Var | Required | Default | Notes |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | from BotFather |
| `GEMINI_API_KEY` | yes | — | |
| `ALLOWED_USER_IDS` | yes | — | comma-separated Telegram user IDs of the two household members |
| `GROUP_CHAT_ID` | yes | — | the household Telegram group |
| `TZ` | yes | — | e.g. `Europe/Dublin`; governs snapshot cron timing |
| `DB_PATH` | no | `pantry.db` | |
| `HEARTBEAT_PATH` | no | `heartbeat` | |
| `HEARTBEAT_INTERVAL_MS` | no | `30000` | |
| `HEARTBEAT_STALE_MS` | no | `90000` | healthcheck fails if the heartbeat file is older than this |
| `SNAPSHOT_PATH` | no | `pantry.snapshot.db` | |
| `SNAPSHOT_CRON` | no | `0 3 * * *` | |

### Scripts

```bash
pnpm dev          # run with hot reload
pnpm build        # compile to dist/
pnpm start        # run compiled output
pnpm test         # vitest run
pnpm test:watch
pnpm typecheck
pnpm lint         # biome check
pnpm lint:fix
```

Tests live in `test/`, one file per module (plus `test/support/` for shared fakes: a fake `Brain`, a fake clock, a bot-update harness). Pre-commit hooks run via lefthook (installed automatically on `pnpm install`).

### Deploying

Ships as a single Docker container (arm64) via `docker-compose.yml`, designed for OMV's Compose plugin on a household Raspberry Pi — see [ADR 0003](docs/adr/0003-deploy-on-household-pi.md). No inbound ports are exposed; the container only makes outbound calls to Telegram and Gemini. The bind-mounted `/data` volume holds the SQLite DB, heartbeat file, and nightly snapshot so the host's existing backup routine can see them directly.

```bash
docker build -t pantry-bot .
docker compose up -d
```

## Project docs

- [`CONTEXT.md`](CONTEXT.md) — domain vocabulary
- [`docs/adr/`](docs/adr/) — architecture decisions
- [`docs/agents/`](docs/agents/) — issue tracker, triage labels, and domain-doc conventions for agents working in this repo
- [`docs/research/prior-art-pantry-apps.md`](docs/research/prior-art-pantry-apps.md) — build-vs-reuse research behind the build-from-scratch decision

## Status

Feature-complete for v1 (tracked in [issue #1](https://github.com/gianko/groceries/issues/1)): bot skeleton, schema, receipt pipeline with raw-name mapping, prefs, shopping list core, two-tier `/cook` suggestions, cooking decrement + finish-confirmation, recipe ratings, receipt reconciliation with the shopping list, pre-shop summary with Cycle Guesses, Staples + Auto-Relist, Expiry Digest with gone/still-good verdicts, and free-text `/add`. All build issues (#2–#18) are closed.
