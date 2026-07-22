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

const DEFAULT_MODEL = "qwen/qwen3.6-27b";
const REQUEST_TIMEOUT_MS = 30_000;
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type Message =
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCallPart[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCallPart {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ToolDeclaration {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface GroqChatClient {
  createChatCompletion(params: {
    model: string;
    messages: Message[];
    response_format?: { type: "json_object" };
    tools?: ToolDeclaration[];
    reasoning_format?: "raw" | "parsed" | "hidden";
    reasoning_effort?: "none" | "default";
  }): Promise<{
    choices: {
      message: {
        content: string | null;
        tool_calls?: ToolCallPart[];
      };
    }[];
  }>;
}

export interface GroqBrainOptions {
  model?: string;
  sleep?: (ms: number) => Promise<void>;
}

export class GroqBrain implements Brain {
  private readonly client: GroqChatClient;
  private readonly model: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(client: GroqChatClient, options: GroqBrainOptions = {}) {
    this.client = client;
    this.model = options.model ?? DEFAULT_MODEL;
    this.sleep = options.sleep ?? realSleep;
  }

  async extractReceipt(photo: Buffer, catalogNames: string[]): Promise<ReceiptExtraction> {
    const messages: Message[] = [
      { role: "user", content: buildImageMessage(buildExtractReceiptPrompt(catalogNames), photo) },
    ];
    return this.generateJson(messages, receiptExtractionSchema);
  }

  async reviseReceipt(
    current: ReceiptExtraction,
    correction: string,
    photo: Buffer,
    catalogNames: string[],
  ): Promise<ReceiptExtraction> {
    const messages: Message[] = [
      {
        role: "user",
        content: buildImageMessage(
          buildReviseReceiptPrompt(current, correction, catalogNames),
          photo,
        ),
      },
    ];
    return this.generateJson(messages, receiptExtractionSchema);
  }

  async suggestRecipes(input: RecipeContext): Promise<RecipeSuggestion[]> {
    const messages: Message[] = [{ role: "user", content: buildSuggestRecipesPrompt(input) }];
    const result = await this.generateJson(messages, recipeSuggestionsSchema);
    return result.recipes;
  }

  async estimateShelfLife(productNames: string[]): Promise<ShelfLifeEstimate[]> {
    const messages: Message[] = [
      { role: "user", content: buildEstimateShelfLifePrompt(productNames) },
    ];
    const result = await this.generateJson(messages, shelfLifeEstimatesSchema);
    return result.estimates;
  }

  async parseFreeTextItems(text: string, catalogNames: string[]): Promise<FreeTextExtraction> {
    const messages: Message[] = [
      { role: "user", content: buildParseFreeTextItemsPrompt(text, catalogNames) },
    ];
    return this.generateJson(messages, freeTextExtractionSchema);
  }

  async reviseFreeTextItems(
    current: FreeTextExtraction,
    correction: string,
    catalogNames: string[],
  ): Promise<FreeTextExtraction> {
    const messages: Message[] = [
      {
        role: "user",
        content: buildReviseFreeTextItemsPrompt(current, correction, catalogNames),
      },
    ];
    return this.generateJson(messages, freeTextExtractionSchema);
  }

  async converse(history: ChatTurn[], tools: ChatTool[]): Promise<ChatTurn> {
    const messages = history.map((turn, index) => toGroqMessage(turn, index));
    const toolDeclarations: ToolDeclaration[] = tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));

    const response = await withBackoff(
      () =>
        this.client.createChatCompletion({
          model: this.model,
          messages,
          tools: toolDeclarations,
        }),
      this.sleep,
    ).catch((err: unknown) => {
      throw new BrainUnavailableError("Brain response unavailable", { cause: err });
    });

    const message = response.choices[0]?.message;
    const call = message?.tool_calls?.[0];
    if (call) {
      if (message!.tool_calls!.length > 1) {
        console.warn(
          `[GroqBrain] converse: Groq returned ${message!.tool_calls!.length} tool calls in one turn, using only the first ("${call.function.name}")`,
        );
      }
      return {
        role: "toolCall",
        call: { name: call.function.name, args: safeJsonParse(call.function.arguments) ?? {} },
      };
    }
    if (!message?.content) {
      throw new BrainUnavailableError("Brain response unavailable: empty reply");
    }
    return { role: "model", text: message.content };
  }

  private async generateOnce(messages: Message[]): Promise<string> {
    return withBackoff(async () => {
      const start = Date.now();
      console.log(`[GroqBrain] createChatCompletion request (model=${this.model})`);
      try {
        const response = await withTimeout(
          this.client.createChatCompletion({
            model: this.model,
            messages,
            response_format: { type: "json_object" },
            // qwen3.6 reasons by default, which was breaking Groq's own
            // JSON-mode validator server-side (400 json_validate_failed,
            // empty failed_generation — reasoning_format: "hidden" alone
            // didn't fix it, since the model still spends its token budget
            // reasoning before ever emitting JSON). "none" turns reasoning
            // off outright — fine for this structured-extraction task,
            // which needs no chain-of-thought.
            reasoning_effort: "none",
            reasoning_format: "hidden",
          }),
          REQUEST_TIMEOUT_MS,
        );
        console.log(`[GroqBrain] createChatCompletion responded in ${Date.now() - start}ms`);
        const text = response.choices[0]?.message.content;
        if (!text) {
          throw new Error("Empty response from Groq");
        }
        return text;
      } catch (err) {
        console.error(`[GroqBrain] createChatCompletion failed after ${Date.now() - start}ms`, err);
        throw err;
      }
    }, this.sleep);
  }

  // One retry on parse failure, layered on top of generateOnce's own
  // 429/5xx backoff. Any failure surviving both attempts becomes a single
  // BrainUnavailableError so callers have one thing to catch.
  private async generateJson<T>(messages: Message[], schema: ZodType<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await this.generateOnce(messages);
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

export function createGroqBrain(apiKey: string): GroqBrain {
  return new GroqBrain(createFetchGroqClient(apiKey));
}

function createFetchGroqClient(apiKey: string): GroqChatClient {
  return {
    async createChatCompletion(params) {
      const res = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const body = await res.text();
        throw Object.assign(new Error(`Groq request failed: ${body}`), { status: res.status });
      }
      return (await res.json()) as Awaited<ReturnType<GroqChatClient["createChatCompletion"]>>;
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Groq request timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function buildImageMessage(prompt: string, photo: Buffer): ContentPart[] {
  return [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${photo.toString("base64")}` } },
  ];
}

// Brain's ChatTurn carries no call id, so mint one from the turn's position —
// a toolResult always immediately follows its toolCall, so the pairing stays
// correct even though ids aren't globally unique across a long history.
function toGroqMessage(turn: ChatTurn, index: number): Message {
  const toolCallId = `call_${index}`;
  switch (turn.role) {
    case "user":
      return { role: "user", content: turn.text };
    case "model":
      return { role: "assistant", content: turn.text };
    case "toolCall":
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: toolCallId,
            type: "function",
            function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) },
          },
        ],
      };
    case "toolResult":
      return {
        role: "tool",
        tool_call_id: `call_${index - 1}`,
        content: JSON.stringify(turn.result),
      };
  }
}

function safeJsonParse(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
