import { actions } from "astro:actions";
import { useEffect, useState } from "preact/hooks";
import type {
  CookIngredient,
  CookRecipe,
  CookSuggestions,
  DecrementedLot,
  FinishConfirmationLot,
} from "../../../src/cook.js";
import { useToast } from "../lib/toast";
import ChatPane from "./ChatPane";
import FinishChecklist from "./FinishChecklist";
import RecipeCard from "./RecipeCard";

interface Props {
  favoritesTonight: CookRecipe[];
  allFavorites: CookRecipe[];
}

type BrainState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "available"; cookTonight: CookRecipe[]; almostThere: CookRecipe[] };

function missingOf(recipe: CookRecipe): CookIngredient[] {
  return recipe.ingredients.filter((i) => !i.present);
}

function fmtQty(quantity: number, unit: string | null): string {
  return unit ? `${quantity} ${unit}` : `${quantity}`;
}

// Whatever tiers are already loaded feed the chat pane's suggestRecipes tool
// per #50 — null while loading or unavailable, so the tool falls back to a
// fresh Brain call rather than reusing nothing.
function loadedSuggestionsOf(brain: BrainState): CookSuggestions | null {
  return brain.status === "available"
    ? { cookTonight: brain.cookTonight, almostThere: brain.almostThere }
    : null;
}

