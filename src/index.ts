import { createBot } from "./bot.js";
import { createGeminiBrain } from "./brain/gemini.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { startHeartbeat } from "./heartbeat.js";
import { scheduleNightlySnapshot } from "./snapshot.js";

const config = loadConfig();
const db = createDb(config.dbPath);
const brain = createGeminiBrain(config.geminiApiKey);
const bot = createBot(config, db, { brain });

startHeartbeat(config.heartbeatPath, config.heartbeatIntervalMs);
scheduleNightlySnapshot(db.$client, config.snapshotPath, config.snapshotCron, config.tz);

bot.start({
  onStart: (botInfo) => {
    console.log(`Pantry Bot online as @${botInfo.username}`);
  },
});
