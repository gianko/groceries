import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Catalog identity: stable across purchases. Category and status vocabulary
// are fixed per ADR-0001/0002 — no "low" or "expired" status ever exists.
export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  category: text("category", { enum: ["food", "household"] }).notNull(),
  isStaple: integer("is_staple", { mode: "boolean" }).notNull().default(false),
  autoRelist: integer("auto_relist", { mode: "boolean" }).notNull().default(false),
  // Flips true the first time the household answers the Finish-Confirmation
  // flow's "always re-add this?" offer (yes or no) — the offer only ever
  // appears while this is false, so a "no" sticks just as permanently as a
  // "yes" (which also sets autoRelist).
  autoRelistAsked: integer("auto_relist_asked", { mode: "boolean" }).notNull().default(false),
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
  // Display name of whoever finished this Lot (the web app's per-person
  // identity from #45, or a Telegram first_name while the bot still runs) —
  // null while in_stock, set atomically alongside the status flip in
  // finishLot. Lets a lost race name who else acted instead of a vague
  // "elsewhere" (#46).
  finishedBy: text("finished_by"),
});

// Status only flips done on a human-confirmed action (receipt reconciliation,
// a tap) — never a text match — per ADR-0002. Open entries are what /list
// shows; done entries drop off but stay in the table as history.
export const shoppingListEntries = sqliteTable("shopping_list_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source", {
    enum: ["finished", "staple", "recipe_missing", "manual", "cycle_guess"],
  }).notNull(),
  productId: integer("product_id").references(() => products.id),
  freeText: text("free_text"),
  status: text("status", { enum: ["open", "done"] })
    .notNull()
    .default("open"),
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

// One row per "cooking this" tap: the recipe as cooked, plus the 👍/👎
// verdict from the rating prompt that follows. Rating starts null (asked but
// not yet answered) and only ever flips once — per ADR-0002, the verdict is
// stored state and changes only on that human tap. A recipe cooked more than
// once gets a fresh row each time, so the favorites pass always reasons
// about the most recently cooked verdict for a title.
export const recipes = sqliteTable("recipes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  ingredients: text("ingredients", { mode: "json" })
    .$type<{ name: string; quantity: number; unit: string | null }[]>()
    .notNull(),
  // Nullable: rows predating this column (or any favorite never re-cooked
  // since) have no steps — the recipe view renders an explicit fallback
  // rather than treating that as empty (per #34). Rows written before the
  // migration to ordered steps store a single-element array wrapping the
  // original prose passage.
  instructions: text("instructions", { mode: "json" }).$type<string[]>(),
  rating: text("rating", { enum: ["up", "down"] }),
  createdAt: text("created_at").notNull(),
});

// One row per household member (#45): a distinct bootstrap token and the
// label the CLI mint script was given. Rotation re-runs the mint script for
// the same name, which replaces the token in place rather than adding a row
// — so a name always has at most one live token.
export const personTokens = sqliteTable("person_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  token: text("token").notNull().unique(),
  createdAt: text("created_at").notNull(),
});

export const schema = {
  products,
  stockLots,
  shoppingListEntries,
  rawNameMap,
  prefs,
  recipes,
  personTokens,
};
