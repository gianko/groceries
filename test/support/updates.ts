import type { Chat, InlineKeyboardMarkup, Message, PhotoSize, Update, User } from "grammy/types";

let nextUpdateId = 1;
let nextMessageId = 1;
let nextCallbackQueryId = 1;

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
      entities: options.text.startsWith("/")
        ? [{ type: "bot_command", offset: 0, length: options.text.split(" ")[0]!.length }]
        : undefined,
    },
  };
}

export interface PhotoMessageOptions {
  userId: number;
  chatId: number;
  caption?: string;
  replyToBotMessageId?: number;
  botUserId?: number;
  username?: string;
}

const fakePhotoSizes: PhotoSize[] = [
  { file_id: "small-file-id", file_unique_id: "small-unique", width: 90, height: 90 },
  { file_id: "large-file-id", file_unique_id: "large-unique", width: 1280, height: 1280 },
];

export function photoMessageUpdate(options: PhotoMessageOptions): Update {
  const from: User = {
    id: options.userId,
    is_bot: false,
    first_name: "Test",
    username: options.username ?? "test_user",
  };

  const chat: Chat = { id: options.chatId, type: "group", title: "Household" };

  const replyToMessage: Message["reply_to_message"] =
    options.replyToBotMessageId !== undefined
      ? {
          message_id: options.replyToBotMessageId,
          date: Math.floor(Date.now() / 1000),
          chat,
          from: {
            id: options.botUserId ?? 1,
            is_bot: true,
            first_name: "Pantry Bot",
            username: "pantry_bot",
          },
          text: "🧾 Parsed receipt:",
          reply_to_message: undefined,
        }
      : undefined;

  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat,
      from,
      photo: fakePhotoSizes,
      caption: options.caption,
      reply_to_message: replyToMessage,
    },
  };
}

export interface CallbackQueryOptions {
  userId: number;
  chatId: number;
  data: string;
  messageId: number;
  replyMarkup?: InlineKeyboardMarkup;
  username?: string;
}

export function callbackQueryUpdate(options: CallbackQueryOptions): Update {
  const from: User = {
    id: options.userId,
    is_bot: false,
    first_name: "Test",
    username: options.username ?? "test_user",
  };

  const chat: Chat = { id: options.chatId, type: "group", title: "Household" };

  const message: Message = {
    message_id: options.messageId,
    date: Math.floor(Date.now() / 1000),
    chat,
    text: "placeholder",
    reply_markup: options.replyMarkup,
  };

  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: String(nextCallbackQueryId++),
      from,
      chat_instance: String(options.chatId),
      data: options.data,
      message,
    },
  };
}
