import { actions } from "astro:actions";
import { useMemo, useState } from "preact/hooks";
import type { FinishBatchResult } from "../../../src/finish.js";
import { filterLots, type InventoryLot } from "../../../src/inventory.js";
import { useAutoRelistOffers } from "../lib/autoRelistOffers";
import { useToast } from "../lib/toast";
import AutoRelistPanel from "./AutoRelistPanel";
import PantryAddSheet from "./PantryAddSheet";

type FinishResult = FinishBatchResult["results"][number];

interface Props {
  food: InventoryLot[];
  household: InventoryLot[];
}

export default function InventoryChecklist({ food, household }: Props) {
  const [items, setItems] = useState({ food, household });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { offers, addOffers, decideOffer } = useAutoRelistOffers();
  const { toast, show: showToast } = useToast();

  const visibleFood = useMemo(() => filterLots(items.food, query), [items.food, query]);
  const visibleHousehold = useMemo(
    () => filterLots(items.household, query),
    [items.household, query],
  );
  const noMatches =
    query.trim() !== "" && visibleFood.length === 0 && visibleHousehold.length === 0;

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

    if (finishedIds.size > 0) {
      showToast("Marked finished");
    }
    if (failed.length > 0) {
      const names = failed.map((f: FinishResult) => f.productName).join(", ");
      const verb = failed.length > 1 ? "were" : "was";
      const actors = new Set(failed.map((f: FinishResult) => f.finishedBy).filter(Boolean));
      const by = actors.size === 1 ? [...actors][0] : "someone else";
      setNotice(
        `${finishedIds.size} of ${data.results.length} finished — ${names} ${verb} already finished by ${by}`,
      );
    } else {
      setNotice(null);
    }

    addOffers(data.autoRelistOffers);
  }

  return (
    <div>
      {notice && <div class="notice">{notice}</div>}

      <AutoRelistPanel offers={offers} onDecide={decideOffer} />

      <div class="search-row">
        <input
          type="search"
          placeholder="Search pantry…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          aria-label="Search pantry"
        />
      </div>

      {noMatches && <p class="empty-state">No matches for "{query.trim()}".</p>}

      {visibleFood.length > 0 && (
        <Section title="🥫 Food" lots={visibleFood} selected={selected} onToggle={toggle} />
      )}
      {visibleHousehold.length > 0 && (
        <Section
          title="🧻 Household"
          lots={visibleHousehold}
          selected={selected}
          onToggle={toggle}
        />
      )}

      <button
        type="button"
        class="fab fab-add"
        onClick={() => setAddOpen(true)}
        aria-label="Add to pantry"
      >
        +
      </button>

      {selected.size > 0 && (
        <div class="confirm-bar">
          <button type="button" disabled={confirming} onClick={confirmFinished}>
            {confirming ? "Confirming…" : `Confirm finished (${selected.size})`}
          </button>
        </div>
      )}

      {addOpen && (
        <PantryAddSheet
          onClose={() => setAddOpen(false)}
          onToast={showToast}
          onAdded={(lots) => {
            setItems((prev) => ({
              food: [...lots.filter((l) => l.category === "food"), ...prev.food],
              household: [...lots.filter((l) => l.category === "household"), ...prev.household],
            }));
          }}
        />
      )}

      {toast && <div class="toast">{toast}</div>}
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
        {lots.map((lot) => {
          const checked = selected.has(lot.lotId);
          return (
            <li key={lot.lotId}>
              <button type="button" class="lot-row" onClick={() => onToggle(lot.lotId)}>
                <span class={`check-circle ${checked ? "checked" : ""}`} aria-hidden="true">
                  {checked ? "✓" : ""}
                </span>
                <span class="lot-body">
                  <span class="lot-name">{lot.productName}</span>
                  {lot.estExpiry && <span class="lot-expiry">exp {lot.estExpiry}</span>}
                </span>
                <span class="lot-meta">
                  {lot.unit ? `${lot.quantity} ${lot.unit}` : lot.quantity}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