export default function CookScreen({ favoritesTonight, allFavorites }: Props) {
  const [brain, setBrain] = useState<BrainState>({ status: "loading" });
  const [showFavorites, setShowFavorites] = useState(false);
  const [openRecipe, setOpenRecipe] = useState<CookRecipe | null>(null);

  useEffect(() => {
    let cancelled = false;
    actions.cook.suggestTonight({}).then(({ data, error }) => {
      if (cancelled) {
        return;
      }
      if (error || !data || !data.available) {
        setBrain({ status: "unavailable" });
        return;
      }
      setBrain({
        status: "available",
        cookTonight: data.cookTonight,
        almostThere: data.almostThere,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <header class="screen-head cook">
        <div class="screen-eyebrow">CHEFBOTCITO</div>
        <h1>Cook</h1>
      </header>

      {showFavorites ? (
        <FavoritesBrowse
          favorites={allFavorites}
          onBack={() => setShowFavorites(false)}
          onOpen={setOpenRecipe}
        />
      ) : (
        <>
          <h2 class="section-head">🍳 Cook tonight</h2>
          {brain.status === "loading" && <p class="empty-state">Loading…</p>}
          {brain.status === "unavailable" && (
            <p class="empty-state">🧠 Recipe ideas aren't available right now.</p>
          )}
          {brain.status === "available" && (
            <RecipeList
              recipes={brain.cookTonight}
              onOpen={setOpenRecipe}
              emptyText="Nothing fully in stock for tonight."
            />
          )}

          <h2 class="section-head">🧩 Almost there</h2>
          {brain.status === "loading" && <p class="empty-state">Loading…</p>}
          {brain.status === "unavailable" && (
            <p class="empty-state">🧠 Recipe ideas aren't available right now.</p>
          )}
          {brain.status === "available" && (
            <RecipeList
              recipes={brain.almostThere}
              onOpen={setOpenRecipe}
              showMissing
              emptyText="Nothing close — check the shopping list."
            />
          )}

          <div class="section-head-row">
            <h2 class="section-head">⭐ Favorites you can cook tonight</h2>
            <button type="button" class="link-btn" onClick={() => setShowFavorites(true)}>
              See all →
            </button>
          </div>
          <RecipeList
            recipes={favoritesTonight}
            onOpen={setOpenRecipe}
            emptyText="None of your favorites are fully in stock tonight."
          />
        </>
      )}

      {openRecipe && <RecipeModal recipe={openRecipe} onClose={() => setOpenRecipe(null)} />}

      <ChatPane loadedSuggestions={loadedSuggestionsOf(brain)} onOpenRecipe={setOpenRecipe} />
    </div>
  );
}

function RecipeList({
  recipes,
  onOpen,
  showMissing = false,
  emptyText,
}: {
  recipes: CookRecipe[];
  onOpen: (recipe: CookRecipe) => void;
  showMissing?: boolean;
  emptyText: string;
}) {
  if (recipes.length === 0) {
    return <p class="empty-state">{emptyText}</p>;
  }

  return (
    <ul class="recipe-list">
      {recipes.map((recipe) => (
        <li key={recipe.title}>
          <RecipeCard recipe={recipe} showMissing={showMissing} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

function FavoritesBrowse({
  favorites,
  onBack,
  onOpen,
}: {
  favorites: CookRecipe[];
  onBack: () => void;
  onOpen: (recipe: CookRecipe) => void;
}) {
  return (
    <div>
      <div class="section-head-row">
        <button type="button" class="link-btn" onClick={onBack}>
          ← Back to tonight
        </button>
      </div>
      <h2 class="section-head">⭐ All favorites</h2>
      {favorites.length === 0 ? (
        <p class="empty-state">No favorites yet — rate a cooked recipe 👍 to build this list.</p>
      ) : (
        <ul class="recipe-list">
          {favorites.map((recipe) => {
            const missing = missingOf(recipe);
            return (
              <li key={recipe.title}>
                <button type="button" class="recipe-row" onClick={() => onOpen(recipe)}>
                  <span class="recipe-icon">🍽️</span>
                  <span class="recipe-main">
                    <span class="recipe-title">{recipe.title}</span>
                    {missing.length > 0 && (
                      <span class="recipe-sub">{missing.map((i) => i.name).join(", ")}</span>
                    )}
                  </span>
                  {missing.length > 0 && <span class="tag missing">missing {missing.length}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface CookResult {
  recipeId: number;
  decremented: DecrementedLot[];
  finishConfirmations: FinishConfirmationLot[];
}

function RecipeModal({ recipe, onClose }: { recipe: CookRecipe; onClose: () => void }) {
  const [tab, setTab] = useState<"ingredients" | "steps">("ingredients");
  const [committing, setCommitting] = useState(false);
  const [addingMissing, setAddingMissing] = useState(false);
  const [missingAdded, setMissingAdded] = useState(false);
  const [result, setResult] = useState<CookResult | null>(null);
  const [finishRemaining, setFinishRemaining] = useState<FinishConfirmationLot[]>([]);
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [ratingSubmitting, setRatingSubmitting] = useState(false);
  const { toast, show: showToast } = useToast();

  const missing = missingOf(recipe);

  async function commit() {
    if (committing) {
      return;
    }
    setCommitting(true);
    const { data, error } = await actions.cook.commit({ recipe });
    if (error || !data) {
      setCommitting(false);
      return;
    }
    setResult(data);
    setFinishRemaining(data.finishConfirmations);
  }

  async function addMissing() {
    if (addingMissing || missingAdded) {
      return;
    }
    setAddingMissing(true);
    const { error } = await actions.cook.addMissing({
      ingredientNames: missing.map((i) => i.name),
    });
    setAddingMissing(false);
    if (!error) {
      setMissingAdded(true);
      showToast(`Added ${missing.length} to shopping list`);
    }
  }

  async function rate(value: "up" | "down") {
    if (!result || rating || ratingSubmitting) {
      return;
    }
    setRatingSubmitting(true);
    const { data, error } = await actions.cook.rate({ recipeId: result.recipeId, rating: value });
    setRatingSubmitting(false);
    if (!error && data?.rated) {
      setRating(value);
      showToast(value === "up" ? "Thanks!" : "Noted — thanks");
    }
  }

  const allResolved = finishRemaining.length === 0;

  return (
    <div class="modal-overlay">
      <div class="modal-header">
        <button type="button" class="modal-back" onClick={onClose} aria-label="Close">
          ←
        </button>
        <span class="modal-title">{recipe.title}</span>
      </div>
      <div class="modal-body">
        {!result ? (
          <>
            <div class="tabs">
              <button
                type="button"
                class={`tab ${tab === "ingredients" ? "active" : ""}`}
                onClick={() => setTab("ingredients")}
              >
                Ingredients
              </button>
              <button
                type="button"
                class={`tab ${tab === "steps" ? "active" : ""}`}
                onClick={() => setTab("steps")}
              >
                Steps
              </button>
            </div>

            {tab === "ingredients" ? (
              <div>
                {recipe.ingredients.map((ingredient) => (
                  <div class="ing-row" key={ingredient.name}>
                    <span class={`ing-dot ${ingredient.present ? "" : "missing"}`}>
                      {ingredient.present ? "✓" : "✕"}
                    </span>
                    <span class="ing-name">{ingredient.name}</span>
                    <span class="ing-qty">{fmtQty(ingredient.quantity, ingredient.unit)}</span>
                  </div>
                ))}
              </div>
            ) : recipe.instructions === null ? (
              <p class="steps-empty">Steps weren't saved for this recipe.</p>
            ) : (
              <ol class="steps-list">
                {recipe.instructions.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            )}
          </>
        ) : (
          <div>
            {result.decremented.length > 0 && (
              <div class="result-block">
                <h3>Used</h3>
                {result.decremented.map((lot) => (
                  <div class="used-row" key={lot.lotId}>
                    <span>{lot.productName}</span>
                    <span>
                      {lot.before} → {lot.after}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {result.decremented.length === 0 && finishRemaining.length === 0 && (
              <p class="empty-state">Nothing to update — everything used was a Staple.</p>
            )}

            <FinishChecklist lots={finishRemaining} onChange={setFinishRemaining} />

            {allResolved && (
              <div class="rate-block">
                {rating ? (
                  <>
                    <div class="rate-btns">
                      <button
                        type="button"
                        class={`rate-btn ${rating === "up" ? "picked" : ""}`}
                        disabled
                      >
                        👍
                      </button>
                      <button
                        type="button"
                        class={`rate-btn ${rating === "down" ? "picked" : ""}`}
                        disabled
                      >
                        👎
                      </button>
                    </div>
                    <p class="rate-thanks">Thanks — saved.</p>
                  </>
                ) : (
                  <>
                    <p>How was it?</p>
                    <div class="rate-btns">
                      <button type="button" class="rate-btn" onClick={() => rate("up")}>
                        👍
                      </button>
                      <button type="button" class="rate-btn" onClick={() => rate("down")}>
                        👎
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {!result && (
        <div class="modal-footer">
          {missing.length === 0 ? (
            <button type="button" class="primary-btn" disabled={committing} onClick={commit}>
              {committing ? "Cooking…" : "Cook this"}
            </button>
          ) : (
            <>
              <button
                type="button"
                class="primary-btn"
                disabled={addingMissing || missingAdded}
                onClick={addMissing}
              >
                {missingAdded ? "Added" : `Add ${missing.length} missing to shopping list`}
              </button>
              <button type="button" class="ghost-btn" disabled={committing} onClick={commit}>
                {committing ? "Cooking…" : "Cook anyway (skip missing)"}
              </button>
            </>
          )}
        </div>
      )}

      {toast && <div class="toast">{toast}</div>}
    </div>
  );
}
