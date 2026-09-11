import { z } from "zod";

// The one seam to the LLM. The single-shot methods below share one contract:
// strict JSON-only prompts, Zod-validated output, one retry on parse
// failure, exponential backoff on 429/5xx, then throw BrainUnavailableError
// so callers can surface a graceful chat message. converse() is exempt from
// the JSON/Zod/parse-retry part of that contract (there's no structured
// schema to validate — a tool call's args are whatever the LLM's function-
// calling API hands back), but still backs off on 429/5xx and still throws
// BrainUnavailableError once it gives up.
export interface Brain {
  extractReceipt(photo: Buffer, catalogNames: string[]): Promise<ReceiptExtraction>;
  reviseReceipt(
    current: ReceiptExtraction,
    correction: string,
    photo: Buffer,
    catalogNames: string[],
  ): Promise<ReceiptExtraction>;
  suggestRecipes(input: RecipeContext): Promise<RecipeSuggestion[]>;
  estimateShelfLife(productNames: string[]): Promise<ShelfLifeEstimate[]>;
  parseFreeTextItems(text: string, catalogNames: string[]): Promise<FreeTextExtraction>;
  reviseFreeTextItems(
    current: FreeTextExtraction,
    correction: string,
    catalogNames: string[],
  ): Promise<FreeTextExtraction>;
  // Multi-turn tool-calling loop, distinct from the single-shot structured
  // methods above. Each call advances the conversation by exactly one turn:
  // the caller passes the full turn history plus the tools on offer, and
  // gets back either the model's final text reply or a single tool call.
  // The caller — not this method — executes the tool, decides confirmation
  // semantics, appends a toolResult turn, and calls converse again to
  // continue the loop.
  // `systemInstruction` carries the calling agent's standing policy (its
  // role, and how its replies should read). It is resent on every call
  // because each turn is an independent request.
  converse(history: ChatTurn[], tools: ChatTool[], systemInstruction?: string): Promise<ChatTurn>;
}

export interface ChatTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema, passed through to the LLM
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  // Opaque, provider-owned state that has to be handed back verbatim when
  // this call is replayed in a later request. Thinking models issue one per
  // tool call and reject the whole conversation if it goes missing, so the
  // seam has to carry it even though only the provider can read it. Nothing
  // outside a Brain implementation should inspect or construct this.
  providerMeta?: unknown;
}

export type ChatTurn =
  | { role: "user"; text: string }
  | { role: "model"; text: string }
  | { role: "toolCall"; call: ToolCall }
  | { role: "toolResult"; name: string; result: unknown };

export const receiptLineSchema = z.object({
  rawName: z.string(),
  name: z.string(),
  category: z.enum(["food", "household"]),
  quantity: z.number().positive().default(1),
  unit: z.string().nullable().optional(),
  price: z.number().nullable().optional(),
});
export type ReceiptLine = z.infer<typeof receiptLineSchema>;

export const receiptExtractionSchema = z.object({
  lines: z.array(receiptLineSchema),
});
export type ReceiptExtraction = z.infer<typeof receiptExtractionSchema>;

// No rawName field — free text isn't a receipt string, so no Raw Name is
// ever mapped from this shape (per the ticket, /add never writes rawNameMap).
export const freeTextLineSchema = z.object({
  name: z.string(),
  category: z.enum(["food", "household"]),
  quantity: z.number().positive().default(1),
  unit: z.string().nullable().optional(),
});
export type FreeTextLine = z.infer<typeof freeTextLineSchema>;

export const freeTextExtractionSchema = z.object({
  lines: z.array(freeTextLineSchema),
});
export type FreeTextExtraction = z.infer<typeof freeTextExtractionSchema>;

export const shelfLifeEstimateSchema = z.object({
  name: z.string(),
  days: z.number().int().positive(),
});
export type ShelfLifeEstimate = z.infer<typeof shelfLifeEstimateSchema>;

export const shelfLifeEstimatesSchema = z.object({
  estimates: z.array(shelfLifeEstimateSchema),
});

export interface RecipeContext {
  inventory: {
    name: string;
    category: "food" | "household";
    quantity: number;
    unit: string | null;
    estExpiry: string | null;
  }[];
  prefsBlurb: string | null;
  favoriteRecipeNames: string[];
}

export const recipeIngredientSchema = z.object({
  name: z.string(),
  quantity: z.number(),
  unit: z.string().nullable().optional(),
  present: z.boolean(),
});
export type RecipeIngredient = z.infer<typeof recipeIngredientSchema>;

export const recipeSuggestionSchema = z.object({
  title: z.string(),
  ingredients: z.array(recipeIngredientSchema),
  missingCount: z.number().int().nonnegative(),
  // Ordered cooking steps, each a single instruction a person can act on
  // while reading down the list.
  instructions: z.array(z.string()),
});
export type RecipeSuggestion = z.infer<typeof recipeSuggestionSchema>;

export const recipeSuggestionsSchema = z.object({
  recipes: z.array(recipeSuggestionSchema),
});

// Thrown by every Brain implementation once its own retry/backoff budget is
// exhausted, so callers have one failure type to catch and turn into the
// "🧠 busy, try again in a minute" message.
export class BrainUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BrainUnavailableError";
  }
}
