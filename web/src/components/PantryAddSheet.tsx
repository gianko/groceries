import { actions } from "astro:actions";
import { useState } from "preact/hooks";
import type { InventoryLot } from "../../../src/inventory.js";

interface Props {
  onClose: () => void;
  onAdded: (lots: InventoryLot[]) => void;
  onToast: (message: string) => void;
}

// Free-text bootstrap/receipt-less entry (restored #17 flow): the Brain
// parses whatever the household typed into Products + Stock Lots, same as a
// receipt line minus the price/Raw Name. Closes immediately on submit —
// the parse+persist round-trip happens in the background, surfaced only via
// toasts, so a slow Brain call never blocks the sheet.
export default function PantryAddSheet({ onClose, onAdded, onToast }: Props) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || submitting) {
      return;
    }
    setSubmitting(true);
    onClose();
    onToast("Sent to the Brain — adding to pantry…");
    const { data, error } = await actions.pantry.addFreeText({ text: trimmed });
    if (error || !data || !data.available) {
      onToast("Couldn't reach the Brain — nothing was added. Try again.");
      return;
    }
    if (data.lots.length === 0) {
      onToast("Didn't catch any items in that — try again.");
      return;
    }
    onAdded(data.lots);
    onToast("Added to pantry");
  }

  return (
    <div class="sheet-scrim">
      <button type="button" class="sheet-backdrop" onClick={onClose} aria-label="Close" />
      <div class="sheet">
        <div class="sheet-title-block">
          <div class="sheet-title">Add to pantry</div>
          <div class="sheet-subtitle">
            Tell the Brain what you picked up — it'll sort out product, quantity and shelf life.
          </div>
          <textarea
            class="sheet-textarea"
            value={text}
            placeholder="e.g. 2 bags of spinach, a dozen eggs, paper towels"
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          />
        </div>
        <div class="sheet-actions">
          <button type="button" class="primary-btn" disabled={!text.trim()} onClick={submit}>
            Add
          </button>
          <button type="button" class="ghost-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
