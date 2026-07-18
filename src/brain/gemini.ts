import { GoogleGenAI } from "@google/genai";
import type { ZodType } from "zod";
import {
  type Brain,
  BrainUnavailableError,
  type ReceiptExtraction,
  type RecipeContext,
  type RecipeSuggestion,
  receiptExtractionSchema,
  recipeSuggestionsSchema,
  type ShelfLifeEstimate,
  shelfLifeEstimatesSchema,
} from "../brain.js";

const DEFAULT_MODEL = "gemini-2.5-flash";
// One retry on parse failure (handled in generateJson) plus exponential
// backoff on 429/5xx for each individual call (handled here).
const BACKOFF_DELAYS_MS = [500, 1500];

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface GeminiModelsClient {
  generateContent(params: {
    model: string;
    contents: { role: string; parts: Part[] }[];
    config?: { responseMimeType?: string };
  }): Promise<{ text?: string }>;
}

export interface GeminiBrainOptions {
  model?: string;
  sleep?: (ms: number) => Promise<void>;
}

export class GeminiBrain implements Brain {
  private readonly models: GeminiModelsClient;
  private readonly model: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(models: GeminiModelsClient, options: GeminiBrainOptions = {}) {
    this.models = models;
    this.model = options.model ?? DEFAULT_MODEL;
    this.sleep = options.sleep ?? realSleep;
  }

  async extractReceipt(photo: Buffer): Promise<ReceiptExtraction> {
    const parts: Part[] = [{ text: buildExtractReceiptPrompt() }, imagePart(photo)];
    return this.generateJson(parts, receiptExtractionSchema);
  }

  async reviseReceipt(
    current: ReceiptExtraction,
    correction: string,
    photo: Buffer,
  ): Promise<ReceiptExtraction> {
    const parts: Part[] = [
      { text: buildReviseReceiptPrompt(current, correction) },
      imagePart(photo),
    ];
    return this.generateJson(parts, receiptExtractionSchema);
  }

  async suggestRecipes(input: RecipeContext): Promise<RecipeSuggestion[]> {
    const parts: Part[] = [{ text: buildSuggestRecipesPrompt(input) }];
    const result = await this.generateJson(parts, recipeSuggestionsSchema);
    return result.recipes;
  }

  async estimateShelfLife(productNames: string[]): Promise<ShelfLifeEstimate[]> {
    const parts: Part[] = [{ text: buildEstimateShelfLifePrompt(productNames) }];
    const result = await this.generateJson(parts, shelfLifeEstimatesSchema);
    return result.estimates;
  }

  private async generateOnce(parts: Part[]): Promise<string> {
    return withBackoff(async () => {
      const response = await this.models.generateContent({
        model: this.model,
        contents: [{ role: "user", parts }],
        config: { responseMimeType: "application/json" },
      });
      const text = response.text;
      if (!text) {
        throw new Error("Empty response from Gemini");
      }
      return text;
    }, this.sleep);
  }

  // One retry on parse failure, layered on top of generateOnce's own
  // 429/5xx backoff. Any failure surviving both attempts becomes a single
  // BrainUnavailableError so callers have one thing to catch.
  private async generateJson<T>(parts: Part[], schema: ZodType<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await this.generateOnce(parts);
        const parsed = schema.safeParse(safeJsonParse(text));
        if (parsed.success) {
          return parsed.data;
        }
        lastError = parsed.error;
      } catch (err) {
        lastError = err;
      }
    }

    throw new BrainUnavailableError("Brain response unavailable after retry", { cause: lastError });
  }
}

export function createGeminiBrain(apiKey: string): GeminiBrain {
  const ai = new GoogleGenAI({ apiKey });
  return new GeminiBrain(ai.models);
}

function imagePart(photo: Buffer): Part {
  return { inlineData: { mimeType: "image/jpeg", data: photo.toString("base64") } };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function withBackoff<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableError(err) || attempt >= BACKOFF_DELAYS_MS.length) {
        throw err;
      }
      await sleep(BACKOFF_DELAYS_MS[attempt]!);
    }
  }
}

