# Pantry Bot

A household food + pantry inventory assistant for two users, driven by Tesco Ireland receipt photos through a Telegram group.

## Language

**Product**:
A kind of thing the household buys, identified by its normalized English name (e.g. "baked beans"). Carries what is stable across purchases: category, shelf-life estimate, staple flag.
_Avoid_: item (ambiguous with Stock Lot)

**Stock Lot**:
One purchase of a Product — a receipt line that landed in the pantry. Carries what varies per purchase: quantity, purchase date, estimated expiry, status.
_Avoid_: item, inventory row

**Raw Name**:
The abbreviated string exactly as printed on a Tesco receipt (e.g. "T.FIN B/BEANS 420G"). Once a receipt is confirmed, a Raw Name is permanently mapped to its Product; known Raw Names never get re-normalized.

**Finish-Confirmation**:
A one-tap prompt asking whether a Stock Lot is used up. The only way a lot transitions from `in_stock` to `finished` — stored state changes only on human confirmation.

**Cycle Guess**:
A derived "probably low" signal for a Product, computed from the median interval between its purchases. Computed on demand for the pre-shop summary, never stored.
_Avoid_: low status, low flag

**Catalog**:
The set of all Products the household knows about — everything ever bought, plus Staples declared directly. A Product can exist with no Stock Lots. New receipt lines are normalized against it so the same thing never forks into two Products.

**Expiry Digest**:
The section of the Pantry screen listing Stock Lots expiring within 2 days, plus just-expired lots awaiting a gone / still-good verdict. Computed fresh on every page load (#47) — no scheduled push, no persisted "already asked" state; a just-expired Lot resurfaces on every load until a human resolves it.

**Staple**:
A Product assumed to always be present (salt, oil, pepper). Recipes never count a Staple as missing.
_Avoid_: using "staple" for auto-relist products

**Auto-Relist**:
A Product flag: when its Stock Lot is finished, it goes straight onto the Shopping List without asking (e.g. milk). Independent of Staple — milk is auto-relist but not a Staple.
