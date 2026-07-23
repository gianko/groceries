import { actions } from "astro:actions";
import { useState } from "preact/hooks";
import type {
  CookIngredient,
  CookRecipe,
  DecrementedLot,
  FinishConfirmationLot,
} from "../../../src/cook.js";
import { fmtQty } from "../lib/format";
import { useToast } from "../lib/toast";
import FinishChecklist from "./FinishChecklist";

function missingOf(recipe: CookRecipe): CookIngredient[] {
  return recipe.ingredients.filter((i) => !i.present);
}

interface CookResult {
  recipeId: number;
  decremented: DecrementedLot[];
  finishConfirmations: FinishConfirmationLot[];
}

// The detail view for a single suggested/favorite dish — tap a recipe card
// to open this, cook it directly (no chat round-trip needed), and rate it
// once everything's resolved.
export default function RecipeModal({
  recipe,
  onClose,
}: {
  recipe: CookRecipe;
  onClose: () => void;
}) {
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
                Instructions
              </button>
            </div>

            {tab === "ingredients" ? (
              <div>
                {recipe.ingredients.map((ingredient) => (
                  <div class="ing-row" key={ingredient.name}>
                    <span class={`ing-dot ${ingredient.present ? "" : "missing"}`} />
                    <span class="ing-name">{ingredient.name}</span>
                    <span class="ing-qty">{fmtQty(ingredient.quantity, ingredient.unit)}</span>
                  </div>
                ))}
              </div>
            ) : recipe.instructions === null ? (
              <p class="steps-empty">Instructions weren't saved for this recipe.</p>
            ) : (
              <p class="steps-text">{recipe.instructions}</p>
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
