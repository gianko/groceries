# LLM provider alternatives after hitting Gemini's free-tier quota

> Researched 2026-07-22 against primary sources (each provider's own docs/pricing/rate-limit
> pages). Every quota/pricing claim below is cited in **Sources**; where a provider's official
> docs would not disclose a number statically (Gemini's rate-limit page in particular renders its
> tables client-side and only states the *mechanism*, not fixed numbers), that gap is stated
> explicitly rather than filled from a secondary blog.

## Why this file exists

`src/brain/gemini.ts` (the app's only LLM integration) hit
`generativelanguage.googleapis.com/generate_content_free_tier_requests`, quotaId
`GenerateRequestsPerDayPerProjectPerModel-FreeLimit-FreeTier`, for `gemini-3.5-flash` — a live 429
confirming the free tier caps that model at **20 requests/day/project**. The household uses the
`Brain` interface for three jobs, all via `@google/genai`'s `models.generateContent`:

1. **Vision + JSON** — receipt photo (inline base64 JPEG) + prompt → schema-shaped JSON
   (`extractReceipt`/`reviseReceipt`), via `responseMimeType: "application/json"`.
2. **Text-only JSON** — free-text pantry parsing (`parseFreeTextItems`/`reviseFreeTextItems`),
   same JSON-response approach, no image.
3. **Tool-calling chat** — `converse()`, chat history + function declarations, model must call a
   function or reply with text.

Real usage is ~20-50 requests/day total across all three, with occasional bursts (several receipt
photos back to back). 20 RPD is not enough headroom for that, even before considering growth.

## Recommendation, ranked

**1. Enable pay-as-you-go billing on the existing Gemini project — do this first, it's a config
change, not a migration.** `GoogleGenAI` in `src/brain/gemini.ts` doesn't change at all; linking a
billing account to the same Google Cloud project moves it from the Free tier to **Tier 1**
automatically, per
[ai.google.dev/gemini-api/docs/rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits):
"Set up and link an active billing account" is the sole qualification for Tier 1, with "immediate
upgrade processing" and a stated $250/month spend cap before Tier 2 eligibility kicks in. At
~30 req/day of small JSON + occasional receipt images, monthly spend will be low single-digit
dollars (estimate below) — nowhere near that cap. This is zero code risk and reuses every prompt,
schema, and retry/backoff path already written. Only downside: it requires a card on the Google
Cloud project, which the household may be trying to avoid — if so, go to option 2.

**2. If avoiding billing entirely: Groq, free tier.** Groq's free plan is generous enough to
replace Gemini outright for a household workload, and — this matters for `gemini.ts` — Groq
publishes an **OpenAI-compatible** chat-completions API, which is a far smaller adapter change
than porting to a fully different SDK shape (Anthropic's Messages API, Mistral's client, etc.).
Groq's `qwen/qwen3.6-27b` model supports vision, JSON mode, and tool/function calling together
(confirmed on Groq's own vision docs), at a free-tier limit of 30 RPM / 1,000 RPD / 8K TPM / 200K
TPD (Groq's own rate-limits page) — 1,000 RPD covers the household's 20-50/day with enormous
headroom, including bursts. Migration effort is moderate: new client init, request/response shape
differs from `@google/genai`'s `GoogleGenAI.models.generateContent`, and prompts/schemas carry
over unchanged since they're plain text + JSON-schema instructions.

**3. OpenRouter free models — good fallback/second provider, not a first migration target.**
OpenRouter fronts many providers' free (`:free`-suffixed) models behind one OpenAI-compatible API,
rate-limited at the OpenRouter layer (not per-model) to 20 requests/minute and either 50 or 1,000
requests/day depending on whether the account has ever purchased $10+ of credits (OpenRouter's own
docs). At least one currently free model, `google/gemma-4-31b-it:free`, advertises both image
input and native function calling per OpenRouter's free-models collection page — a plausible
single-model fit for all three of this app's job types. Worth having configured as a backup behind
Groq (free-model lineup on OpenRouter is known to churn, per OpenRouter's own collection page
caveat and third-party trackers), but not the primary pick given Groq's higher, per-model-scoped
free quota.

**4. Local Ollama on the household Pi — not realistic, skip.** ADR 0003 gives no Pi model, RAM, or
CPU spec — it only says "the household Raspberry Pi (OpenMediaVault, existing Docker setup)" and
explicitly frames the Pi as *not* needing OCR/LLM compute: "Receipt parsing stays an outbound API
call; the Pi never needs the compute for OCR." Even setting that framing aside, the smallest usable
vision model on Ollama's own library page for LLaVA is the 7B variant at 4.7GB on disk (Ollama's
own model page), which needs several GB of free RAM beyond the model file to run at all —
tight-to-infeasible alongside Docker, OMV's own services, and the rest of the compose stack on a Pi
with unconfirmed (likely 4-8GB) RAM, and CPU-only inference on Pi-class ARM hardware would be slow
enough (multi-second-to-tens-of-seconds per image) to risk the existing `REQUEST_TIMEOUT_MS =
30_000` in `gemini.ts`. This contradicts the ADR's own reasoning for keeping the Pi outbound-only.
Not pursued further.

**Ruled out**: OpenAI (no free API tier at all, confirmed below), Anthropic (no standing free
tier, small one-time credit only), Cohere (trial key capped at 1,000 calls/month — under 30
days' worth of usage at 30/day), Mistral (no free tier found on current official pricing page).
None of these are worse than Gemini's paid tier on cost, so none beat option 1 or 2.

## Comparison table

| Provider / model | Free quota (official) | Paid pricing (per 1M tok, in/out) | Vision | JSON mode | Function calling | Migration effort from current code |
|---|---|---|---|---|---|---|
| **Gemini `gemini-3.5-flash`** (current) | 20 RPD/project (live 429, quotaId `GenerateRequestsPerDayPerProjectPerModel-FreeTier`) | $1.50 / $9.00 | Yes | Yes | Yes | None — already integrated |
| **Gemini `gemini-2.5-flash`** (paid, cheaper sibling) | n/a once billed | $0.30 / $2.50 | Yes | Yes | Yes | Trivial — change `DEFAULT_MODEL` string only |
| **Gemini `gemini-2.5-flash-lite`** | n/a once billed | $0.10 / $0.40 | Yes | Yes | Yes | Trivial — change `DEFAULT_MODEL` string only |
| **Groq `qwen/qwen3.6-27b`** | 30 RPM / 1,000 RPD / 8K TPM / 200K TPD | $0.60 / $3.00 | Yes | Yes | Yes | Moderate — new SDK (OpenAI-compatible), adapt request/response shape, prompts reusable |
| **Groq `llama-3.1-8b-instant`** (text-only jobs) | 30 RPM / 14.4K RPD / 6K TPM / 500K TPD | $0.05 / $0.08 | No | Yes | Yes (per Groq tool-use docs) | Same as above; usable only for the two non-vision jobs |
| **OpenRouter `google/gemma-4-31b-it:free`** | 20 RPM; 50 RPD (no purchase history) or 1,000 RPD ($10+ purchased) — account-wide, not per-model | Paid fallback available on OpenRouter if the `:free` slug disappears | Yes (image input, per OpenRouter listing) | Via provider passthrough (not independently confirmed) | Yes ("native function calling", per OpenRouter listing) | Moderate — OpenAI-compatible API, same adapter work as Groq |
| **Mistral Small** | No free tier found on current official pricing page | $0.15 / $0.60 | Not confirmed (Pixtral is Mistral's vision line; pricing not found on the fetched page) | Yes (Mistral's API supports JSON mode generally) | Yes (Mistral's API supports tool calling generally) | Moderate — new SDK |
| **OpenAI `gpt-5.4-mini`** | None — no free API quota found on official pricing docs | $0.75 / $4.50 | Yes | Yes | Yes | Moderate — new SDK |
| **OpenAI `gpt-5.4-nano`** | None | $0.20 / $1.25 | Yes | Yes | Yes | Moderate — new SDK |
| **Anthropic Claude Haiku 4.5** | No standing free tier; "new users receive a small amount of free credits to test the API" (one-time, amount unspecified in docs) | $1.00 / $5.00 | Yes | Yes (tool-use-based structured output) | Yes | Moderate — new SDK, structured JSON via tool-forcing rather than a `responseMimeType` flag |
| **Cohere (trial key)** | 20 req/min, capped at 1,000 calls/month total | Not fetched (trial-focused pricing page) | Not confirmed | Not confirmed | Not confirmed | Not pursued — quota too small |
| **Local Ollama vision model on the Pi** | N/A (self-hosted) | Free but hardware-constrained | Smallest usable (LLaVA 7B) is 4.7GB on disk per Ollama's own library page | Model-dependent, unreliable | Model-dependent, unreliable | High — new inference stack, contradicts ADR 0003's outbound-only Pi design; **not realistic** |

## Rough cost estimate at ~30 req/day average

Assumptions (stated explicitly, no primary source claims a "typical receipt" token count — this is
an estimate): a receipt photo ~1,500-2,000 image tokens (Gemini/most providers bill inline images
as a few hundred to ~2K tokens depending on resolution) + ~400 tokens of prompt text; free-text/chat
jobs ~200-500 tokens in, ~150-400 tokens out; all JSON responses short (under ~500 tokens). Call it
~2,500 tokens in / ~400 tokens out per request, 30 requests/day, 30 days/month = **2.25M input
tokens/month, 0.36M output tokens/month**.

| Provider/model | Input cost | Output cost | Total/month |
|---|---|---|---|
| Gemini `gemini-2.5-flash-lite` | 2.25 × $0.10 = $0.225 | 0.36 × $0.40 = $0.144 | **~$0.37** |
| Gemini `gemini-2.5-flash` | 2.25 × $0.30 = $0.675 | 0.36 × $2.50 = $0.90 | **~$1.58** |
| Gemini `gemini-3.5-flash` (current, paid) | 2.25 × $1.50 = $3.375 | 0.36 × $9.00 = $3.24 | **~$6.62** |
| Groq `qwen/qwen3.6-27b` | 2.25 × $0.60 = $1.35 | 0.36 × $3.00 = $1.08 | **~$2.43** |
| Mistral Small | 2.25 × $0.15 = $0.34 | 0.36 × $0.60 = $0.22 | **~$0.56** |
| OpenAI `gpt-5.4-nano` | 2.25 × $0.20 = $0.45 | 0.36 × $1.25 = $0.45 | **~$0.90** |
| Claude Haiku 4.5 | 2.25 × $1.00 = $2.25 | 0.36 × $5.00 = $1.80 | **~$4.05** |

At this volume every paid option is under $7/month, and the cheapest Gemini paid tier
(`flash-lite`) is under $0.50/month — cheaper than switching providers, before counting the zero
migration effort. **This is the strongest argument for option 1**: even fully abandoning the free
tier, staying on Gemini and paying is the cheapest path in absolute dollars, not just effort.

## Sources

- Gemini rate limits (mechanism, Tier 1 qualification, $250/month Tier 1 cap; does not publish a
  static free-tier numeric table — client-rendered, refers users to AI Studio's per-account
  dashboard): <https://ai.google.dev/gemini-api/docs/rate-limits>
- Gemini pricing (`gemini-2.5-flash` $0.30/$2.50, `gemini-2.5-flash-lite` $0.10/$0.40,
  `gemini-3.5-flash` $1.50/$9.00, all per 1M tokens): <https://ai.google.dev/gemini-api/docs/pricing>
- Live 429 error from the app itself confirming the free-tier quota:
  `generativelanguage.googleapis.com/generate_content_free_tier_requests`, quotaId
  `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, limit 20/day/model — observed directly, not
  a doc citation.
- Groq free-tier rate limits (`llama-3.1-8b-instant` 30 RPM/14.4K RPD/6K TPM/500K TPD,
  `llama-3.3-70b-versatile` 30 RPM/1K RPD/12K TPM/100K TPD, `qwen/qwen3.6-27b` 30 RPM/1K RPD/8K
  TPM/200K TPD): <https://console.groq.com/docs/rate-limits>
- Groq vision docs (`qwen/qwen3.6-27b` supports image input up to 20MB/5 images, JSON mode, and
  tool calling together): <https://console.groq.com/docs/vision>
- Groq pricing (`qwen/qwen3.6-27b` $0.60/$3.00, `llama-3.1-8b-instant` $0.05/$0.08, `gpt-oss-20b`
  $0.075/$0.30, all per 1M tokens): <https://groq.com/pricing>
- Groq models/capabilities overview (Structured Outputs, Tool Use as platform-wide features):
  <https://console.groq.com/docs/models>
- OpenRouter free-model rate limits (20 RPM; 50 RPD under $10 lifetime purchases, 1,000 RPD at
  $10+; account balance must be non-negative):
  <https://openrouter.ai/docs/api-reference/limits>
- OpenRouter free-models collection, including `google/gemma-4-31b-it:free` (image input + native
  function calling) and `openai/gpt-oss-20b:free` (function calling/tool use/structured outputs):
  <https://openrouter.ai/collections/free-models>
- Mistral pricing (Mistral Small $0.15/$0.60 per 1M tokens; no free tier or credits mentioned on
  this page): <https://mistral.ai/pricing>
- OpenAI pricing (`gpt-5.4-nano` $0.20/$1.25, `gpt-5.4-mini` $0.75/$4.50 per 1M tokens; no free API
  quota mentioned): <https://developers.openai.com/api/docs/pricing>
- Anthropic Claude API pricing (Claude Haiku 4.5 $1.00/$5.00 per 1M tokens; "New users receive a
  small amount of free credits to test the API," no ongoing free tier):
  <https://platform.claude.com/docs/en/about-claude/pricing>
- Cohere trial-key rate limits (Chat API 20 req/min; 1,000 calls/month cap on newer chat models):
  <https://docs.cohere.com/docs/rate-limits>
- Ollama LLaVA model sizes (7B/4.7GB, 13B/8.0GB, 34B/20GB on-disk): <https://ollama.com/library/llava>
- ADR establishing the Pi as outbound-only with no stated hardware spec, and explicitly excluding
  local OCR/LLM compute: `/Users/gian/projects/groceries/docs/adr/0003-deploy-on-household-pi.md`
- Current Gemini integration read directly from source:
  `/Users/gian/projects/groceries/src/brain/gemini.ts`

### Gaps — could not confirm from primary sources

- Gemini's exact free-tier and Tier 1 numeric RPM/TPM/RPD tables are not present as static text on
  `ai.google.dev/gemini-api/docs/rate-limits` — the page states the tables live in each user's own
  AI Studio dashboard (`aistudio.google.com/rate-limit`), which requires an authenticated session
  this research did not have. The 20 RPD figure used throughout this doc for `gemini-3.5-flash`
  comes from the app's own live 429, not a published table.
- Mistral's free ("Experiment") tier details (rate limits, whether it requires a card) could not
  be confirmed — the doc pages found via search (`docs.mistral.ai/deployment/laplateforme/tier`,
  `.../overview`) 404'd when fetched directly, and the current `mistral.ai/pricing` page makes no
  mention of a free/no-cost API tier at all. Treat Mistral's free tier as unconfirmed/possibly
  discontinued rather than assume it still exists as described in older secondary sources.
- Whether Mistral's or OpenRouter's free-tier JSON mode/tool calling work reliably in combination
  with vision input specifically (as opposed to each feature existing independently) was not
  verified against a primary source for those two providers, unlike Groq where the vision docs
  page explicitly confirms the combination.
