import { actions } from "astro:actions";
import { useState } from "preact/hooks";

export interface AutoRelistOffer {
  productId: number;
  productName: string;
}

// Shared by every island that can trigger a Finish-Confirmation
// (InventoryChecklist, ExpiryDigest): the "always re-add this?" offer and
// its Yes/No resolution are the same flow regardless of which screen
// finished the Lot.
export function useAutoRelistOffers() {
  const [offers, setOffers] = useState<AutoRelistOffer[]>([]);

  function addOffers(newOffers: AutoRelistOffer[]) {
    if (newOffers.length === 0) {
      return;
    }
    // Merge rather than replace: a still-unanswered offer from an earlier
    // confirm shouldn't vanish just because a later confirm batch also
    // turned up offers.
    setOffers((prev) => {
      const existingIds = new Set(prev.map((o) => o.productId));
      const additions = newOffers.filter((o) => !existingIds.has(o.productId));
      return [...prev, ...additions];
    });
  }

  async function decideOffer(productId: number, wantsAutoRelist: boolean) {
    // Whichever way it resolves server-side (including a lost race — the
    // offer was already answered elsewhere), the row just closes silently;
    // there's nothing confusing left to explain, per #27.
    await actions.inventory.decideAutoRelist({ productId, wantsAutoRelist });
    setOffers((prev) => prev.filter((o) => o.productId !== productId));
  }

  return { offers, addOffers, decideOffer };
}
