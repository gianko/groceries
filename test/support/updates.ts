import type { Chat, Update, User } from "grammy/types";

let nextUpdateId = 1;
let nextMessageId = 1;

export interface TextMessageOptions {
  userId: number;
  chatId: number;
  text: string;
  chatType?: "group" | "supergroup" | "private";
  username?: string;
}

export function textMessageUpdate(options: TextMessageOptions): Update {
  const chatType = options.chatType ?? "group";

  const from: User = {
    id: options.userId,
    is_bot: false,
    first_name: "Test",
    username: options.username ?? "test_user",
  };

  const chat: Chat =
    chatType === "private"
      ? { id: options.chatId, type: "private", first_name: from.first_name }
      : chatType === "supergroup"
        ? { id: options.chatId, type: "supergroup", title: "Household" }
        : { id: options.chatId, type: "group", title: "Household" };

  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat,
      from,
      text: options.text,
      entities:
        options.text.startsWith("/")
          ? [{ type: "bot_command", offset: 0, length: options.text.split(" ")[0]!.length }]
          : undefined,
    },
  };
}
