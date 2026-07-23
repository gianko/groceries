import { useState } from "preact/hooks";
import {
  type CookMeal,
  mealIngredients,
  mealInstructionSections,
  mealTitle,
} from "../../../src/cook.js";
import { fmtQty } from "../lib/format";

interface Props {
  meal: CookMeal;
  sending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

// The combined ingredient list and step-by-step instructions for a meal the
// agent proposed cooking (main, optionally plus a side) — tap the compact
// card in the chat to open this, same tap-to-expand pattern as a suggested
// dish's RecipeModal, then confirm from here.
export default function MealModal({ meal, sending, onConfirm, onClose }: Props) {
  const [tab, setTab] = useState<"ingredients" | "steps">("ingredients");
  const sections = mealInstructionSections(meal);

  return (
    <div class="modal-overlay">
      <div class="modal-header">
        <button type="button" class="modal-back" onClick={onClose} aria-label="Close">
          ←
        </button>
        <span class="modal-title">{mealTitle(meal)}</span>
      </div>
      <div class="modal-body">
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
            {mealIngredients(meal).map((ingredient) => (
              <div class="ing-row" key={ingredient.name}>
                <span class={`ing-dot ${ingredient.present ? "" : "missing"}`} />
                <span class="ing-name">{ingredient.name}</span>
                <span class="ing-qty">{fmtQty(ingredient.quantity, ingredient.unit)}</span>
              </div>
            ))}
          </div>
        ) : sections === null ? (
          <p class="steps-empty">Instructions weren't saved for this recipe.</p>
        ) : (
          <div>
            {sections.map((section) => (
              <div class="steps-section" key={section.label ?? "steps"}>
                {section.label && <h3 class="steps-section-title">{section.label}</h3>}
                <ol class="steps-list">
                  {section.steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
      </div>

      <div class="modal-footer">
        <button type="button" class="primary-btn" disabled={sending} onClick={onConfirm}>
          {sending ? "Cooking…" : "Confirm cook"}
        </button>
      </div>
    </div>
  );
}
