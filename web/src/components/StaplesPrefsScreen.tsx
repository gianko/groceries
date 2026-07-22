import { actions } from "astro:actions";
import { useState } from "preact/hooks";
import type { Prefs } from "../../../src/prefs.js";
import type { Staple } from "../../../src/staple.js";
import { useToast } from "../lib/toast";

interface Props {
  staples: Staple[];
  prefs: Prefs;
}

export default function StaplesPrefsScreen({ staples, prefs }: Props) {
  const [items, setItems] = useState(staples);
  const [addName, setAddName] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Household size shows as 1 on a fresh household (Prefs.householdSize
  // still null) rather than blank or disabled.
  const initialSize = prefs.householdSize ?? 1;
  const initialBlurb = prefs.blurb ?? "";
  const [savedSize, setSavedSize] = useState(initialSize);
  const [savedBlurb, setSavedBlurb] = useState(initialBlurb);
  const [size, setSize] = useState(initialSize);
  const [blurb, setBlurb] = useState(initialBlurb);
  const [saving, setSaving] = useState(false);
  const [prefsNotice, setPrefsNotice] = useState<string | null>(null);
  const { toast, show: showToast } = useToast();

  const dirty = size !== savedSize || blurb !== savedBlurb;

  async function submitAdd(e: Event) {
    e.preventDefault();
    const name = addName.trim();
    if (!name || adding) {
      return;
    }
    setAdding(true);
    const { data, error } = await actions.staple.setStaple({ name });
    setAdding(false);
    if (error || !data) {
      setNotice("Couldn't reach the server — nothing was added. Try again.");
      return;
    }
    setNotice(null);
    setItems(data.staples);
    setAddName("");
  }

  async function remove(staple: Staple) {
    setRemovingId(staple.id);
    const { data, error } = await actions.staple.unstaple({ name: staple.name });
    setRemovingId(null);
    if (error || !data) {
      setNotice("Couldn't reach the server — nothing was removed. Try again.");
      return;
    }
    setNotice(null);
    setItems(data.staples);
  }

  async function savePrefs() {
    if (!dirty || saving) {
      return;
    }
    setSaving(true);
    const { data, error } = await actions.prefs.savePrefs({ householdSize: size, blurb });
    setSaving(false);
    if (error || !data) {
      setPrefsNotice("Couldn't reach the server — nothing was saved. Try again.");
      return;
    }
    setPrefsNotice(null);
    setSavedSize(data.householdSize ?? 1);
    setSavedBlurb(data.blurb ?? "");
    showToast("Saved");
  }

  return (
    <div>
      <header class="screen-head">
        <div class="screen-eyebrow">CHEFBOTCITO</div>
        <h1>Staples &amp; prefs</h1>
      </header>

      {notice && <div class="notice">{notice}</div>}

      <section>
        <h2 class="section-head">🧂 Staples</h2>
        {items.length === 0 ? (
          <p class="empty-state">No staples declared yet</p>
        ) : (
          <ul class="lot-list">
            {items.map((staple) => (
              <li key={staple.id}>
                <div class="entry-row">
                  <span class="entry-name">{staple.name}</span>
                  <button
                    type="button"
                    class="pill-btn gone"
                    disabled={removingId === staple.id}
                    onClick={() => remove(staple)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form class="add-row" onSubmit={submitAdd}>
          <input
            type="text"
            placeholder="Add a staple…"
            value={addName}
            onInput={(e) => setAddName((e.target as HTMLInputElement).value)}
          />
          <button type="submit" disabled={adding || addName.trim().length === 0}>
            Add
          </button>
        </form>
      </section>

      <hr class="section-divider" />

      <section>
        <h2 class="section-head">🏠 Household prefs</h2>

        {prefsNotice && <div class="notice">{prefsNotice}</div>}

        <div class="prefs-card">
          <div class="prefs-field">
            <label class="prefs-label" for="household-size">
              Household size
            </label>
            <div class="stepper">
              <button
                type="button"
                class="stepper-btn"
                disabled={size <= 1}
                onClick={() => setSize((s) => Math.max(1, s - 1))}
              >
                −
              </button>
              <span class="stepper-value" id="household-size">
                {size}
              </span>
              <button type="button" class="stepper-btn" onClick={() => setSize((s) => s + 1)}>
                +
              </button>
            </div>
          </div>

          <div class="prefs-field">
            <label class="prefs-label" for="blurb">
              Cooking notes
            </label>
            <textarea
              id="blurb"
              class="prefs-textarea"
              placeholder="e.g. weeknight meals under 45 min"
              value={blurb}
              onInput={(e) => setBlurb((e.target as HTMLTextAreaElement).value)}
            />
          </div>

          <button type="button" class="save-btn" disabled={!dirty || saving} onClick={savePrefs}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </section>

      {toast && <div class="toast">{toast}</div>}
    </div>
  );
}
