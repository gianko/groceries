import { GoogleGenAI } from "@google/genai";
import type { ZodType } from "zod";
import {
  type Brain,
  BrainUnavailableError,
  type ChatTool,
  type ChatTurn,
  type FreeTextExtraction,
  freeTextExtractionSchema,
  type ReceiptExtraction,
  type RecipeContext,
  type RecipeSuggestion,
  receiptExtractionSchema,
  recipeSuggestionsSchema,
  type ShelfLifeEstimate,
  shelfLifeEstimatesSchema,
} from "../brain.js";

const DEFAULT_MODEL = "gemini-3.5-flash";
// One retry on parse failure (handled in generateJson) plus exponential
// backoff on 429/5xx for each individual call (handled here).
const BACKOFF_DELAYS_MS = [500, 1500];
// The SDK has no default timeout, so a Gemini call that never responds hangs
// the caller forever instead of surfacing as BrainUnavailableError.
const REQUEST_TIMEOUT_MS = 30_000;

type Part =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GeminiModelsClient {
  generateContent(params: {
    model: string;
    contents: { role: string; parts: Part[] }[];
    config?: {
      responseMimeType?: string;
      tools?: { functionDeclarations: FunctionDeclaration[] }[];
      httpOptions?: { timeout?: number };
    };
  }): Promise<{
    text?: string;
    functionCalls?: { name?: string; args?: Record<string, unknown> }[];
  }>;
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

  async extractReceipt(photo: Buffer, catalogNames: string[]): Promise<ReceiptExtraction> {
    const parts: Part[] = [{ text: buildExtractReceiptPrompt(catalogNames) }, imagePart(photo)];
    return this.generateJson(parts, receiptExtractionSchema);
  }

  async reviseReceipt(
    current: ReceiptExtraction,
    correction: string,
    photo: Buffer,
    catalogNames: string[],
  ): Promise<ReceiptExtraction> {
    const parts: Part[] = [
      { text: buildReviseReceiptPrompt(current, correction, catalogNames) },
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

  async parseFreeTextItems(text: string, catalogNames: string[]): Promise<FreeTextExtraction> {
    const parts: Part[] = [{ text: buildParseFreeTextItemsPrompt(text, catalogNames) }];
    return this.generateJson(parts, freeTextExtractionSchema);
  }

  async reviseFreeTextItems(
    current: FreeTextExtraction,
    correction: string,
    catalogNames: string[],
  ): Promise<FreeTextExtraction> {
    const parts: Part[] = [
      { text: buildReviseFreeTextItemsPrompt(current, correction, catalogNames) },
    ];
    return this.generateJson(parts, freeTextExtractionSchema);
  }

  async converse(history: ChatTurn[], tools: ChatTool[]): Promise<ChatTurn> {
    const contents = history.map(toGeminiContent);
    const functionDeclarations = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

    const response = await withBackoff(
      () =>
        this.models.generateContent({
          model: this.model,
          contents,
          config: {
            tools: [{ functionDeclarations }],
            httpOptions: { timeout: REQUEST_TIMEOUT_MS },
          },
        }),
      this.sleep,
    ).catch((err: unknown) => {
      throw new BrainUnavailableError("Brain response unavailable", { cause: err });
    });

    const call = response.functionCalls?.[0];
    if (call?.name) {
      if (response.functionCalls && response.functionCalls.length > 1) {
        console.warn(
          `[GeminiBrain] converse: Gemini returned ${response.functionCalls.length} function calls in one turn, using only the first ("${call.name}")`,
        );
      }
      return { role: "toolCall", call: { name: call.name, args: call.args ?? {} } };
    }
    if (!response.text) {
      throw new BrainUnavailableError("Brain response unavailable: empty reply");
    }
    return { role: "model", text: response.text };
  }

  private async generateOnce(parts: Part[]): Promise<string> {
    return withBackoff(async () => {
      const start = Date.now();
      console.log(`[GeminiBrain] generateContent request (model=${this.model})`);
      try {
        const response = await this.models.generateContent({
          model: this.model,
          contents: [{ role: "user", parts }],
          config: {
            responseMimeType: "application/json",
            httpOptions: { timeout: REQUEST_TIMEOUT_MS },
          },
        });
        console.log(`[GeminiBrain] generateContent responded in ${Date.now() - start}ms`);
        const text = response.text;
        if (!text) {
          throw new Error("Empty response from Gemini");
        }
        return text;
      } catch (err) {
        console.error(`[GeminiBrain] generateContent failed after ${Date.now() - start}ms`, err);
        throw err;
      }
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

function toGeminiContent(turn: ChatTurn): { role: string; parts: Part[] } {
  switch (turn.role) {
    case "user":
      return { role: "user", parts: [{ text: turn.text }] };
    case "model":
      return { role: "model", parts: [{ text: turn.text }] };
    case "toolCall":
      return {
        role: "model",
        parts: [{ functionCall: { name: turn.call.name, args: turn.call.args } }],
      };
    case "toolResult":
      return {
        role: "user",
        parts: [{ functionResponse: { name: turn.name, response: { result: turn.result } } }],
      };
  }
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

function buildCatalogInstruction(catalogNames: string[]): string {
  return [
    "Existing Catalog product names (the household's known products):",
    catalogNames.length > 0 ? catalogNames.map((name) => `- ${name}`).join("\n") : "(empty)",
    "",
    "For each item's name, map it to an existing Catalog name above if it's the same product,",
    "using that name exactly. Only coin a new normalized name if it's genuinely not on the list.",
  ].join("\n");
}

function buildExtractReceiptPrompt(catalogNames: string[]): string {
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
    buildCatalogInstruction(catalogNames),
    "",
    JSON_ONLY_INSTRUCTION,
    RECEIPT_LINES_SHAPE_INSTRUCTION,
  ].join("\n");
}

function buildReviseReceiptPrompt(
  current: ReceiptExtraction,
  correction: string,
  catalogNames: string[],
): string {
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
    buildCatalogInstruction(catalogNames),
    "",
    JSON_ONLY_INSTRUCTION,
    RECEIPT_LINES_SHAPE_INSTRUCTION,
  ].join("\n");
}

function buildSuggestRecipesPrompt(input: RecipeContext): string {
  const inventoryLines = input.inventory
    .map((item) => {
      const qty = item.unit ? `${item.quantity} ${item.unit}` : `${item.quantity}`;
      const expiry = item.estExpiry ? `, exp ${item.estExpiry}` : "";
      return `- ${item.name} — ${qty}${expiry}`;
    })
    .join("\n");

  return [
    "Suggest 2-3 dinner recipes for a two-person household using ONLY the Catalog names listed below",
    "to refer to ingredients the household already has. Weight suggestions toward using up",
    'soonest-expiring items. Each recipe ingredient must carry a quantity, and "present" must be',
    "true only if the ingredient name matches a Catalog name below verbatim. Each recipe must also",
    "include step-by-step cooking instructions as a list of short, ordered steps.",
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

const FREE_TEXT_LINES_SHAPE_INSTRUCTION =
  'Respond with an object: { "lines": [ { "name": string, "category": "food" | "household", "quantity": number, "unit": string | null } ] }';

function buildParseFreeTextItemsPrompt(text: string, catalogNames: string[]): string {
  return [
    "A household member listed grocery/household items already at home, in plain language,",
    'not from a receipt (e.g. "2 tins baked beans, bag of rice, half a pack of pasta, milk").',
    "",
    "Free text list:",
    text,
    "",
    "For each item, return:",
    "- name: a normalized, lowercase, singular-where-natural English name for the underlying product",
    '  (e.g. "baked beans"), stable enough that the same product always gets the same name',
    '- category: "food" or "household"',
    "- quantity: the stated quantity as a number (default 1 if not stated)",
    '- unit: the unit for quantity if any (e.g. "g", "ml", "kg"), or null',
    "",
    buildCatalogInstruction(catalogNames),
    "",
    JSON_ONLY_INSTRUCTION,
    FREE_TEXT_LINES_SHAPE_INSTRUCTION,
  ].join("\n");
}

function buildReviseFreeTextItemsPrompt(
  current: FreeTextExtraction,
  correction: string,
  catalogNames: string[],
): string {
  return [
    "You previously parsed a free-text pantry list as JSON:",
    JSON.stringify(current),
    "",
    "The household member sent this correction in plain language:",
    correction,
    "",
    "Return the FULL corrected list of lines (not a diff), applying the correction. Keep every",
    "field for every line.",
    "",
    buildCatalogInstruction(catalogNames),
    "",
    JSON_ONLY_INSTRUCTION,
    FREE_TEXT_LINES_SHAPE_INSTRUCTION,
  ].join("\n");
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
