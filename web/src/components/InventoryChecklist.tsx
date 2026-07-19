import { actions } from "astro:actions";
import { useState } from "preact/hooks";
import type { FinishBatchResult } from "../../../src/finish.js";
import type { InventoryLot } from "../../../src/inventory.js";

type FinishResult = FinishBatchResult["results"][number];

interface Props {
  food: InventoryLot[];
  household: InventoryLot[];
}

interface AutoRelistOffer {
  productId: number;
  productName: string;
}

export default function InventoryChecklist({ food, household }: Props) {
  const [items, setItems] = useState({ food, household });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [offers, setOffers] = useState<AutoRelistOffer[]>([]);

  function toggle(lotId: number) {
    setSelected((prev) => {
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
    const lotIds = [...selected];
    if (lotIds.length === 0) {
      return;
    }
    setConfirming(true);
    const { data, error } = await actions.inventory.finishBatch({ lotIds });
    setConfirming(false);
    if (error || !data) {
      setNotice("Couldn't reach the server — nothing was confirmed. Try again.");
      return;
    }

    const finishedIds = new Set(
      data.results.filter((r: FinishResult) => r.finished).map((r: FinishResult) => r.lotId),
    );
    const failed = data.results.filter((r: FinishResult) => !r.finished);

    setItems((prev) => ({
      food: prev.food.filter((lot) => !finishedIds.has(lot.lotId)),
      household: prev.household.filter((lot) => !finishedIds.has(lot.lotId)),
    }));
    setSelected(new Set());

    if (failed.length > 0) {
      const names = failed.map((f: FinishResult) => f.productName).join(", ");
      const verb = failed.length > 1 ? "were" : "was";
      setNotice(
        `${finishedIds.size} of ${data.results.length} finished — ${names} ${verb} already finished elsewhere`,
      );
    } else {
      setNotice(null);
    }

    if (data.autoRelistOffers.length > 0) {
      // Merge rather than replace: a still-unanswered offer from an earlier
      // confirm shouldn't vanish just because a later confirm batch also
      // turned up offers.
      setOffers((prev) => {
        const existingIds = new Set(prev.map((o) => o.productId));
        const additions = data.autoRelistOffers.filter(
          (o: AutoRelistOffer) => !existingIds.has(o.productId),
        );
        return [...prev, ...additions];
      });
    }
  }

  async function decideOffer(productId: number, wantsAutoRelist: boolean) {
    // Whichever way it resolves server-side (including a lost race — the
    // offer was already answered elsewhere), the row just closes silently;
    // there's nothing confusing left to explain, per #27.
    await actions.inventory.decideAutoRelist({ productId, wantsAutoRelist });
    setOffers((prev) => prev.filter((o) => o.productId !== productId));
  }

  return (
    <div>
      <header class="screen-head">
        <h1>Pantry</h1>
      </header>

      {notice && <div class="notice">{notice}</div>}

      {offers.length > 0 && (
        <div class="auto-relist-panel">
          <p class="auto-relist-title">Always re-add these when they run out?</p>
          {offers.map((offer) => (
            <div class="auto-relist-row" key={offer.productId}>
              <span>{offer.productName}</span>
              <div class="auto-relist-actions">
                <button type="button" onClick={() => decideOffer(offer.productId, true)}>
                  Yes
                </button>
                <button type="button" onClick={() => decideOffer(offer.productId, false)}>
                  No
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {items.food.length > 0 && (
        <Section title="🍎 FOOD" lots={items.food} selected={selected} onToggle={toggle} />
      )}
      {items.household.length > 0 && (
        <Section
          title="🧽 HOUSEHOLD"
          lots={items.household}
          selected={selected}
          onToggle={toggle}
        />
      )}

      {selected.size > 0 && (
        <div class="confirm-bar">
          <button type="button" disabled={confirming} onClick={confirmFinished}>
            {confirming ? "Confirming…" : `Confirm finished (${selected.size})`}
          </button>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  lots,
  selected,
  onToggle,
}: {
  title: string;
  lots: InventoryLot[];
  selected: Set<number>;
  onToggle: (lotId: number) => void;
}) {
  return (
    <section>
      <h2 class="section-head">{title}</h2>
      <ul class="lot-list">
        {lots.map((lot) => (
          <li key={lot.lotId}>
            <label class="lot-row">
              <input
                type="checkbox"
                checked={selected.has(lot.lotId)}
                onChange={() => onToggle(lot.lotId)}
              />
              <span class="lot-name">{lot.productName}</span>
              <span class="lot-meta">
                {lot.unit ? `${lot.quantity} ${lot.unit}` : lot.quantity}
                {lot.estExpiry ? ` · exp ${lot.estExpiry}` : ""}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
