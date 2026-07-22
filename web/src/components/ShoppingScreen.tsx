import { actions } from "astro:actions";
import { useState } from "preact/hooks";
import type { ShoppingListEntry, ShoppingListSource } from "../../../src/list.js";
import type { CycleGuess, ExpiringLot } from "../../../src/shopping.js";

interface Props {
  entries: ShoppingListEntry[];
  expiringLots: ExpiringLot[];
  cycleGuesses: CycleGuess[];
}

const SOURCE_LABEL: Partial<Record<ShoppingListSource, string>> = {
  finished: "auto-relist",
  staple: "staple",
  recipe_missing: "recipe",
  cycle_guess: "probably low",
};

export function entryLabel(entry: ShoppingListEntry): string {
  return entry.productName ?? entry.freeText ?? "";
}

// Matches fetchOpenEntries' own ORDER BY exactly, so a locally-inserted
// entry (manual add, Cycle Guess accept) lands where a full reload would
// have put it.
function insertSorted(list: ShoppingListEntry[], entry: ShoppingListEntry): ShoppingListEntry[] {
  const next = [...list, entry];
  next.sort((a, b) =>
    entryLabel(a).localeCompare(entryLabel(b), undefined, { sensitivity: "base" }),
  );
  return next;
}

// Matches computeCycleGuesses' own sort, for the same reason as insertSorted.
function insertSortedGuess(list: CycleGuess[], guess: CycleGuess): CycleGuess[] {
  const next = [...list, guess];
  next.sort((a, b) =>
    a.productName.localeCompare(b.productName, undefined, { sensitivity: "base" }),
  );
  return next;
}

export default function ShoppingScreen({ entries, expiringLots, cycleGuesses }: Props) {
  const [items, setItems] = useState(entries);
  const [expiring, setExpiring] = useState(expiringLots);
  const [guesses, setGuesses] = useState(cycleGuesses);
  const [doneThisSession, setDoneThisSession] = useState<ShoppingListEntry[]>([]);
  const [addText, setAddText] = useState("");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function submitAdd(e: Event) {
    e.preventDefault();
    const text = addText.trim();
    if (!text || adding) {
      return;
    }
    setAdding(true);
    const { data, error } = await actions.shopping.addManual({ text });
    setAdding(false);
    if (error || !data) {
      setNotice("Couldn't reach the server — nothing was added. Try again.");
      return;
    }
    setNotice(null);
    setItems((prev) => insertSorted(prev, data));
    setAddText("");
  }

  async function checkOff(entry: ShoppingListEntry) {
    setItems((prev) => prev.filter((e) => e.id !== entry.id));
    const { data, error } = await actions.shopping.checkOff({ entryId: entry.id });
    if (error || !data) {
      // A genuine failure (not a lost race — that comes back as
      // `checked: false`, a legitimate result) means nothing was persisted,
      // so the optimistic removal needs undoing.
      setItems((prev) => insertSorted(prev, entry));
      setNotice("Couldn't reach the server — nothing was checked off. Try again.");
      return;
    }
    setNotice(null);
    if (data.checked) {
      setDoneThisSession((prev) => [entry, ...prev]);
    }
  }

  async function acceptGuess(guess: CycleGuess) {
    setGuesses((prev) => prev.filter((g) => g.productId !== guess.productId));
    const { data, error } = await actions.shopping.acceptCycleGuess(guess);
    if (error || !data) {
      setGuesses((prev) => insertSortedGuess(prev, guess));
      setNotice("Couldn't reach the server — nothing was added. Try again.");
      return;
    }
    setNotice(null);
    setItems((prev) => insertSorted(prev, data));
  }

  function dismissGuess(productId: number) {
    setGuesses((prev) => prev.filter((g) => g.productId !== productId));
  }

  function dismissLot(lotId: number) {
    setExpiring((prev) => prev.filter((l) => l.lotId !== lotId));
  }

  return (
    <div>
      <header class="screen-head">
        <div class="screen-eyebrow">CHEFBOTCITO</div>
        <h1>Shopping list</h1>
      </header>

      {notice && <div class="notice">{notice}</div>}

      {expiring.length > 0 && (
        <section>
          <h2 class="section-head">⏳ Use soon / don't rebuy</h2>
          <ul class="signal-list">
            {expiring.map((lot) => (
              <li class="signal-card expiring" key={lot.lotId}>
                <div class="signal-body">
                  <span class="signal-title">{lot.productName}</span>
                  <span class="signal-meta">
                    {lot.unit ? `${lot.quantity} ${lot.unit}` : lot.quantity} · exp {lot.estExpiry}
                  </span>
                </div>
                <button
                  type="button"
                  class="pill-btn dismiss"
                  onClick={() => dismissLot(lot.lotId)}
                >
                  Got it
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 class="section-head">🛒 List</h2>
        {items.length === 0 ? (
          <p class="empty-state">Nothing on the list</p>
        ) : (
          <ul class="lot-list">
            {items.map((entry) => (
              <li key={entry.id}>
                <button type="button" class="entry-row" onClick={() => checkOff(entry)}>
                  <span class="entry-check" aria-hidden="true" />
                  <span class="entry-name">{entryLabel(entry)}</span>
                  {SOURCE_LABEL[entry.source] && (
                    <span class="tag">{SOURCE_LABEL[entry.source]}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        <form class="add-row" onSubmit={submitAdd}>
          <input
            type="text"
            placeholder="Add something…"
            value={addText}
            onInput={(e) => setAddText((e.target as HTMLInputElement).value)}
          />
          <button type="submit" disabled={adding || addText.trim().length === 0}>
            Add
          </button>
        </form>
      </section>

      {guesses.length > 0 && (
        <section>
          <h2 class="section-head">🔮 Probably low</h2>
          <ul class="signal-list">
            {guesses.map((guess) => (
              <li class="signal-card guess" key={guess.productId}>
                <div class="signal-body">
                  <span class="signal-title">{guess.productName}</span>
                  <span class="signal-meta">Based on your usual buying cadence</span>
                </div>
                <div class="signal-actions">
                  <button
                    type="button"
                    class="pill-btn dismiss"
                    onClick={() => dismissGuess(guess.productId)}
                  >
                    Skip
                  </button>
                  <button type="button" class="pill-btn accept" onClick={() => acceptGuess(guess)}>
                    Add
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {doneThisSession.length > 0 && (
        <details class="checked-off">
          <summary>Checked off ({doneThisSession.length})</summary>
          <ul class="lot-list">
            {doneThisSession.map((entry) => (
              <li key={entry.id}>
                <span class="entry-row done">
                  <span class="entry-check done" aria-hidden="true">
                    ✓
                  </span>
                  <span class="entry-name done">{entryLabel(entry)}</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
