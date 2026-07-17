import Database from "better-sqlite3";

export function createDb(filename: string = ":memory:"): Database.Database {
  const db = new Database(filename);
  if (filename !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  return db;
}
