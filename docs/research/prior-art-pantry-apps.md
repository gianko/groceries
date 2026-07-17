# Prior art: build vs. reuse for Pantry Bot

> **Location note**: the repo keeps docs under `docs/` (`docs/adr/`, `docs/agents/`); there was no
> research directory, so this file establishes `docs/research/` as the home for research notes.
>
> Researched 2026-07-17 against primary sources (project READMEs, official docs, issue trackers).
> Every claim is cited. Judged against the five hard requirements from Issue #1:
> (1) zero manual entry via receipt-photo + LLM parsing with a confirm step,
> (2) Telegram-group-first UX with inline keyboards,
> (3) expiry tracking with *estimated* shelf life,
> (4) expiry-weighted recipe suggestions from stock,
> (5) self-hostable, lightweight, arm64/Raspberry Pi, two users.

## Verdict: build, with targeted component reuse

**No candidate can be reused wholesale, and no candidate earns its keep even as a backend
component.** Score summary against the hard requirements:

| Candidate | 1. Receipt-photo ingestion | 2. Telegram-first | 3. Estimated expiry | 4. Expiry-weighted recipes | 5. Pi/arm64, light |
|---|---|---|---|---|---|
| Grocy | ✗ (open FR since 2019) | ✗ (bot archived 2020) | ◐ manual per-product config | ◐ "Due Score", user-entered recipes | ✓ |
| KitchenOwl | ✗ | ✗ | ✗ (no inventory/expiry) | ✗ | ✓ |
| Tandoor Recipes | ✗ | ✗ | ✗ | ✗ | ✓ |
| Mealie | ✗ (AI imports *recipes*, not receipts) | ✗ | ✗ | ✗ | ✓ |
| Grocery (iOS) | ✗ | ✗ | ✗ | ✗ | ✗ (proprietary iCloud app) |
| Receipt-OCR projects | ◐ (tesseract-era, or immature) | ✗ | ✗ | ✗ | varies |

Why the two plausible reuse paths fail:

