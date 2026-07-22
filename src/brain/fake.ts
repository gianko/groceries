import {
  type Brain,
  BrainUnavailableError,
  type ChatTool,
  type ChatTurn,
  type FreeTextExtraction,
  type ReceiptExtraction,
  type RecipeContext,
  type RecipeSuggestion,
  type ShelfLifeEstimate,
} from "../brain.js";

export interface FakeBrainOptions {
  // Scripted turns returned one-per-call from converse(), in order. Lets
  // tests drive a multi-turn tool-calling loop deterministically without a
  // real LLM: e.g. [{ role: "toolCall", call: {...} }, { role: "model", text: "..." }].
  scriptedConversation?: ChatTurn[];
}

// Dev-only stand-in for a real Brain, toggled by FAKE_BRAIN=1 (see webDb.ts's
// getBrain()). Returns plausible canned data instead of calling the API, so
// the web app can be exercised end-to-end without burning API quota or
// hitting rate limits during manual testing.
export class FakeBrain implements Brain {
  private readonly scriptedConversation: ChatTurn[];
  private conversationStep = 0;

  constructor(options: FakeBrainOptions = {}) {
    this.scriptedConversation = options.scriptedConversation ?? [];
  }

  async extractReceipt(_photo: Buffer, catalogNames: string[]): Promise<ReceiptExtraction> {
    console.log("[FakeBrain] extractReceipt (canned response, no API call)");
    return {
      lines: [
        {
          rawName: "T.FIN B/BEANS 420G",
          name: catalogNames[0] ?? "baked beans",
          category: "food",
          quantity: 1,
          unit: "g",
          price: 1.2,
        },
        {
          rawName: "FAIRY LIQUID 450ML",
          name: catalogNames[1] ?? "washing up liquid",
          category: "household",
          quantity: 1,
          unit: "ml",
          price: 2.5,
        },
      ],
    };
  }

  async reviseReceipt(
    current: ReceiptExtraction,
    correction: string,
    _photo: Buffer,
    _catalogNames: string[],
  ): Promise<ReceiptExtraction> {
    console.log(`[FakeBrain] reviseReceipt (canned response, correction ignored: "${correction}")`);
    return current;
  }

  async suggestRecipes(input: RecipeContext): Promise<RecipeSuggestion[]> {
    console.log("[FakeBrain] suggestRecipes (canned response, no API call)");
    const first = input.inventory[0];
    return [
      {
        title: "Fake Test Bake",
        ingredients: first
          ? [{ name: first.name, quantity: first.quantity, unit: first.unit, present: true }]
          : [],
        missingCount: 0,
        instructions: ["Preheat oven.", "Combine ingredients.", "Bake for 20 minutes."],
      },
    ];
  }

  async estimateShelfLife(productNames: string[]): Promise<ShelfLifeEstimate[]> {
    console.log("[FakeBrain] estimateShelfLife (canned response, no API call)");
    return productNames.map((name) => ({ name, days: 7 }));
  }

  async parseFreeTextItems(text: string, catalogNames: string[]): Promise<FreeTextExtraction> {
    console.log(`[FakeBrain] parseFreeTextItems (canned response, text ignored: "${text}")`);
    return {
      lines: [
        {
          name: catalogNames[0] ?? "milk",
          category: "food",
          quantity: 1,
          unit: null,
        },
      ],
    };
  }

  async reviseFreeTextItems(
    current: FreeTextExtraction,
    correction: string,
    _catalogNames: string[],
  ): Promise<FreeTextExtraction> {
    console.log(
      `[FakeBrain] reviseFreeTextItems (canned response, correction ignored: "${correction}")`,
    );
    return current;
  }

  async converse(_history: ChatTurn[], _tools: ChatTool[]): Promise<ChatTurn> {
    const turn = this.scriptedConversation[this.conversationStep];
    if (!turn) {
      throw new BrainUnavailableError(
        `[FakeBrain] converse: scripted conversation exhausted at step ${this.conversationStep}`,
      );
    }
    console.log(
      `[FakeBrain] converse (scripted step ${this.conversationStep}, no API call): ${turn.role}`,
    );
    this.conversationStep++;
    return turn;
  }
}

export function createFakeBrain(options?: FakeBrainOptions): FakeBrain {
  return new FakeBrain(options);
}
