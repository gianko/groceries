# Split inventory into Product and Stock Lot

The original handoff suggested a single `items` table where each row mixed catalog identity (normalized name, category) with purchase state (qty, purchase date, expiry, status). We split it: **Product** holds what is stable across purchases (normalized name, category, staple/auto-relist flags, cached shelf-life), **Stock Lot** holds one purchase of a Product (qty, purchased_at, est_expiry, status).

Every downstream feature reasons about one or the other, never both: recipes and the shopping list reference Products; expiry, decrement, and finish-confirmations operate on Lots (soonest-expiry first). The single-table alternative forced `GROUP BY name` on a text column into every consumer and left "which row decrements when we cook?" undefined. It also gave the shelf-life cache and staples list a natural home as Product columns instead of separate ad-hoc storage.

## Consequences

- A Product can exist with zero Stock Lots (declared staples, missing recipe ingredients that later join the catalog).
- Cycle guesses derive from Lot purchase history per Product — no extra tables.
- Product identity must stay stable across LLM extractions; see the raw-name mapping rule in the handoff (known raw names map deterministically, only new raw names are LLM-normalized against the catalog).
