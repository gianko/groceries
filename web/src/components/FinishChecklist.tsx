import { actions } from "astro:actions";
import { useState } from "preact/hooks";
import type { FinishConfirmationLot } from "../../../src/cook.js";
import type { FinishBatchResult } from "../../../src/finish.js";
import { useAutoRelistOffers } from "../lib/autoRelistOffers";
import AutoRelistPanel from "./AutoRelistPanel";

type FinishResult = FinishBatchResult["results"][number];

interface Props {
  lots: FinishConfirmationLot[];
  // Called with whatever's left after each confirm tap, so a parent that
  // gates other UI on "every Lot resolved" (e.g. RecipeModal's rating
  // prompt) doesn't have to duplicate the finish-tracking state.
  onChange?: (remaining: FinishConfirmationLot[]) => void;
}

// The batch-confirm checklist for Stock Lots too near empty to auto-decrement
// (see decrementForRecipe's FINISH_CONFIRMATION_THRESHOLD in src/cook.ts) —
// shared between the recipe detail view and the cook-agent chat pane so both
// render the identical confirm flow, per #50.
export default function FinishChecklist({ lots: initialLots, onChange }: Props) {
  const [lots, setLots] = useState(initialLots);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const { offers, addOffers, decideOffer } = useAutoRelistOffers();

  function toggle(lotId: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(lotId)) {
        next.delete(lotId);
      } else {
        next.add(lotId);
      }
      return next;
    });
  }

  async function confirmFinished() {
    const lotIds = [...checked];
    if (lotIds.length === 0) {
      return;
    }
    setConfirming(true);
    const { data, error } = await actions.inventory.finishBatch({ lotIds });
    setConfirming(false);
    if (error || !data) {
      return;
    }
    const finishedIds = new Set(
      data.results.filter((r: FinishResult) => r.finished).map((r: FinishResult) => r.lotId),
    );
    setLots((prev) => {
      const remaining = prev.filter((lot) => !finishedIds.has(lot.lotId));
      onChange?.(remaining);
      return remaining;
    });
    setChecked(new Set());
    addOffers(data.autoRelistOffers);
  }

  if (lots.length === 0 && offers.length === 0) {
    return null;
  }

  return (
    <div class="result-block">
      {lots.length > 0 && (
        <>
          <h3>Nearly out — confirm finished</h3>
          {lots.map((lot) => (
            <button type="button" class="fc-row" key={lot.lotId} onClick={() => toggle(lot.lotId)}>
              <span class="fc-check">{checked.has(lot.lotId) ? "✓" : ""}</span>
              <span>{lot.productName}</span>
            </button>
          ))}
          <div class="fc-bar">
            <span>{checked.size} selected</span>
            <button
              type="button"
              disabled={checked.size === 0 || confirming}
              onClick={confirmFinished}
            >
              {confirming ? "Confirming…" : "Confirm finished"}
            </button>
          </div>
        </>
      )}
      <AutoRelistPanel offers={offers} onDecide={decideOffer} />
    </div>
  );
}
