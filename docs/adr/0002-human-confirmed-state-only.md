# Stored state changes only on human confirmation

Inventory is approximate by design, so the system constantly *derives* uncertain signals (estimated expiry, decremented quantities, cycle-based "probably low" guesses). We decided none of these ever mutate stored state on their own: a Stock Lot's status is binary (`in_stock` | `finished`) and only a human tap — finish-confirmation, "gone" verdict on an expired lot, manual action — transitions it. There is deliberately no auto-finish on expiry, no stored "low" flag, no cron job flipping statuses.

The trade-off: derived numbers are allowed to be sloppy (they degrade into asking the human via one-tap buttons), but stored state is always something a person asserted. The rejected alternative — letting heuristics write state — silently accumulates wrong rows that nobody trusts, which is how household inventory systems get abandoned. A future reader seeing "expired items stay in_stock" should read this as the feature, not a missing one: shelf-life estimates are conservative, and food that outlives its estimate is usually still fine.

## Consequences

- "Low" and "expired" are query-time derivations, never columns to keep consistent.
- Ignored prompts degrade gracefully: an unanswered expiry verdict leaves the lot in stock but excludes it from recipe trust.
- Every flow ends in a one-tap inline keyboard; confirmation friction is the system's accuracy budget, so it must stay at exactly one tap.
