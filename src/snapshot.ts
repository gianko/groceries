import { existsSync, unlinkSync } from "node:fs";
import type Database from "better-sqlite3";
import cron from "node-cron";

// VACUUM INTO copies committed pages only, so the snapshot can never
// capture a mid-write state — the backup routine reads this file, never the
// live one.
export function snapshotDatabase(sqlite: Database.Database, snapshotPath: string): void {
  sqlite.prepare("VACUUM INTO ?").run(snapshotPath);
}

// VACUUM INTO refuses to write over an existing file, but the nightly job
// reuses one path every night — drop last night's snapshot first so the
// backup routine always finds exactly the latest one.
export function replaceSnapshot(sqlite: Database.Database, snapshotPath: string): void {
  if (existsSync(snapshotPath)) {
    unlinkSync(snapshotPath);
  }
  snapshotDatabase(sqlite, snapshotPath);
}

export function scheduleSnapshot(
  cronExpression: string,
  tz: string,
  fn: () => void,
): ReturnType<typeof cron.schedule> {
  return cron.schedule(cronExpression, fn, { timezone: tz });
}

// A cron failure must never crash the bot process — a missed snapshot is
// recoverable tomorrow night, but a dead poll loop isn't.
export function scheduleNightlySnapshot(
  sqlite: Database.Database,
  snapshotPath: string,
  cronExpression: string,
  tz: string,
): ReturnType<typeof cron.schedule> {
  return scheduleSnapshot(cronExpression, tz, () => {
    try {
      replaceSnapshot(sqlite, snapshotPath);
    } catch (err) {
      console.error("Nightly snapshot failed", err);
    }
  });
}
