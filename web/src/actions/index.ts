import { defineAction } from "astro:actions";
import { z } from "zod";
import { systemClock } from "../../../src/clock.js";
import { decideAutoRelist as decideAutoRelistDb, finishBatch } from "../../../src/finish.js";
import { addManualEntry, fetchOpenEntries, type ShoppingListEntry } from "../../../src/list.js";
import { clearEntry } from "../../../src/reconcile.js";
import { addCycleGuessEntry } from "../../../src/shopping.js";
import { sendGroupEcho } from "../lib/echo.js";
import { getDb } from "../lib/webDb.js";

function entryLabel(entry: ShoppingListEntry): string {
  return entry.productName ?? entry.freeText ?? "";
}

// The three shopping echoes per #28/#30 share this "label by actor" shape;
// only the verb/suffix/emoji differ.
function echoEntry(label: string, verb: string, actor: string, emoji: string): void {
  sendGroupEcho(`${label} ${verb} by ${actor} ${emoji}`);
}

// Transport per #27: Astro Actions, not hand-rolled REST routes — typed
// client calls with Zod input validation for free.
export const server = {
  inventory: {
    finishBatch: defineAction({
      input: z.object({ lotIds: z.array(z.number().int()) }),
      handler: ({ lotIds }) => finishBatch(getDb(), systemClock, lotIds),
    }),
    decideAutoRelist: defineAction({
      input: z.object({
        productId: z.number().int(),
        wantsAutoRelist: z.boolean(),
      }),
      handler: ({ productId, wantsAutoRelist }) => ({
        applied: decideAutoRelistDb(getDb(), productId, wantsAutoRelist),
      }),
    }),
  },
  shopping: {
    addManual: defineAction({
      input: z.object({ text: z.string().min(1) }),
      handler: ({ text }, context) => {
        const entry = addManualEntry(getDb(), systemClock, text);
        echoEntry(entryLabel(entry), "added to shopping list", context.locals.userName, "🛒");
        return entry;
      },
    }),
    checkOff: defineAction({
      input: z.object({ entryId: z.number().int() }),
      handler: ({ entryId }, context) => {
        const db = getDb();
        // Looked up before the flip — clearEntry only reports success, not
        // which entry it was, and a lost race means there's nothing left to
        // echo anyway.
        const entry = fetchOpenEntries(db).find((e) => e.id === entryId);
        const checked = clearEntry(db, entryId);
        if (checked && entry) {
          echoEntry(entryLabel(entry), "checked off", context.locals.userName, "✓");
        }
        return { checked };
      },
    }),
    acceptCycleGuess: defineAction({
      input: z.object({ productId: z.number().int(), productName: z.string() }),
      handler: ({ productId, productName }, context) => {
        const entry = addCycleGuessEntry(getDb(), systemClock, { productId, productName });
        echoEntry(
          `${productName} (probably low)`,
          "added to shopping list",
          context.locals.userName,
          "🛒",
        );
        return entry;
      },
    }),
  },
};
