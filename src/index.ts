import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";

const config = loadConfig();
const db = createDb(process.env.DB_PATH ?? "pantry.db");
const bot = createBot(config, db);

bot.start({
  onStart: (botInfo) => {
    console.log(`Pantry Bot online as @${botInfo.username}`);
  },
});
