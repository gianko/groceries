import { Api } from "grammy";
import { getConfig } from "./webDb.js";

let api: Api | undefined;

function getApi(): Api {
  api ??= new Api(getConfig().telegramBotToken);
  return api;
}

// Fire-and-forget group echo per #28/#30: the DB write (already committed by
// the caller) is the source of truth, not the Telegram send, so a failure
// here is only logged, never surfaced to or blocking the Mini App user.
export function sendGroupEcho(text: string): void {
  getApi()
    .sendMessage(getConfig().groupChatId, text)
    .catch((err) => {
      console.error("shopping echo failed:", err);
    });
}
