import { and, eq } from "drizzle-orm";
import { stockLots } from "./db/schema.js";
import type { Db } from "./db.js";

// Guarding the WHERE on the current status makes this the atomic
// first-tap-wins primitive: two racing taps only ever let one succeed.
export function finishLot(db: Db, lotId: number): boolean {
  const result = db
    .update(stockLots)
    .set({ status: "finished" })
    .where(and(eq(stockLots.id, lotId), eq(stockLots.status, "in_stock")))
    .run();
  return result.changes > 0;
}
