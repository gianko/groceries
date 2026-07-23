import { z } from "zod";
import {
  type Brain,
  BrainUnavailableError,
  type ChatTool,
  type ChatTurn,
  type ToolCall,
} from "./brain.js";
import type { Clock } from "./clock.js";
import {
  addMissingIngredients,
  type CookIngredient,
  type CookMeal,
  type CookRecipe,
  cookMealSchema,
  decrementForMeal,
  type FinishConfirmationLot,
  fetchFavoriteRecipes,
  fetchFoodInventory,
  fetchStapleNames,
  mealTitle,
  rateRecipe as rateRecipeDb,
  reclassifyRecipe,
  saveCookedMeal,
} from "./cook.js";
import type { Db } from "./db.js";
import { fetchPrefs } from "./prefs.js";

// The cook-agent tool table: read-only tools (suggestRecipes,
// checkInventory, fetchFavorites) and immediate-write tools
// (addToShoppingList, rateRecipe) execute the instant the model calls them
// and the loop just keeps going. commitCook is the one Stock-Lot mutation on
// offer, so it's handled specially by runLoop — it's never executed inline;
// see confirmCook.
const SUGGEST_RECIPES_TOOL: ChatTool = {
  name: "suggestRecipes",
  description:
    'Suggest dishes the household could cook, given current inventory. Use `constraint` to say what\'s wanted (e.g. "lunch for 2", "a full meal with a main and a side", "something with the chicken that\'s expiring", "nothing with nuts"). When the user wants a full meal, ask for one main and one side in the constraint so both come back together.',
  parameters: {
    type: "object",
    properties: {
      constraint: {
        type: "string",
        description: "What's wanted — occasion, servings, a full meal vs. one dish, exclusions.",
      },
    },
  },
};

const CHECK_INVENTORY_TOOL: ChatTool = {
  name: "checkInventory",
  description: "List food currently in stock, soonest-expiring first.",
  parameters: { type: "object", properties: {} },
};

const FETCH_FAVORITES_TOOL: ChatTool = {
  name: "fetchFavorites",
  description:
    "List recipes the household has rated 👍 in the past, with which are fully in stock tonight.",
  parameters: { type: "object", properties: {} },
};

const ADD_TO_SHOPPING_LIST_TOOL: ChatTool = {
  name: "addToShoppingList",
  description:
    "Add missing ingredients to the shopping list. Executes immediately — no confirmation needed.",
  parameters: {
    type: "object",
    properties: {
      ingredientNames: { type: "array", items: { type: "string" } },
    },
    required: ["ingredientNames"],
  },
};

const RATE_RECIPE_TOOL: ChatTool = {
  name: "rateRecipe",
  description:
    "Rate a recipe cooked earlier in this conversation, 👍 or 👎. Executes immediately — no confirmation needed.",
  parameters: {
    type: "object",
    properties: {
      recipeId: { type: "number" },
      rating: { type: "string", enum: ["up", "down"] },
    },
    required: ["recipeId", "rating"],
  },
};

// Hand-written JSON Schema, not derived from cookRecipeSchema: the LLM
// function-calling API needs plain JSON Schema, not a Zod schema, and this
// repo has no zod-to-json-schema dependency. Keep this in sync with
// cookRecipeSchema (src/cook.ts) by hand if CookRecipe's shape changes —
// cookMealSchema.parse() below is still what actually validates the args.
const RECIPE_SCHEMA_PROPERTIES = {
  title: { type: "string" },
  ingredients: {
    type: "array",
    items: {
      type: "object",
      properties: {
        name: { type: "string" },
        quantity: { type: "number" },
        unit: { type: "string", nullable: true },
        present: { type: "boolean" },
      },
      required: ["name", "quantity", "present"],
    },
  },
  missingCount: { type: "number" },
  instructions: { type: "array", items: { type: "string" }, nullable: true },
};

const RECIPE_JSON_SCHEMA = {
  type: "object",
  properties: RECIPE_SCHEMA_PROPERTIES,
  required: ["title", "ingredients", "missingCount"],
};

const COMMIT_COOK_TOOL: ChatTool = {
  name: "commitCook",
  description:
    "Propose cooking a meal: one main dish, optionally with a side. This DECREMENTS STOCK, so calling it only proposes the action — the user must tap an explicit confirm affordance before anything is written. Pass the exact recipe object(s) as previously surfaced by suggestRecipes or fetchFavorites.",
  parameters: {
    type: "object",
    properties: {
      main: RECIPE_JSON_SCHEMA,
      side: RECIPE_JSON_SCHEMA,
    },
    required: ["main"],
  },
};

