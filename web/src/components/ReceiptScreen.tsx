import { actions } from "astro:actions";
import { useRef, useState } from "preact/hooks";
import type { ReceiptExtraction, ReceiptLine } from "../../../src/brain.js";
import type { ShoppingListEntry } from "../../../src/list.js";
import { entryLabel } from "./ShoppingScreen";

type Status =
  | { step: "picking" }
  | { step: "parsing" }
  | { step: "parse-error" }
  | { step: "editing"; lines: ReceiptLine[] }
  | { step: "confirming"; lines: ReceiptLine[] }
  | { step: "confirm-error"; lines: ReceiptLine[] }
  | { step: "success"; leftover: ShoppingListEntry[] };

export default function ReceiptScreen() {
  const [status, setStatus] = useState<Status>({ step: "picking" });
  const photoRef = useRef<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function parse(photo: File) {
    setStatus({ step: "parsing" });
    const formData = new FormData();
    formData.append("photo", photo);
    const { data, error } = await actions.receipt.parse(formData);
    if (error || !data || !data.available) {
      setStatus({ step: "parse-error" });
      return;
    }
    setStatus({ step: "editing", lines: data.extraction.lines });
  }

  function onFileChange(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) {
      return;
    }
    photoRef.current = file;
    parse(file);
  }

  function retryParse() {
    if (photoRef.current) {
      parse(photoRef.current);
    }
  }

  function discard() {
    photoRef.current = null;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setStatus({ step: "picking" });
  }

  function updateLine(index: number, patch: Partial<ReceiptLine>) {
    if (status.step !== "editing") {
      return;
    }
    const lines = status.lines.map((line, i) => (i === index ? { ...line, ...patch } : line));
    setStatus({ step: "editing", lines });
  }

  async function confirm(lines: ReceiptLine[]) {
    setStatus({ step: "confirming", lines });
    const extraction: ReceiptExtraction = { lines };
    const { data, error } = await actions.receipt.confirm({ extraction });
    if (error || !data || !data.available) {
      setStatus({ step: "confirm-error", lines });
      return;
    }
    setStatus({ step: "success", leftover: data.leftoverFreeText });
  }

  if (status.step === "picking" || status.step === "parsing" || status.step === "parse-error") {
    return (
      <div>
        <header class="screen-head">
          <h1>Receipt</h1>
        </header>
        <div class="receipt-upload">
          <label class="primary-btn receipt-pick-btn">
            {status.step === "parsing" ? "Parsing…" : "Upload receipt photo"}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              class="receipt-file-input"
              disabled={status.step === "parsing"}
              onChange={onFileChange}
            />
          </label>
          {status.step === "parse-error" && (
            <div class="notice">
              Couldn't parse that receipt.
              <button type="button" class="ghost-btn" onClick={retryParse}>
                Retry
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (status.step === "success") {
    return (
      <div>
        <header class="screen-head">
          <h1>Receipt</h1>
        </header>
        <p class="empty-state">Saved — your shopping list is up to date.</p>
        {status.leftover.length > 0 && <ReconcilePrompt entries={status.leftover} />}
      </div>
    );
  }

  const { lines } = status;
  const confirming = status.step === "confirming";

  return (
    <div>
      <header class="screen-head">
        <h1>Receipt</h1>
      </header>

      {status.step === "confirm-error" && (
        <div class="notice">
          Couldn't save that receipt.
          <button type="button" class="ghost-btn" onClick={() => confirm(lines)}>
            Retry
          </button>
        </div>
      )}

      <ul class="receipt-line-list">
        {lines.map((line, i) => (
          <li key={i} class="receipt-line-row">
            <input
              type="text"
              class="receipt-line-name"
              value={line.name}
              onInput={(e) => updateLine(i, { name: (e.target as HTMLInputElement).value })}
            />
            <input
              type="number"
              class="receipt-line-qty"
              value={line.quantity}
              min="0"
              step="any"
              onInput={(e) =>
                updateLine(i, { quantity: Number((e.target as HTMLInputElement).value) })
              }
            />
            <input
              type="text"
              class="receipt-line-unit"
              placeholder="unit"
              value={line.unit ?? ""}
              onInput={(e) => updateLine(i, { unit: (e.target as HTMLInputElement).value || null })}
            />
            <input
              type="number"
              class="receipt-line-price"
              placeholder="price"
              value={line.price ?? ""}
              min="0"
              step="any"
              onInput={(e) => {
                const raw = (e.target as HTMLInputElement).value;
                updateLine(i, { price: raw === "" ? null : Number(raw) });
              }}
            />
          </li>
        ))}
      </ul>

      <div class="confirm-bar">
        <button type="button" disabled={confirming} onClick={() => confirm(lines)}>
          {confirming ? "Saving…" : "Confirm"}
        </button>
      </div>
      <button type="button" class="ghost-btn receipt-discard-btn" onClick={discard}>
        Discard
      </button>
    </div>
  );
}

function ReconcilePrompt({ entries: initial }: { entries: ShoppingListEntry[] }) {
  const [entries, setEntries] = useState(initial);

  function keep(id: number) {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  async function clear(id: number) {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    await actions.shopping.checkOff({ entryId: id });
  }

  if (entries.length === 0) {
    return null;
  }

  return (
    <section>
      <h2 class="section-head">🧾 Still need these?</h2>
      <ul class="signal-list">
        {entries.map((entry) => (
          <li class="signal-card guess" key={entry.id}>
            <div class="signal-body">
              <span class="signal-title">{entryLabel(entry)}</span>
            </div>
            <div class="signal-actions">
              <button type="button" class="pill-btn dismiss" onClick={() => keep(entry.id)}>
                Keep
              </button>
              <button type="button" class="pill-btn accept" onClick={() => clear(entry.id)}>
                Clear
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
