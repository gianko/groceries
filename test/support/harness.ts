import type { Bot, Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { BotDeps, PhotoDownloader } from "../../src/bot.js";
import { createBot } from "../../src/bot.js";
import type { Config } from "../../src/config.js";
import { createDb, type Db } from "../../src/db.js";
import { BrainFake } from "./brainFake.js";
import { FakeClock } from "./fakeClock.js";

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface TestHarness {
  bot: Bot;
  calls: ApiCall[];
  db: Db;
  clock: FakeClock;
  brain: BrainFake;
  handleUpdate: Bot["handleUpdate"];
}

export interface HarnessDeps {
  brain?: BrainFake;
  clock?: FakeClock;
  downloadPhoto?: PhotoDownloader;
}

const defaultPhoto = (): Promise<Buffer> => Promise.resolve(Buffer.from("fake-photo-bytes"));

const testBotInfo = {
  id: 1,
  is_bot: true,
  first_name: "Pantry Bot",
  username: "pantry_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
} as unknown as UserFromGetMe;

export function createTestHarness(config: Config, deps: HarnessDeps = {}): TestHarness {
  const db = createDb(":memory:");
  const clock = deps.clock ?? new FakeClock(new Date("2026-01-01T12:00:00Z"));
  const brain = deps.brain ?? new BrainFake();
  const botDeps: BotDeps = {
    brain,
    clock,
    downloadPhoto: deps.downloadPhoto ?? defaultPhoto,
  };
  const bot = createBot(config, db, botDeps, { botInfo: testBotInfo });
  const calls: ApiCall[] = [];

  let nextStubMessageId = 1000;
  const stubTransport: Transformer = (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });

    if (method === "sendMessage" || method === "sendPhoto") {
      const message = {
        message_id: nextStubMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: (payload as Record<string, unknown>).chat_id, type: "group" },
      };
      return Promise.resolve({ ok: true, result: message as never });
    }

    return Promise.resolve({ ok: true, result: true as never });
  };
  bot.api.config.use(stubTransport);

  return {
    bot,
    calls,
    db,
    clock,
    brain,
    handleUpdate: bot.handleUpdate.bind(bot),
  };
}
