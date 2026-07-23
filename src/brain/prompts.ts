import type { FreeTextExtraction, ReceiptExtraction, RecipeContext } from "../brain.js";

export const JSON_ONLY_INSTRUCTION =
  "Respond with JSON only — no prose, no markdown fences, no commentary before or after the JSON.";

export const RECEIPT_LINES_SHAPE_INSTRUCTION =
  'Respond with an object: { "lines": [ { "rawName": string, "name": string, "category": "food" | "household", "quantity": number, "unit": string | null, "price": number | null } ] }';

export const FREE_TEXT_LINES_SHAPE_INSTRUCTION =
  'Respond with an object: { "lines": [ { "name": string, "category": "food" | "household", "quantity": number, "unit": string | null } ] }';

function buildCatalogInstruction(catalogNames: string[]): string {
  return [
    "Existing Catalog product names (the household's known products):",
    catalogNames.length > 0 ? catalogNames.map((name) => `- ${name}`).join("\n") : "(empty)",
    "",
    "For each item's name, map it to an existing Catalog name above if it's the same product,",
    "using that name exactly. Only coin a new normalized name if it's genuinely not on the list.",
  ].join("\n");
}

export function buildExtractReceiptPrompt(catalogNames: string[]): string {
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

export function buildReviseReceiptPrompt(
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

export function buildSuggestRecipesPrompt(input: RecipeContext): string {
  const inventoryLines = input.inventory
    .map((item) => {
      const qty = item.unit ? `${item.quantity} ${item.unit}` : `${item.quantity}`;
      const expiry = item.estExpiry ? `, exp ${item.estExpiry}` : "";
      return `- ${item.name} — ${qty}${expiry}`;
    })
    .join("\n");

  return [
    "Suggest 2-3 dishes for a two-person household using ONLY the Catalog names listed below",
    "to refer to ingredients the household already has. Weight suggestions toward using up",
    'soonest-expiring items. Each recipe ingredient must carry a quantity, and "present" must be',
    "true only if the ingredient name matches a Catalog name below verbatim. Each recipe must also",
    "include cooking instructions as an ordered array of short steps, each one a single action a",
    "person can carry out before moving to the next.",
    "",
    "If the request calls for a full meal (a main dish plus a side), suggest one of each and write",
    "each one's steps with awareness of the other, so their timing can be coordinated when cooked",
    "together (e.g. what to start first, what happens while something else simmers).",
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
    'Respond with an object: { "recipes": [ { "title": string, "ingredients": [ { "name": string, "quantity": number, "unit": string | null, "present": boolean } ], "missingCount": number, "instructions": string[] } ] }',
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function buildParseFreeTextItemsPrompt(text: string, catalogNames: string[]): string {
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

export function buildReviseFreeTextItemsPrompt(
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

export function buildEstimateShelfLifePrompt(productNames: string[]): string {
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