1. **Grocy wholesale** fails requirements 1–3: receipt ingestion has been an open feature request
   since October 2019 with no maintainer commitment ([grocy#404](https://github.com/grocy/grocy/issues/404));
   a November 2025 "AI receipt scanning" request was closed as a duplicate of it
   ([grocy#2831](https://github.com/grocy/grocy/issues/2831)). Its UX is a web app; the only
   Telegram bridge was archived read-only in September 2020
   ([markusressel/grocy-telegram-bot](https://github.com/markusressel/grocy-telegram-bot)).
   Expiry relies on per-product "default due days" the *user* configures, not estimates
   ([grocy changelog](https://grocy.info/changelog)).
2. **Grocy as inventory backend behind a custom Telegram + LLM front end** (partial reuse) is
   technically viable — MIT license, "RESTful API for everything" with Swagger UI
   ([grocy.info](https://grocy.info/), [grocy/grocy](https://github.com/grocy/grocy)), active
   (v4.6.0, March 2026), and an official arm64 Docker image
   ([linuxserver docs](https://docs.linuxserver.io/images/docker-grocy/)). But it buys almost
   nothing. Everything hard in Pantry Bot lives *above* persistence: receipt extraction and the
   confirm/revise loop, Raw Name → Product mapping, human-confirmed-state-only semantics
   (ADR-0002), Cycle Guesses, first-tap-wins pendings, recipe verbatim-name enforcement. What
   Grocy would replace — a handful of SQLite tables behind Drizzle — is the cheap part. In
   exchange you'd run a second container (PHP + its own SQLite), map Pantry Bot's
   Product/Stock-Lot semantics onto Grocy's product/stock-entry model (close but not identical:
   Grocy has opened/frozen states, auto-consume behaviors, and location tracking the spec
   explicitly excludes), and lose schema control for things like `raw_name` mappings and pending
   confirmations, which would need a side database anyway. Integration surface > code saved.

**Build it.** The spec's estimate of the actual novel core is right: a grammY bot, a 4-method
`Brain` interface to a multimodal LLM, and a small SQLite schema. That combination exists nowhere
as prior art. Reuse at the component level instead — see the last section.

---

## Candidates

### Grocy (+ ecosystem)

- Repo: <https://github.com/grocy/grocy> — MIT, PHP 8 + SQLite, 9.2k stars, v4.6.0 released
  2026-03-06; actively maintained.
- Site: <https://grocy.info/> — "ERP beyond your fridge". Stock management with due-date
  tracking, minimum-stock shopping list automation, recipes with in-stock checks and a "Due
  Score" that ranks recipes by how well they consume items "due soon or already overdue",
  barcode-reader-ready UI, and a "RESTful API for everything" with integrated Swagger UI.
- **Closest overall match**: it is the only candidate with a real pantry-inventory model
  (products + dated stock entries, i.e. roughly Product/Stock Lot) *and* expiry-aware recipe
  ranking.
- **Where it fails the requirements**:
  - *Receipt ingestion*: none. Feature request open since 2019-10-01 with no maintainer
    commitment or linked development ([#404](https://github.com/grocy/grocy/issues/404));
    the 2025 AI-receipt-scanning request was closed as duplicate
    ([#2831](https://github.com/grocy/grocy/issues/2831)). Grocy's zero-effort entry story is
    *barcodes*, not receipts.
  - *Expiry estimates*: due dates are entered at purchase or auto-filled from per-product
    "default due days" fields the user must configure by hand
    ([changelog](https://grocy.info/changelog)) — the exact manual-entry rock the spec says
    every inventory app dies on. (One could pre-fill `default_best_before_days` via the API from
    an LLM, but then the LLM layer is being built anyway.)
  - *Recipes*: user-entered cookbook, ranked against stock; no generation.
  - *Telegram*: nothing first-party; see ecosystem below.
- *Pi/arm64*: fine — linuxserver.io image ships amd64 + arm64v8
  ([docs.linuxserver.io/images/docker-grocy](https://docs.linuxserver.io/images/docker-grocy/)).
- **Ecosystem**:
  - [markusressel/grocy-telegram-bot](https://github.com/markusressel/grocy-telegram-bot) —
    Python bot over Grocy's REST API (inventory view, shopping list, chores). AGPL-3.0.
    **Archived read-only 2020-09-10**; last release v1.0.0 (2020-03-10). No receipt or photo
    support. Dead end.
  - [Forceu/barcodebuddy](https://github.com/Forceu/barcodebuddy) — AGPL-3.0+, v1.8.1.8
    (June 2024). Pipes barcode scans (hardware scanner or its Android app) into Grocy
    consume/add/open actions. **Barcodes only; no receipt handling.** Solves a different input
    problem — item-at-a-time scanning, which the spec's problem statement rejects as
    unsustainable ceremony.
  - [erinalbers/grocy-receipt-ocr](https://github.com/erinalbers/grocy-receipt-ocr) — MIT; the
    only project found that goes receipt → Grocy stock. OCRs a receipt image/PDF, matches lines
    to Grocy products **by barcode value printed on the receipt**, with per-store regex
    "processors" (example: Safeway) and a web UI for mapping unknowns. Early-stage (17 stars,
    18 commits), OCR + regex per store rather than LLM, US-store processors, no arm64 statement,
    web-only confirm flow. Proof the pipeline shape works; not a reusable component for Tesco
    Ireland + Telegram.
  - [manuel-rw/grocy-scanner](https://github.com/manuel-rw/grocy-scanner) — one-click
    barcode-scan companion; same barcode-not-receipt category.

### KitchenOwl

- Repo: <https://github.com/TomBursch/kitchenowl> — AGPL-3.0, Flask backend + Flutter apps,
  3.5k stars, v0.7.9 (2026-06-04); active.
- Official features ([kitchenowl.org/features](https://kitchenowl.org/features/)): synced
  shopping list, recipe management with web scraping, meal planner with "smart suggestions …
  based on your preferences and pantry inventory", expense tracking, Home Assistant integration.
- **Fails**: no expiry tracking, no receipt scanning, no LLM features, no Telegram integration
  anywhere in the official feature list. Its "pantry" is an ingredient availability list feeding
  meal-plan suggestions, not dated stock lots. Shopping-list-first web/mobile UX. Not a fit as
  app or backend — it lacks precisely the inventory/expiry layer Pantry Bot needs.

### Tandoor Recipes

- Repo: <https://github.com/TandoorRecipes/recipes> — AGPL-3.0 with a Commons-Clause-style
  selling exception from v0.10.0; 8.5k stars, very active (190 releases).
- Recipe manager: URL import via schema.org markup, meal planning, shopping list generation,
  and an AI assist "to recognize images, sort recipe steps, find nutrition facts" (recipe
  images, i.e. digitizing cookbook pages — not receipts).
- **Fails**: no pantry inventory, no expiry, no receipt ingestion, no Telegram. Recipe-first,
  which the spec explicitly doesn't want (recipes are LLM-generated; recipe APIs/scraping are
  out of scope).

### Mealie

- Repo: <https://github.com/mealie-recipes/mealie> — AGPL-3.0, 12.7k stars, v3.20.1
  (2026-06-26); active. REST API for integrations.
- Has real LLM plumbing: OpenAI-compatible-provider integration for importing a recipe from a
  *photo of a written/typed recipe* and AI ingredient parsing
  ([AI providers docs](https://docs.mealie.io/documentation/getting-started/installation/ai-providers/),
  [v1.12.0 "Image import via OpenAI"](https://github.com/mealie-recipes/mealie/releases/tag/v1.12.0)).
- **Fails**: recipe manager only — no pantry inventory, no expiry, and its image-AI targets
  recipe pages, not receipts. No Telegram. Its vision-import prompt flow is the one part worth a
  look (below).

### Grocery (iOS)

- <https://apps.apple.com/us/app/grocery-smart-shopping-list/id1195676848> — proprietary
  iPhone/Apple Watch shopping list by Conrad Stoll, built on the iOS Reminders/iCloud database;
  SmartSort learns store order ([announcement](http://conradstoll.com/blog/2017/5/9/introducing-grocery-an-opinionated-shopping-list-app-for-iphone-and-apple-watch)).
- **Fails everything relevant**: closed source, iOS-only, shopping-list-only, no inventory,
  no expiry, no receipts, not self-hostable, no Telegram. Only interesting as UX prior art for
  purchase-pattern learning (cf. Cycle Guess).

### Standalone Telegram pantry bots

- [jvmistica/telegram-assistant](https://github.com/jvmistica/telegram-assistant) — Go +
  PostgreSQL, MIT, 4 stars. Built explicitly "to prevent food … from going to waste", but entry
  is manual `/additem` commands and CSV import; no photos, no LLM, no confirm keyboards.
- Other hits ([addise33/Telegram-Bot-for-Inventory-Management](https://github.com/addise33/Telegram-Bot-for-Inventory-Management),
  [aldo235/Bot-Telegram-Inventory](https://github.com/aldo235/Bot-Telegram-Inventory)) are
  generic manual-entry stock bots for small businesses.
- **Conclusion**: the Telegram-pantry-bot niche exists only as toy manual-entry projects; none
  has receipt ingestion or expiry estimation. Nothing to reuse.

### Receipt-scanning / parsing projects

- **Tesco-specific**: none found. Searches for Tesco receipt parsers surface only generic
  tesseract projects ([GitHub topic: receipt-parser](https://github.com/topics/receipt-parser)).
  Nobody has published a Tesco Ireland receipt corpus or parser.
- **Tesseract-era parsers**: [ReceiptManager/receipt-parser-legacy](https://github.com/ReceiptManager/receipt-parser-legacy)
  and its many forks — Python + tesseract + fuzzy config-file matching of shop/date/total.
  They extract totals, not line items mapped to products; pre-LLM tech the spec already rules
  out ("OCR (Tesseract etc.)" is out of scope). Skip.
- **Model/LLM-based**: [fahmiaziz98/receipt_parsing](https://github.com/fahmiaziz98/receipt_parsing)
  (Donut model on the CORD receipt dataset) and
  [WellApp-ai/Well ai-invoice-extractor](https://github.com/WellApp-ai/Well/tree/main/ai-invoice-extractor)
  (MIT, prompt-based extraction via OpenAI/Mistral) show that "photo → JSON via multimodal
  model" is the settled modern approach — i.e. they validate the spec's `extractReceipt()`
  design, but each is a thin wrapper around exactly the prompt-plus-schema-validation loop the
  `Brain` interface already defines. Wrapping them adds a dependency without removing work.
- **Commercial receipt-OCR APIs** — [Taggun](https://www.taggun.io/),
  [Veryfi](https://www.veryfi.com/): hosted per-document-priced cloud APIs. They'd replace the
  free Gemini call with a paid, less flexible one (no Catalog-aware normalization prompt, no
  revision loop) and add a second external dependency. No advantage for this product.

---

## Components worth stealing / reusing

Even with a from-scratch build, these are worth lifting:

1. **USDA FSIS FoodKeeper dataset** — official US government shelf-life database (pantry /
   refrigerator / freezer durations per food), downloadable as JSON/XLS:
   [catalog.data.gov/dataset/fsis-foodkeeper-data](https://catalog.data.gov/dataset/fsis-foodkeeper-data),
   [USDA source page](https://ask.usda.gov/s/article/Where-can-I-find-the-data-set-for-the-FoodKeeper-application).
   Use it to *ground or sanity-check* `estimateShelfLife()` — e.g. embed relevant rows in the
   batched prompt, or as an offline fallback table when Gemini is down. Community wrappers exist
   ([jelera/food-shelflife-db](https://github.com/jelera/food-shelflife-db),
   [jcomo/shelf-life](https://github.com/jcomo/shelf-life)) but the raw JSON is small enough to
   vendor.
2. **Raw-name → product mapping memory** — grocy-receipt-ocr's "map it to an existing product,
   saving the barcode for next time" workflow
   ([README](https://github.com/erinalbers/grocy-receipt-ocr)) independently converges on the
   spec's Raw Name permanence rule; its category-mapping config file is a reasonable pattern to
   crib for Tesco department → food/household category defaults.
3. **Receipt corpora for tests** — the CORD dataset used by Donut-based parsers
   ([fahmiaziz98/receipt_parsing](https://github.com/fahmiaziz98/receipt_parsing)) for generic
   receipt-shape fixtures, plus (better) the household's own real Tesco receipts as the build
   plan already intends. An LLM receipt *generator* exists for synthetic fixtures
   ([WellApp-ai fake-receipt generator, MIT](https://news.ycombinator.com/item?id=44303126)).
4. **Vision-import prompt patterns** — Mealie's OpenAI image-import (strict JSON out of a photo,
   provider-agnostic via OpenAI-compatible endpoints,
   [docs](https://docs.mealie.io/documentation/getting-started/installation/ai-providers/)) and
   WellApp's extractor prompts are working reference implementations of the
   photo → schema-validated JSON → human-fix loop for the `Brain` methods.
5. **Grocy's "Due Score" concept** ([grocy.info](https://grocy.info/)) — prior art confirming
   the expiry-weighted recipe ranking idea; the weighting notion (rank by how much soon-due
   stock a recipe consumes) is worth mirroring inside the `suggestRecipes` prompt/deterministic
   pass.
6. **grammY** (already chosen in the spec) remains the right Telegram layer; nothing found
   suggests a higher-level framework for inline-keyboard confirmation flows worth adopting.

## Bottom line

The product's defining combination — receipt-photo-only ingestion for a specific retailer,
Telegram-group-native confirmations, estimated (not entered) expiry, and LLM-generated
expiry-weighted recipes on a Pi — does not exist in any current open-source or commercial
product, and the closest platform (Grocy) would only replace the trivial persistence layer while
fighting the domain model in ADRs 0001/0002. Build, vendor the FoodKeeper data, and treat the
projects above as design references rather than dependencies.
