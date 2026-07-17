import {
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// Catalog identity: stable across purchases. Category and status vocabulary
// are fixed per ADR-0001/0002 — no "low" or "expired" status ever exists.
export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  category: text("category", { enum: ["food", "household"] }).notNull(),
  isStaple: integer("is_staple", { mode: "boolean" }).notNull().default(false),
  autoRelist: integer("auto_relist", { mode: "boolean" })
    .notNull()
    .default(false),
  shelfLifeDays: integer("shelf_life_days"),
});

// One purchase of a Product. Status is binary and only ever flips on a
// human tap (ADR-0002) — no code path may set it any other way.
export const stockLots = sqliteTable("stock_lots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id")
    .notNull()
    .references(() => products.id),
  quantity: real("quantity").notNull(),
  unit: text("unit"),
  price: real("price"),
  purchasedAt: text("purchased_at").notNull(),
  estExpiry: text("est_expiry"),
  status: text("status", { enum: ["in_stock", "finished"] })
    .notNull()
    .default("in_stock"),
});

export const shoppingListEntries = sqliteTable("shopping_list_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source", {
    enum: ["finished", "staple", "recipe_missing", "manual", "cycle_guess"],
  }).notNull(),
  productId: integer("product_id").references(() => products.id),
  freeText: text("free_text"),
  createdAt: text("created_at").notNull(),
});

// Once a receipt is confirmed, a Raw Name maps permanently to its Product —
// known Raw Names bypass LLM naming entirely.
export const rawNameMap = sqliteTable("raw_name_map", {
  rawName: text("raw_name").primaryKey(),
  productId: integer("product_id")
    .notNull()
    .references(() => products.id),
});

// Singleton row (id always 1) holding household prefs.
export const prefs = sqliteTable("prefs", {
  id: integer("id").primaryKey().default(1),
  householdSize: integer("household_size"),
  blurb: text("blurb"),
});

// Pending-keyboard machinery for flows where one message holds exactly one
// decision (receipt confirm/edit/discard, expiry verdicts): keyed by the
// bot's own reply message ID, no session concept. A row's presence means
// "undecided"; a decisive callback deletes it atomically, so first-tap-wins
// and a lost race is a no-op. /inventory's per-line Finish buttons pack many
// independent decisions into one message, so they don't use this table —
// each Lot's own in_stock/finished status is the source of truth, and the
// finish transition is guarded by a conditional UPDATE instead (see
// src/finish.ts).
export const pendings = sqliteTable("pendings", {
  messageId: integer("message_id").primaryKey(),
  kind: text("kind").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
});

export const schema = {
  products,
  stockLots,
  shoppingListEntries,
  rawNameMap,
  prefs,
  pendings,
};
