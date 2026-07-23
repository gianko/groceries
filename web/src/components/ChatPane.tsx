import { actions } from "astro:actions";
import { useState } from "preact/hooks";
import type { ChatTurn } from "../../../src/brain.js";
import {
  type CookMeal,
  type CookRecipe,
  type FinishConfirmationLot,
  mealTitle,
} from "../../../src/cook.js";
import FinishChecklist from "./FinishChecklist";
import MealModal from "./MealModal";
import RecipeCard from "./RecipeCard";
import RecipeModal from "./RecipeModal";

type Attachment =
  | { type: "recipe"; recipe: CookRecipe }
  | { type: "confirmCook"; meal: CookMeal }
  | { type: "finishChecklist"; recipeId: number; lots: FinishConfirmationLot[] };

interface AgentResult {
  history: ChatTurn[];
  reply: string;
  attachments: Attachment[];
}

interface DisplayMessage {
  role: "user" | "agent";
  text: string;
  attachments: Attachment[];
}

// The whole /cook screen: a full-page chat, no auto-loaded suggestions and
// no floating-sheet toggle — asking the agent is the only way in. History
// lives only in this component's state, so it resets on every page load.
export default function ChatPane() {
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  const [openRecipe, setOpenRecipe] = useState<CookRecipe | null>(null);
  const [openMeal, setOpenMeal] = useState<CookMeal | null>(null);

  function applyResult(data: AgentResult) {
    setHistory(data.history);
    setMessages((prev) => [
      ...prev,
      { role: "agent", text: data.reply, attachments: data.attachments },
    ]);
    setAwaitingConfirm(data.attachments.some((a) => a.type === "confirmCook"));
  }

  async function submitMessage(e: Event) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending || awaitingConfirm) {
      return;
    }
    setInput("");
    setMessages((prev) => [...prev, { role: "user", text, attachments: [] }]);
    setSending(true);
    const { data, error } = await actions.cook.chatSend({ history, message: text });
    setSending(false);
    if (error || !data) {
      setMessages((prev) => [
        ...prev,
        { role: "agent", text: "🧠 Something went wrong — try again.", attachments: [] },
      ]);
      return;
    }
    applyResult(data);
  }

  async function confirmCook() {
    if (sending) {
      return;
    }
    setSending(true);
    const { data, error } = await actions.cook.chatConfirm({ history });
    setSending(false);
    setAwaitingConfirm(false);
    setOpenMeal(null);
    if (error || !data) {
      setMessages((prev) => [
        ...prev,
        { role: "agent", text: "🧠 Couldn't confirm that — try again.", attachments: [] },
      ]);
      return;
    }
    applyResult(data);
  }

  return (
    <div class="chat-screen">
      <div class="chat-log">
        {messages.length === 0 && (
          <p class="empty-state">
            Ask what to cook — "what can I make for lunch for 2?" or "a full meal with a side
            tonight."
          </p>
        )}
        {messages.map((msg, i) => (
          <div class={`chat-msg ${msg.role}`} key={i}>
            <div class="chat-bubble">{msg.text}</div>
            {msg.attachments.map((attachment, j) => (
              <div class="chat-attachment" key={j}>
                {attachment.type === "recipe" && (
                  <ul class="recipe-list">
                    <li>
                      <RecipeCard recipe={attachment.recipe} showMissing onOpen={setOpenRecipe} />
                    </li>
                  </ul>
                )}
                {attachment.type === "confirmCook" && (
                  <ul class="recipe-list">
                    <li>
                      <button
                        type="button"
                        class="recipe-row"
                        onClick={() => setOpenMeal(attachment.meal)}
                      >
                        <span class="recipe-icon">🍽️</span>
                        <span class="recipe-main">
                          <span class="recipe-title">{mealTitle(attachment.meal)}</span>
                          <span class="recipe-sub">Tap to review and confirm</span>
                        </span>
                        <span class="recipe-chev">→</span>
                      </button>
                    </li>
                  </ul>
                )}
                {attachment.type === "finishChecklist" && (
                  <FinishChecklist lots={attachment.lots} />
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      <form class="chat-input-bar" onSubmit={submitMessage}>
        <input
          type="text"
          value={input}
          disabled={sending || awaitingConfirm}
          placeholder={
            awaitingConfirm ? "Confirm the cook above to continue…" : "Ask the cook agent…"
          }
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
        />
        <button
          type="submit"
          disabled={sending || awaitingConfirm || input.trim().length === 0}
          aria-label="Send"
        >
          ↑
        </button>
      </form>

      {openRecipe && <RecipeModal recipe={openRecipe} onClose={() => setOpenRecipe(null)} />}
      {openMeal && (
        <MealModal
          meal={openMeal}
          sending={sending}
          onConfirm={confirmCook}
          onClose={() => setOpenMeal(null)}
        />
      )}
    </div>
  );
}
