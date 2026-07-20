import { resolve } from "node:path";
import { createGeminiBrain } from "../../../src/brain/gemini.js";
import type { Brain } from "../../../src/brain.js";
import type { Config } from "../../../src/config.js";
import { loadConfig } from "../../../src/config.js";
import type { Db } from "../../../src/db.js";
import { createDb } from "../../../src/db.js";

// createDb's default migrations path is relative to db.ts's own location,
// which the Astro/Vite build bundles into a chunk at an arbitrary depth —
// resolve from cwd instead (the Mini App server always runs from the repo
// root locally, or /app in the Docker image, per Dockerfile.web).
const MIGRATIONS_FOLDER = resolve(process.cwd(), "drizzle");

// Direct DB access via shared code, per #25 — no API layer between the Mini
// App server and the bot's own db.ts/domain functions.
let db: Db | undefined;
let config: Config | undefined;
let brain: Brain | undefined;

export function getConfig(): Config {
  config ??= loadConfig();
  return config;
}

export function getDb(): Db {
  db ??= createDb(getConfig().dbPath, MIGRATIONS_FOLDER);
  return db;
}

export function getBrain(): Brain {
  brain ??= createGeminiBrain(getConfig().geminiApiKey);
  return brain;
}