const TOOLS: ChatTool[] = [
  SUGGEST_RECIPES_TOOL,
  CHECK_INVENTORY_TOOL,
  FETCH_FAVORITES_TOOL,
  ADD_TO_SHOPPING_LIST_TOOL,
  RATE_RECIPE_TOOL,
  COMMIT_COOK_TOOL,
];

// A cap on tool round-trips within one user message, so a confused model
// can't loop forever without a human ever seeing a reply.
const MAX_STEPS = 6;

export type ChatAttachment =
  | { type: "recipe"; recipe: CookRecipe }
  | { type: "confirmCook"; meal: CookMeal }
  | { type: "finishChecklist"; recipeId: number; lots: FinishConfirmationLot[] };

export interface ChatAgentResult {
  history: ChatTurn[];
  reply: string;
  attachments: ChatAttachment[];
}

// The wire shape for a chat turn round-tripped through the Actions layer:
// the client holds ChatTurn[] history in memory (reset on page load, per
// #50) and resends the full history on every call, since Actions are
// stateless request handlers with no session to keep it in.
const toolCallSchema = z.object({ name: z.string(), args: z.record(z.string(), z.unknown()) });
export const chatTurnSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), text: z.string() }),
  z.object({ role: z.literal("model"), text: z.string() }),
  z.object({ role: z.literal("toolCall"), call: toolCallSchema }),
  z.object({ role: z.literal("toolResult"), name: z.string(), result: z.unknown() }),
]);

export interface CookAgentDeps {
  db: Db;
  brain: Brain;
  clock: Clock;
}

export async function sendMessage(
  history: ChatTurn[],
  message: string,
  deps: CookAgentDeps,
): Promise<ChatAgentResult> {
  return runLoop([...history, { role: "user", text: message }], deps);
}

// Resumes the conversation after the user taps the explicit confirm
// affordance for a pending commitCook tool call. `history`'s last turn must
// be that toolCall — asserting it here (rather than trusting the client) is
// what makes "no confirm tap, no decrement" a codeable invariant instead of
// just a UI convention.
export async function confirmCook(
  history: ChatTurn[],
  deps: CookAgentDeps,
): Promise<ChatAgentResult> {
  const last = history[history.length - 1];
  if (!last || last.role !== "toolCall" || last.call.name !== "commitCook") {
    throw new Error("confirmCook: history does not end with a pending commitCook tool call");
  }

  const meal = cookMealSchema.parse({
    main: last.call.args.main,
    side: last.call.args.side ?? null,
  });
  const result = decrementForMeal(deps.db, meal);
  const saved = saveCookedMeal(deps.db, deps.clock, meal);

  const attachments: ChatAttachment[] = [];
  if (result.finishConfirmations.length > 0) {
    attachments.push({
      type: "finishChecklist",
      recipeId: saved.mainId,
      lots: result.finishConfirmations,
    });
  }

  const toolResult: ChatTurn = {
    role: "toolResult",
    name: "commitCook",
    result: {
      mainId: saved.mainId,
      sideId: saved.sideId,
      decremented: result.decremented,
      finishConfirmations: result.finishConfirmations,
    },
  };

  return runLoop([...history, toolResult], deps, attachments);
}

async function runLoop(
  history: ChatTurn[],
  deps: CookAgentDeps,
  carriedAttachments: ChatAttachment[] = [],
): Promise<ChatAgentResult> {
  let turns = history;
  const attachments = [...carriedAttachments];

  for (let step = 0; step < MAX_STEPS; step++) {
    let turn: ChatTurn;
    try {
      turn = await deps.brain.converse(turns, TOOLS);
    } catch (err) {
      if (err instanceof BrainUnavailableError) {
        return { history: turns, reply: "🧠 Busy right now — try again in a minute.", attachments };
      }
      throw err;
    }

    if (turn.role === "model") {
      return { history: [...turns, turn], reply: turn.text, attachments };
    }
    if (turn.role !== "toolCall") {
      // converse()'s contract only ever returns a "model" or "toolCall" turn.
      throw new Error(`unexpected turn role from converse(): ${turn.role}`);
    }

    turns = [...turns, turn];

    if (turn.call.name === "commitCook") {
      const meal = cookMealSchema.parse({
        main: turn.call.args.main,
        side: turn.call.args.side ?? null,
      });
      attachments.push({ type: "confirmCook", meal });
      return {
        history: turns,
        reply: `Ready to cook "${mealTitle(meal)}"? Tap confirm to update stock.`,
        attachments,
      };
    }

    const { toolResult, resultAttachments } = await executeTool(turn.call, deps);
    attachments.push(...resultAttachments);
    turns = [...turns, toolResult];
  }

  return {
    history: turns,
    reply: "I'm having trouble finishing that thought — try rephrasing?",
    attachments,
  };
}

