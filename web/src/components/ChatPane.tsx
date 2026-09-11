import { actions } from "astro:actions";
import { useEffect, useState } from "preact/hooks";
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
  // The server-rendered markup is on screen and tappable before Preact
  // hydrates it. Until then the form has no submit handler, so a tap on send
  // submits it natively — /cook reloads and the message vanishes — and text
  // typed into the input sits in the DOM without ever reaching `input`, so
  // the first real send would post an empty message. Keep the bar disabled
  // until this effect runs, which is the first moment the handlers are live.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  const inputDisabled = !hydrated || sending || awaitingConfirm;

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
    if (!text || !hydrated || sending || awaitingConfirm) {
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
            {msg.text && <div class="chat-bubble">{msg.text}</div>}
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
        {sending && (
          <div class="chat-msg agent">
            <div class="chat-bubble typing-bubble">
              <span class="typing-dot" />
              <span class="typing-dot" />
              <span class="typing-dot" />
            </div>
          </div>
        )}
      </div>

      <form class="chat-input-bar" onSubmit={submitMessage}>
        <input
          type="text"
          value={input}
          disabled={inputDisabled}
          placeholder={
            !hydrated
              ? "Starting up…"
              : awaitingConfirm
                ? "Confirm the cook above to continue…"
                : "Ask the cook agent…"
          }
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
        />
        <button
          type="submit"
          disabled={inputDisabled || input.trim().length === 0}
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