function isRetryableError(err: unknown): boolean {
  const status = extractStatus(err);
  return status === 429 || (status !== undefined && status >= 500 && status < 600);
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const candidate = err as { status?: unknown; code?: unknown; message?: unknown };
  if (typeof candidate.status === "number") {
    return candidate.status;
  }
  if (typeof candidate.code === "number") {
    return candidate.code;
  }
  if (typeof candidate.message === "string") {
    const match = candidate.message.match(/\b(429|5\d{2})\b/);
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const JSON_ONLY_INSTRUCTION =
  "Respond with JSON only — no prose, no markdown fences, no commentary before or after the JSON.";

const RECEIPT_LINES_SHAPE_INSTRUCTION =
  'Respond with an object: { "lines": [ { "rawName": string, "name": string, "category": "food" | "household", "quantity": number, "unit": string | null, "price": number | null } ] }';

function buildExtractReceiptPrompt(): string {
  return [
    "You read Tesco Ireland till receipts from a photo and extract purchased items.",
    'Receipt text uses Tesco Ireland abbreviations (e.g. "T.FIN B/BEANS 420G") and often embeds',
    'quantity/weight in the printed name (e.g. "420G", "6X330ML"). Multibuy lines (e.g. "3 FOR 2",',
    '"ANY 2 FOR EUR5") describe one purchased line, not several. Ignore non-item lines: subtotal,',
    "total, VAT, card/payment details, loyalty points, promotions text with no item, store info.",
    "",
    "For each purchased item, return:",
    "- rawName: the item text exactly as printed on the receipt",
    "- name: a normalized, lowercase, singular-where-natural English name for the underlying product",
    '  (e.g. "baked beans"), stable enough that the same product always gets the same name',
    '- category: "food" or "household"',
    "- quantity: the purchased quantity as a number (default 1 if the receipt doesn't state one)",
    '- unit: the unit for quantity if any (e.g. "g", "ml", "kg"), or null',
    "- price: the line price in euro as a number, or null if unreadable",
    "",
    JSON_ONLY_INSTRUCTION,
    RECEIPT_LINES_SHAPE_INSTRUCTION,
  ].join("\n");
}

function buildReviseReceiptPrompt(current: ReceiptExtraction, correction: string): string {
  return [
    "You previously extracted this receipt as JSON:",
    JSON.stringify(current),
    "",
    "The household member sent this correction in plain language:",
    correction,
    "",
    "Look at the receipt photo again and return the FULL corrected list of lines (not a diff),",
    "applying the correction. Keep every field for every line.",
    "",
    JSON_ONLY_INSTRUCTION,
    RECEIPT_LINES_SHAPE_INSTRUCTION,
  ].join("\n");
}

function buildSuggestRecipesPrompt(input: RecipeContext): string {
  const inventoryLines = input.inventory
    .map(
      (item) =>
        `- ${item.name} (${item.category}${item.estExpiry ? `, exp ${item.estExpiry}` : ""})`,
    )
    .join("\n");

  return [
    "Suggest 2-3 dinner recipes for a two-person household using ONLY the Catalog names listed below",
    "to refer to ingredients the household already has. Weight suggestions toward using up",
    'soonest-expiring items. Each recipe ingredient must carry a quantity, and "present" must be',
    "true only if the ingredient name matches a Catalog name below verbatim.",
    "",
    "Catalog inventory:",
    inventoryLines || "(empty)",
    "",
    input.prefsBlurb ? `Household preferences: ${input.prefsBlurb}` : "",
    input.favoriteRecipeNames.length > 0
      ? `Known favorite recipes: ${input.favoriteRecipeNames.join(", ")}`
      : "",
    "",
    "Missing ingredients per recipe must be capped at 3, biased toward cheap/common items.",
    "",
    JSON_ONLY_INSTRUCTION,
    'Respond with an object: { "recipes": [ { "title": string, "ingredients": [ { "name": string, "quantity": number, "unit": string | null, "present": boolean } ], "missingCount": number } ] }',
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function buildEstimateShelfLifePrompt(productNames: string[]): string {
  return [
    "Estimate a conservative (unopened, pantry/fridge as typical for the product) shelf life in whole",
    "days for each of these grocery/household products, from the day of purchase:",
    "",
    productNames.map((name) => `- ${name}`).join("\n"),
    "",
    JSON_ONLY_INSTRUCTION,
    'Respond with an object: { "estimates": [ { "name": string, "days": number } ] }, one entry per product listed above.',
  ].join("\n");
}