async function executeTool(
  call: ToolCall,
  deps: CookAgentDeps,
): Promise<{ toolResult: ChatTurn; resultAttachments: ChatAttachment[] }> {
  switch (call.name) {
    case "suggestRecipes":
      return toolSuggestRecipes(call.args, deps);
    case "checkInventory":
      return toolCheckInventory(deps);
    case "fetchFavorites":
      return toolFetchFavorites(deps);
    case "addToShoppingList":
      return toolAddToShoppingList(call.args, deps);
    case "rateRecipe":
      return toolRateRecipe(call.args, deps);
    default:
      return {
        toolResult: { role: "toolResult", name: call.name, result: { error: "unknown tool" } },
        resultAttachments: [],
      };
  }
}

function missingIngredientNames(recipe: CookRecipe): string[] {
  return recipe.ingredients.filter((i: CookIngredient) => !i.present).map((i) => i.name);
}

function summarize(recipe: CookRecipe) {
  return {
    title: recipe.title,
    missingCount: recipe.missingCount,
    missing: missingIngredientNames(recipe),
  };
}

async function toolSuggestRecipes(args: Record<string, unknown>, deps: CookAgentDeps) {
  const constraint = typeof args.constraint === "string" ? args.constraint.trim() : "";

  const inventory = fetchFoodInventory(deps.db, deps.clock);
  const inventoryNames = new Set(inventory.map((item) => item.name.toLowerCase()));
  const stapleNames = fetchStapleNames(deps.db);
  const favorites = fetchFavoriteRecipes(deps.db);
  const prefs = fetchPrefs(deps.db);
  const prefsBlurb = constraint
    ? [prefs.blurb, `Request: ${constraint}`].filter(Boolean).join("\n")
    : prefs.blurb;

  const raw = await deps.brain.suggestRecipes({
    inventory: inventory.map((item) => ({
      name: item.name,
      category: "food",
      quantity: item.quantity,
      unit: item.unit,
      estExpiry: item.estExpiry,
    })),
    prefsBlurb,
    favoriteRecipeNames: favorites.map((f) => f.title),
  });
  const recipes = raw.map((recipe) => reclassifyRecipe(recipe, inventoryNames, stapleNames));

  return {
    toolResult: {
      role: "toolResult" as const,
      name: "suggestRecipes",
      result: { recipes: recipes.map(summarize) },
    },
    resultAttachments: recipes.map((recipe) => ({ type: "recipe", recipe }) as const),
  };
}

function toolCheckInventory(deps: CookAgentDeps) {
  const inventory = fetchFoodInventory(deps.db, deps.clock);
  return {
    toolResult: { role: "toolResult" as const, name: "checkInventory", result: { inventory } },
    resultAttachments: [],
  };
}

function toolFetchFavorites(deps: CookAgentDeps) {
  const inventory = fetchFoodInventory(deps.db, deps.clock);
  const inventoryNames = new Set(inventory.map((item) => item.name.toLowerCase()));
  const stapleNames = fetchStapleNames(deps.db);
  const favorites = fetchFavoriteRecipes(deps.db).map((favorite) =>
    reclassifyRecipe(
      {
        title: favorite.title,
        ingredients: favorite.ingredients.map((i) => ({ ...i, present: true })),
        missingCount: 0,
        instructions: favorite.instructions,
      },
      inventoryNames,
      stapleNames,
    ),
  );

  return {
    toolResult: {
      role: "toolResult" as const,
      name: "fetchFavorites",
      result: { favorites: favorites.map(summarize) },
    },
    resultAttachments: favorites.map((recipe) => ({ type: "recipe", recipe }) as const),
  };
}

function toolAddToShoppingList(args: Record<string, unknown>, deps: CookAgentDeps) {
  const ingredientNames = Array.isArray(args.ingredientNames)
    ? args.ingredientNames.filter((name): name is string => typeof name === "string")
    : [];
  const count = addMissingIngredients(
    deps.db,
    deps.clock,
    ingredientNames.map((name) => ({ name })),
  );
  return {
    toolResult: { role: "toolResult" as const, name: "addToShoppingList", result: { count } },
    resultAttachments: [],
  };
}

function toolRateRecipe(args: Record<string, unknown>, deps: CookAgentDeps) {
  const recipeId = Number(args.recipeId);
  const rating = args.rating === "down" ? "down" : "up";
  const rated = rateRecipeDb(deps.db, recipeId, rating);
  return {
    toolResult: { role: "toolResult" as const, name: "rateRecipe", result: { rated } },
    resultAttachments: [],
  };
}
