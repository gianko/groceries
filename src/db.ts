import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { schema } from "./db/schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export function createDb(filename: string = ":memory:"): Db {
  const sqlite = new Database(filename);
  if (filename !== ":memory:") {
    sqlite.pragma("journal_mode = WAL");
  }

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}
