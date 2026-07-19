import { defineAction } from "astro:actions";
import { z } from "zod";
import { systemClock } from "../../../src/clock.js";
import { decideAutoRelist as decideAutoRelistDb, finishBatch } from "../../../src/finish.js";
import { getDb } from "../lib/webDb.js";

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
};
