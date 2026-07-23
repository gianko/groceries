import type { CookRecipe } from "../../../src/cook.js";

interface Props {
  recipe: CookRecipe;
  icon?: string;
  showMissing?: boolean;
  onOpen: (recipe: CookRecipe) => void;
}

// The one tappable recipe row for a suggested dish surfaced in the cook
// agent's chat — tapping opens its detail view (RecipeModal).
export default function RecipeCard({ recipe, icon = "🍽️", showMissing = false, onOpen }: Props) {
  const missing = showMissing ? recipe.ingredients.filter((i) => !i.present) : [];

  return (
    <button type="button" class="recipe-row" onClick={() => onOpen(recipe)}>
      <span class="recipe-icon">{icon}</span>
      <span class="recipe-main">
        <span class="recipe-title">{recipe.title}</span>
        {showMissing && missing.length > 0 && (
          <span class="recipe-sub">{missing.map((i) => i.name).join(", ")}</span>
        )}
      </span>
      {showMissing && missing.length > 0 ? (
        <span class="tag missing">missing {missing.length}</span>
      ) : (
        <span class="recipe-chev">→</span>
      )}
    </button>
  );
}
