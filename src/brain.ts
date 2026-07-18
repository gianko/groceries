import { z } from "zod";

// The one seam to the LLM. Every implementation must honour the same
// contract: strict JSON-only prompts, Zod-validated output, one retry on
// parse failure, exponential backoff on 429/5xx, then throw
// BrainUnavailableError so callers can surface a graceful chat message.
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
}

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
