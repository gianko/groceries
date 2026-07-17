export interface Config {
  telegramBotToken: string;
  geminiApiKey: string;
  allowedUserIds: number[];
  groupChatId: number;
  tz: string;
}

const REQUIRED_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "GEMINI_API_KEY",
  "ALLOWED_USER_IDS",
  "GROUP_CHAT_ID",
  "TZ",
] as const;

type EnvSource = Record<string, string | undefined>;

export function loadConfig(env: EnvSource = process.env): Config {
  const missing = REQUIRED_KEYS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env var(s): ${missing.join(", ")}`);
  }

  const allowedUserIds = parseIntList(env.ALLOWED_USER_IDS!, "ALLOWED_USER_IDS");
  const groupChatId = parseInteger(env.GROUP_CHAT_ID!, "GROUP_CHAT_ID");

  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN!,
    geminiApiKey: env.GEMINI_API_KEY!,
    allowedUserIds,
    groupChatId,
    tz: env.TZ!,
  };
}

function parseIntList(raw: string, name: string): number[] {
  return raw.split(",").map((entry) => parseInteger(entry.trim(), name));
}

function parseInteger(raw: string, name: string): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`Invalid ${name}: "${raw}" is not an integer`);
  }
  return Number.parseInt(raw, 10);
}
