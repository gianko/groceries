export interface Config {
  groqApiKey: string;
  tz: string;
  dbPath: string;
  heartbeatPath: string;
  heartbeatIntervalMs: number;
  heartbeatStaleMs: number;
  snapshotPath: string;
  snapshotCron: string;
  webAppUrl: string;
}

const REQUIRED_KEYS = ["GROQ_API_KEY", "TZ", "WEB_APP_URL"] as const;

const DEFAULT_DB_PATH = "pantry.db";
const DEFAULT_HEARTBEAT_PATH = "heartbeat";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_STALE_MS = 90_000;
const DEFAULT_SNAPSHOT_PATH = "pantry.snapshot.db";
const DEFAULT_SNAPSHOT_CRON = "0 3 * * *";

type EnvSource = Record<string, string | undefined>;

export function loadConfig(env: EnvSource = process.env): Config {
  const missing = REQUIRED_KEYS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env var(s): ${missing.join(", ")}`);
  }

  const heartbeatIntervalMs = env.HEARTBEAT_INTERVAL_MS
    ? parseInteger(env.HEARTBEAT_INTERVAL_MS, "HEARTBEAT_INTERVAL_MS")
    : DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatStaleMs = env.HEARTBEAT_STALE_MS
    ? parseInteger(env.HEARTBEAT_STALE_MS, "HEARTBEAT_STALE_MS")
    : DEFAULT_HEARTBEAT_STALE_MS;

  return {
    groqApiKey: env.GROQ_API_KEY!,
    tz: env.TZ!,
    dbPath: env.DB_PATH ?? DEFAULT_DB_PATH,
    heartbeatPath: env.HEARTBEAT_PATH ?? DEFAULT_HEARTBEAT_PATH,
    heartbeatIntervalMs,
    heartbeatStaleMs,
    snapshotPath: env.SNAPSHOT_PATH ?? DEFAULT_SNAPSHOT_PATH,
    snapshotCron: env.SNAPSHOT_CRON ?? DEFAULT_SNAPSHOT_CRON,
    webAppUrl: env.WEB_APP_URL!.replace(/\/+$/, ""),
  };
}

function parseInteger(raw: string, name: string): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`Invalid ${name}: "${raw}" is not an integer`);
  }
  return Number.parseInt(raw, 10);
}
