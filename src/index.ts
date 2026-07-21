import { createBot } from "./bot.js";
import { createFakeBrain } from "./brain/fake.js";
import { createGeminiBrain } from "./brain/gemini.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { startHeartbeat } from "./heartbeat.js";
import { scheduleNightlySnapshot } from "./snapshot.js";

const config = loadConfig();
const db = createDb(config.dbPath);
if (process.env.FAKE_GEMINI === "1") {
  console.warn("[FakeBrain] FAKE_GEMINI=1 — using canned Brain responses, not calling Gemini");
}
const brain =
  process.env.FAKE_GEMINI === "1" ? createFakeBrain() : createGeminiBrain(config.geminiApiKey);
const bot = createBot(config, db, { brain });

startHeartbeat(config.heartbeatPath, config.heartbeatIntervalMs);
scheduleNightlySnapshot(db.$client, config.snapshotPath, config.snapshotCron, config.tz);

bot.start({
  onStart: (botInfo) => {
    console.log(`Pantry Bot online as @${botInfo.username}`);
  },
});
