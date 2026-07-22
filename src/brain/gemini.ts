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
import {
  buildEstimateShelfLifePrompt,
  buildExtractReceiptPrompt,
  buildParseFreeTextItemsPrompt,
  buildReviseFreeTextItemsPrompt,
  buildReviseReceiptPrompt,
  buildSuggestRecipesPrompt,
} from "./prompts.js";
import { realSleep, withBackoff } from "./retry.js";

const DEFAULT_MODEL = "gemini-3.5-flash";
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
