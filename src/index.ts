import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const bot = createBot(config);

bot.start({
  onStart: (botInfo) => {
    console.log(`Pantry Bot online as @${botInfo.username}`);
  },
});
