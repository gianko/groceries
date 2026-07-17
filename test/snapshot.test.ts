import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSnapshot, scheduleNightlySnapshot, snapshotDatabase } from "../src/snapshot.js";

describe("snapshotDatabase", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "snapshot-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a VACUUM INTO copy holding the live data, leaving the live file untouched", () => {
    const livePath = join(dir, "live.db");
    const snapshotPath = join(dir, "snapshot.db");
    const live = new Database(livePath);
    live.exec("CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT)");
    live.prepare("INSERT INTO products (name) VALUES (?)").run("baked beans");

    snapshotDatabase(live, snapshotPath);

    expect(existsSync(snapshotPath)).toBe(true);
    const snapshot = new Database(snapshotPath, { readonly: true });
    expect(snapshot.prepare("SELECT name FROM products").all()).toEqual([{ name: "baked beans" }]);
    snapshot.close();

    // The live connection is still the source: a write after snapshotting
    // never touches the file VACUUM INTO already produced.
    live.prepare("INSERT INTO products (name) VALUES (?)").run("chopped tomatoes");
    const snapshotAfter = new Database(snapshotPath, { readonly: true });
    expect(snapshotAfter.prepare("SELECT name FROM products").all()).toEqual([
      { name: "baked beans" },
    ]);
    snapshotAfter.close();

    live.close();
  });

  it("throws rather than overwriting an existing snapshot file", () => {
    const livePath = join(dir, "live.db");
    const snapshotPath = join(dir, "snapshot.db");
    const live = new Database(livePath);
    live.exec("CREATE TABLE t (id INTEGER)");

    snapshotDatabase(live, snapshotPath);

    expect(() => snapshotDatabase(live, snapshotPath)).toThrow();

    live.close();
  });
});

describe("replaceSnapshot", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "snapshot-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("overwrites the prior night's snapshot instead of throwing", () => {
    const livePath = join(dir, "live.db");
    const snapshotPath = join(dir, "snapshot.db");
    const live = new Database(livePath);
    live.exec("CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT)");
    live.prepare("INSERT INTO products (name) VALUES (?)").run("baked beans");

    replaceSnapshot(live, snapshotPath);
    live.prepare("INSERT INTO products (name) VALUES (?)").run("chopped tomatoes");
    replaceSnapshot(live, snapshotPath);

    const snapshot = new Database(snapshotPath, { readonly: true });
    expect(snapshot.prepare("SELECT name FROM products ORDER BY id").all()).toEqual([
      { name: "baked beans" },
      { name: "chopped tomatoes" },
    ]);
    snapshot.close();

    live.close();
  });
});

describe("scheduleSnapshot", () => {
  it("registers the cron expression with node-cron and runs the callback on fire", async () => {
    const { default: cron } = await import("node-cron");
    const scheduleSpy = vi.spyOn(cron, "schedule");
    const { scheduleSnapshot } = await import("../src/snapshot.js");
    const fn = vi.fn();

    const task = scheduleSnapshot("0 3 * * *", "Europe/Dublin", fn);

    expect(scheduleSpy).toHaveBeenCalledWith("0 3 * * *", fn, { timezone: "Europe/Dublin" });
    task.stop();
    scheduleSpy.mockRestore();
  });
});

describe("scheduleNightlySnapshot", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "snapshot-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("swallows a snapshot failure instead of crashing the process", async () => {
    const livePath = join(dir, "live.db");
    const snapshotPath = join(dir, "does-not-exist-dir", "snapshot.db");
    const live = new Database(livePath);
    live.exec("CREATE TABLE t (id INTEGER)");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { default: cron } = await import("node-cron");
    const scheduleSpy = vi.spyOn(cron, "schedule");

    scheduleNightlySnapshot(live, snapshotPath, "0 3 * * *", "Europe/Dublin");
    const fired = scheduleSpy.mock.calls[0]?.[1] as () => void;
    expect(() => fired()).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith("Nightly snapshot failed", expect.anything());

    errorSpy.mockRestore();
    scheduleSpy.mockRestore();
    live.close();
  });
});
