import type {
  Brain,
  ChatTool,
  ChatTurn,
  FreeTextExtraction,
  ReceiptExtraction,
  RecipeContext,
  RecipeSuggestion,
  ShelfLifeEstimate,
} from "../../src/brain.js";

export interface BrainCall {
  method: keyof Brain;
  args: unknown[];
}

// A scripted Brain: each method is a queue of canned results (value or
// thrown error) consumed in call order, so a test can script exactly what
// the "LLM" returns/fails on for each successive call. Calling past the end
// of a queue reuses the last scripted entry, so single-entry scripts work
// for tests that don't care how many times a method is called.
export class BrainFake implements Brain {
  calls: BrainCall[] = [];

  private extractReceiptQueue: ScriptedResult<ReceiptExtraction>[] = [];
  private reviseReceiptQueue: ScriptedResult<ReceiptExtraction>[] = [];
  private suggestRecipesQueue: ScriptedResult<RecipeSuggestion[]>[] = [];
  private estimateShelfLifeQueue: ScriptedResult<ShelfLifeEstimate[]>[] = [];
  private parseFreeTextItemsQueue: ScriptedResult<FreeTextExtraction>[] = [];
  private reviseFreeTextItemsQueue: ScriptedResult<FreeTextExtraction>[] = [];
  private converseQueue: ScriptedResult<ChatTurn>[] = [];

  scriptExtractReceipt(...results: ScriptedResult<ReceiptExtraction>[]): void {
    this.extractReceiptQueue = results;
  }

  scriptReviseReceipt(...results: ScriptedResult<ReceiptExtraction>[]): void {
    this.reviseReceiptQueue = results;
  }

  scriptSuggestRecipes(...results: ScriptedResult<RecipeSuggestion[]>[]): void {
    this.suggestRecipesQueue = results;
  }

  scriptEstimateShelfLife(...results: ScriptedResult<ShelfLifeEstimate[]>[]): void {
    this.estimateShelfLifeQueue = results;
  }

  scriptParseFreeTextItems(...results: ScriptedResult<FreeTextExtraction>[]): void {
    this.parseFreeTextItemsQueue = results;
  }

  scriptReviseFreeTextItems(...results: ScriptedResult<FreeTextExtraction>[]): void {
    this.reviseFreeTextItemsQueue = results;
  }

  // Each entry is one converse() call's return turn, consumed in order — a
  // test scripts a whole tool-call/model-reply sequence up front, one entry
  // per round trip through the loop.
  scriptConverse(...turns: ScriptedResult<ChatTurn>[]): void {
    this.converseQueue = turns;
  }

  async extractReceipt(photo: Buffer, catalogNames: string[]): Promise<ReceiptExtraction> {
    this.calls.push({ method: "extractReceipt", args: [photo, catalogNames] });
    return consume(this.extractReceiptQueue);
  }

  async reviseReceipt(
    current: ReceiptExtraction,
    correction: string,
    photo: Buffer,
    catalogNames: string[],
  ): Promise<ReceiptExtraction> {
    this.calls.push({ method: "reviseReceipt", args: [current, correction, photo, catalogNames] });
    return consume(this.reviseReceiptQueue);
  }

  async suggestRecipes(input: RecipeContext): Promise<RecipeSuggestion[]> {
    this.calls.push({ method: "suggestRecipes", args: [input] });
    return consume(this.suggestRecipesQueue);
  }

  async estimateShelfLife(productNames: string[]): Promise<ShelfLifeEstimate[]> {
    this.calls.push({ method: "estimateShelfLife", args: [productNames] });
    return consume(this.estimateShelfLifeQueue);
  }

  async parseFreeTextItems(text: string, catalogNames: string[]): Promise<FreeTextExtraction> {
    this.calls.push({ method: "parseFreeTextItems", args: [text, catalogNames] });
    return consume(this.parseFreeTextItemsQueue);
  }

  async reviseFreeTextItems(
    current: FreeTextExtraction,
    correction: string,
    catalogNames: string[],
  ): Promise<FreeTextExtraction> {
    this.calls.push({ method: "reviseFreeTextItems", args: [current, correction, catalogNames] });
    return consume(this.reviseFreeTextItemsQueue);
  }

  async converse(
    history: ChatTurn[],
    tools: ChatTool[],
    systemInstruction?: string,
  ): Promise<ChatTurn> {
    this.calls.push({ method: "converse", args: [history, tools, systemInstruction] });
    return consume(this.converseQueue);
  }
}

type ScriptedResult<T> = { value: T } | { error: unknown };

function consume<T>(queue: ScriptedResult<T>[]): T | Promise<never> {
  if (queue.length === 0) {
    throw new Error("BrainFake: no scripted result queued for this call");
  }
  const result = queue.length > 1 ? queue.shift()! : queue[0]!;
  if ("error" in result) {
    return Promise.reject(result.error);
  }
  return result.value;
}

export function ok<T>(value: T): ScriptedResult<T> {
  return { value };
}

export function fail<T>(error: unknown): ScriptedResult<T> {
  return { error };
}
