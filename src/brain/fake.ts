import type {
  Brain,
  FreeTextExtraction,
  ReceiptExtraction,
  RecipeContext,
  RecipeSuggestion,
  ShelfLifeEstimate,
} from "../brain.js";

// Dev-only stand-in for GeminiBrain, toggled by FAKE_GEMINI=1 (see index.ts).
// Returns plausible canned data instead of calling the API, so the bot can
// be exercised end-to-end (Telegram, DB, scheduling) without burning Gemini
// quota or hitting rate limits during manual testing.
export class FakeBrain implements Brain {
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
}

export function createFakeBrain(): FakeBrain {
  return new FakeBrain();
}
