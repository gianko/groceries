import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { schema } from "./db/schema.js";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

// migrationsFolder defaults to a path relative to this source file, which
// only holds up when each module keeps its original relative position on
// disk (true for the bot's tsc output, one compiled file per source file).
// A bundler that rolls multiple modules into one chunk (e.g. the Mini
// App's Vite/Astro build, per #25) moves this file to an arbitrary depth,
// so that caller passes an explicit absolute path instead.
export function createDb(
  filename: string = ":memory:",
  migrationsFolder = defaultMigrationsFolder,
): Db {
  const sqlite = new Database(filename);
  if (filename !== ":memory:") {
    sqlite.pragma("journal_mode = WAL");
  }

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}
