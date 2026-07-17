import type { Database } from "better-sqlite3";
import type { Bot, Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { createBot } from "../../src/bot.js";
import type { Config } from "../../src/config.js";
import { createDb } from "../../src/db.js";
import { FakeClock } from "./fakeClock.js";

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface TestHarness {
  bot: Bot;
  calls: ApiCall[];
  db: Database;
  clock: FakeClock;
  handleUpdate: Bot["handleUpdate"];
}

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

export function createTestHarness(config: Config): TestHarness {
  const bot = createBot(config, { botInfo: testBotInfo });
  const calls: ApiCall[] = [];

  const stubTransport: Transformer = (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return Promise.resolve({ ok: true, result: true as never });
  };
  bot.api.config.use(stubTransport);

  const db = createDb(":memory:");
  const clock = new FakeClock(new Date("2026-01-01T12:00:00Z"));

  return {
    bot,
    calls,
    db,
    clock,
    handleUpdate: bot.handleUpdate.bind(bot),
  };
}
