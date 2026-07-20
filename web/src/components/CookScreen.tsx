import { actions } from "astro:actions";
import { useEffect, useState } from "preact/hooks";
import type { CookIngredient, CookRecipe, DecrementedLot, FinishConfirmationLot } from "../../../src/cook.js";

interface Props {
  favoritesTonight: CookRecipe[];
  allFavorites: CookRecipe[];
}

type BrainState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "available"; cookTonight: CookRecipe[]; almostThere: CookRecipe[] };

interface AutoRelistOffer {
  productId: number;
  productName: string;
}

function missingOf(recipe: CookRecipe): CookIngredient[] {
  return recipe.ingredients.filter((i) => !i.present);
}

function fmtQty(quantity: number, unit: string | null): string {
  return unit ? `${quantity} ${unit}` : `${quantity}`;
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
      setBrain({ status: "available", cookTonight: data.cookTonight, almostThere: data.almostThere });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <header class="screen-head">
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
              icon="🍳"
              onOpen={setOpenRecipe}
              emptyText="Nothing fully in stock for tonight."
            />
          )}

          <h2 class="section-head">🥘 Almost there</h2>
          {brain.status === "loading" && <p class="empty-state">Loading…</p>}
          {brain.status === "unavailable" && (
            <p class="empty-state">🧠 Recipe ideas aren't available right now.</p>
          )}
          {brain.status === "available" && (
            <RecipeList
              recipes={brain.almostThere}
              icon="🥘"
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
            icon="⭐"
            onOpen={setOpenRecipe}
            emptyText="None of your favorites are fully in stock tonight."
          />
        </>
      )}

      {openRecipe && <RecipeModal recipe={openRecipe} onClose={() => setOpenRecipe(null)} />}
    </div>
  );
}

function RecipeList({
  recipes,
  icon,
  onOpen,
  showMissing = false,
  emptyText,
}: {
  recipes: CookRecipe[];
  icon: string;
  onOpen: (recipe: CookRecipe) => void;
  showMissing?: boolean;
  emptyText: string;
}) {
  if (recipes.length === 0) {
    return <p class="empty-state">{emptyText}</p>;
  }

  return (
    <ul class="recipe-list">
      {recipes.map((recipe) => {
        const missing = showMissing ? missingOf(recipe) : [];
        return (
          <li key={recipe.title}>
            <button type="button" class="recipe-row" onClick={() => onOpen(recipe)}>
              <span class="recipe-icon">{icon}</span>
              <span class="recipe-main">
                <span class="recipe-title">
                  {recipe.title}
                  {showMissing && <span class="tag missing"> missing {missing.length}</span>}
                </span>
                {showMissing && (
                  <span class="recipe-sub">{missing.map((i) => i.name).join(", ")}</span>
                )}
              </span>
              <span class="recipe-chev">›</span>
            </button>
          </li>
        );
      })}
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
                  <span class="recipe-icon">⭐</span>
                  <span class="recipe-main">
                    <span class="recipe-title">{recipe.title}</span>
                    <span class="recipe-sub">
                      {missing.length === 0
                        ? "Fully in stock tonight"
                        : `Missing: ${missing.map((i) => i.name).join(", ")}`}
                    </span>
                  </span>
                  <span class={`tag ${missing.length === 0 ? "gold" : "missing"}`}>
                    {missing.length === 0 ? "tonight" : "missing"}
                  </span>
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
  const [finishConfirmations, setFinishConfirmations] = useState<FinishConfirmationLot[]>([]);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [offers, setOffers] = useState<AutoRelistOffer[]>([]);
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [ratingSubmitting, setRatingSubmitting] = useState(false);

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
    setFinishConfirmations(data.finishConfirmations);
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
    }
  }

  function toggleChecked(lotId: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(lotId)) {
        next.delete(lotId);
      } else {
        next.add(lotId);
      }
      return next;
    });
  }

  async function confirmFinished() {
    const lotIds = [...checked];
    if (lotIds.length === 0) {
      return;
    }
    setConfirming(true);
    const { data, error } = await actions.inventory.finishBatch({ lotIds });
    setConfirming(false);
    if (error || !data) {
      return;
    }
    const finishedIds = new Set(
      data.results.filter((r) => r.finished).map((r) => r.lotId),
    );
    setFinishConfirmations((prev) => prev.filter((l) => !finishedIds.has(l.lotId)));
    setChecked(new Set());
    if (data.autoRelistOffers.length > 0) {
      setOffers((prev) => {
        const existingIds = new Set(prev.map((o) => o.productId));
        const additions = data.autoRelistOffers.filter((o) => !existingIds.has(o.productId));
        return [...prev, ...additions];
      });
    }
  }

  async function decideOffer(productId: number, wantsAutoRelist: boolean) {
    await actions.inventory.decideAutoRelist({ productId, wantsAutoRelist });
    setOffers((prev) => prev.filter((o) => o.productId !== productId));
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
    }
  }

  const allResolved = finishConfirmations.length === 0;

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
                  // biome-ignore lint/suspicious/noArrayIndexKey: steps are a fixed, unreordered list
                  <li key={i}>{step}</li>
                ))}
              </ol>
            )}

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

            {result.decremented.length === 0 && finishConfirmations.length === 0 && (
              <p class="empty-state">Nothing to update — everything used was a Staple.</p>
            )}

            {offers.length > 0 && (
              <div class="auto-relist-panel">
                <p class="auto-relist-title">Always re-add these when they run out?</p>
                {offers.map((offer) => (
                  <div class="auto-relist-row" key={offer.productId}>
                    <span>{offer.productName}</span>
                    <div class="auto-relist-actions">
                      <button type="button" onClick={() => decideOffer(offer.productId, true)}>
                        Yes
                      </button>
                      <button type="button" onClick={() => decideOffer(offer.productId, false)}>
                        No
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {finishConfirmations.length > 0 && (
              <div class="result-block">
                <h3>Nearly out — confirm finished</h3>
                {finishConfirmations.map((lot) => (
                  <button
                    type="button"
                    class="fc-row"
                    key={lot.lotId}
                    onClick={() => toggleChecked(lot.lotId)}
                  >
                    <span class="fc-check">{checked.has(lot.lotId) ? "✓" : ""}</span>
                    <span>{lot.productName}</span>
                  </button>
                ))}
                <div class="fc-bar">
                  <span>{checked.size} selected</span>
                  <button type="button" disabled={checked.size === 0 || confirming} onClick={confirmFinished}>
                    {confirming ? "Confirming…" : "Confirm finished"}
                  </button>
                </div>
              </div>
            )}

            {allResolved && (
              <div class="rate-block">
                {rating ? (
                  <>
                    <div class="rate-btns">
                      <button type="button" class={`rate-btn ${rating === "up" ? "picked" : ""}`} disabled>
                        👍
                      </button>
                      <button type="button" class={`rate-btn ${rating === "down" ? "picked" : ""}`} disabled>
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
    </div>
  );
}
