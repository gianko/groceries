import { eq, inArray } from "drizzle-orm";
import { products, stockLots } from "./db/schema.js";
import type { Db } from "./db.js";

export const MESSAGE_LIMIT = 4096;

export interface InventoryLot {
  lotId: number;
  productName: string;
  category: "food" | "household";
  quantity: number;
  unit: string | null;
  estExpiry: string | null;
}

export interface InventoryChunk {
  text: string;
  lotIds: number[];
}

export function fetchInStockLots(db: Db): InventoryLot[] {
  return db
    .select({
      lotId: stockLots.id,
      productName: products.name,
      category: products.category,
      quantity: stockLots.quantity,
      unit: stockLots.unit,
      estExpiry: stockLots.estExpiry,
    })
    .from(stockLots)
    .innerJoin(products, eq(stockLots.productId, products.id))
    .where(eq(stockLots.status, "in_stock"))
    .all();
}

// Fetches the just-inserted Lots (in insertion order isn't guaranteed by SQL,
// so the web pantry-add UI re-sorts by whatever order it wants) for the
// pantry-add action's response, so the client can insert them into its list
// without a full page reload.
export function fetchLotsByIds(db: Db, lotIds: number[]): InventoryLot[] {
  if (lotIds.length === 0) {
    return [];
  }
  return db
    .select({
      lotId: stockLots.id,
      productName: products.name,
      category: products.category,
      quantity: stockLots.quantity,
      unit: stockLots.unit,
      estExpiry: stockLots.estExpiry,
    })
    .from(stockLots)
    .innerJoin(products, eq(stockLots.productId, products.id))
    .where(inArray(stockLots.id, lotIds))
    .all();
}

interface Section {
  header: string;
  lines: { text: string; lotId: number }[];
}

export interface InventorySections {
  food: InventoryLot[];
  household: InventoryLot[];
}

// The single source of truth for how in-stock lots are grouped/sorted —
// both the Telegram renderer below and the Mini App's server-rendered page
// (#27) consume this so the two surfaces never drift apart.
export function groupForDisplay(lots: InventoryLot[]): InventorySections {
  const food = lots
    .filter((lot) => lot.category === "food")
    .sort(
      (a, b) =>
        compareExpiry(a.estExpiry, b.estExpiry) || a.productName.localeCompare(b.productName),
    );
  const household = lots
    .filter((lot) => lot.category === "household")
    .sort((a, b) => a.productName.localeCompare(b.productName));

  return { food, household };
}

export function renderInventory(lots: InventoryLot[]): InventoryChunk[] {
  const sections = buildSections(lots);

  const blocks: { text: string; lotId?: number }[] = [];
  for (const section of sections) {
    if (blocks.length > 0) {
      blocks.push({ text: "" });
    }
    blocks.push({ text: section.header });
    for (const line of section.lines) {
      blocks.push({ text: line.text, lotId: line.lotId });
    }
  }

  if (blocks.length === 0) {
    return [{ text: "Pantry's empty.", lotIds: [] }];
  }

  return packIntoChunks(blocks);
}

function packIntoChunks(blocks: { text: string; lotId?: number }[]): InventoryChunk[] {
  const chunks: InventoryChunk[] = [];
  let lines: string[] = [];
  let lotIds: number[] = [];

  const flush = () => {
    if (lines.length === 0) {
      return;
    }
    chunks.push({ text: lines.join("\n"), lotIds });
    lines = [];
    lotIds = [];
  };

  for (const block of blocks) {
    const text = capLength(block.text);
    const candidateLength = lines.reduce((sum, line) => sum + line.length + 1, 0) + text.length;
    if (candidateLength > MESSAGE_LIMIT && lines.length > 0) {
      flush();
    }
    lines.push(text);
    if (block.lotId !== undefined) {
      lotIds.push(block.lotId);
    }
  }
  flush();

  return chunks;
}

// Defends the "no message exceeds the Telegram limit" guarantee even for a
// single implausibly long line, which would otherwise not fit any chunk.
function capLength(text: string): string {
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT - 1)}…` : text;
}

function buildSections(lots: InventoryLot[]): Section[] {
  const { food, household } = groupForDisplay(lots);

  const sections: Section[] = [];
  if (food.length > 0) {
    sections.push({ header: "🍎 FOOD", lines: food.map(toLine) });
  }
  if (household.length > 0) {
    sections.push({ header: "🧽 HOUSEHOLD", lines: household.map(toLine) });
  }
  return sections;
}

export function compareExpiry(a: string | null, b: string | null): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a.localeCompare(b);
}

function toLine(lot: InventoryLot): { text: string; lotId: number } {
  const qty = lot.unit ? `${lot.quantity} ${lot.unit}` : `${lot.quantity}`;
  const expiry = lot.estExpiry ? ` (exp ${lot.estExpiry})` : "";
  return { text: `• ${lot.productName} — ${qty}${expiry}`, lotId: lot.lotId };
}
