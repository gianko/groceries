import { actions } from "astro:actions";
import { useState } from "preact/hooks";
import type { ChatTurn } from "../../../src/brain.js";
import type { CookRecipe, CookSuggestions, FinishConfirmationLot } from "../../../src/cook.js";
import FinishChecklist from "./FinishChecklist";
import RecipeCard from "./RecipeCard";

type Attachment =
  | { type: "recipe"; recipe: CookRecipe }
  | { type: "confirmCook"; recipe: CookRecipe }
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

interface Props {
  // Whatever Cook-tonight/Almost-there tiers CookScreen already loaded on
  // mount, or null while that's still loading/unavailable — the
  // suggestRecipes tool reuses this instead of a fresh Brain call unless the
  // user's message states a constraint it wasn't computed against (#50).
  loadedSuggestions: CookSuggestions | null;
  onOpenRecipe: (recipe: CookRecipe) => void;
}

// Collapsed by default behind a floating affordance, per #50 — history lives
// only in this component's state, so it resets on every page load.
export default function ChatPane({ loadedSuggestions, onOpenRecipe }: Props) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);

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
    const { data, error } = await actions.cook.chatSend({
      history,
      message: text,
      loadedSuggestions,
    });
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
    <>
      {!open && (
        <button
          type="button"
          class="chat-fab"
          onClick={() => setOpen(true)}
          aria-label="Open cook agent chat"
        >
          💬
        </button>
      )}

      {open && (
        <div class="chat-pane">
          <div class="chat-header">
            <span>Cook agent</span>
            <button
              type="button"
              class="chat-close"
              onClick={() => setOpen(false)}
              aria-label="Close cook agent chat"
            >
              ✕
            </button>
          </div>

          <div class="chat-log">
            {messages.length === 0 && (
              <p class="empty-state">
                Ask what to cook, what's in stock or expiring, or your favorites.
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
                          <RecipeCard recipe={attachment.recipe} showMissing onOpen={onOpenRecipe} />
                        </li>
                      </ul>
                    )}
                    {attachment.type === "confirmCook" && (
                      <button
                        type="button"
                        class="primary-btn"
                        disabled={sending}
                        onClick={confirmCook}
                      >
                        {sending ? "Cooking…" : `Confirm cook "${attachment.recipe.title}"`}
                      </button>
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
                awaitingConfirm ? "Confirm the cook above to continue…" : "Message the cook agent…"
              }
              onInput={(e) => setInput((e.target as HTMLInputElement).value)}
            />
            <button type="submit" disabled={sending || awaitingConfirm || input.trim().length === 0}>
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}
