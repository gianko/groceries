import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHeartbeat, touchHeartbeat } from "../src/heartbeat.js";
import { FakeClock } from "./support/fakeClock.js";

describe("touchHeartbeat", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "heartbeat-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the clock's current time to the heartbeat file", () => {
    const path = join(dir, "heartbeat");
    const clock = new FakeClock(new Date("2026-01-01T12:00:00.000Z"));

    touchHeartbeat(path, clock);

    expect(readFileSync(path, "utf8")).toBe("2026-01-01T12:00:00.000Z");
  });

  it("overwrites a stale heartbeat on each touch", () => {
    const path = join(dir, "heartbeat");
    const clock = new FakeClock(new Date("2026-01-01T12:00:00.000Z"));

    touchHeartbeat(path, clock);
    clock.advance(30_000);
    touchHeartbeat(path, clock);

    expect(readFileSync(path, "utf8")).toBe("2026-01-01T12:00:30.000Z");
  });
});

describe("startHeartbeat", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "heartbeat-test-"));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("touches immediately and again on every interval tick", () => {
    const path = join(dir, "heartbeat");
    const clock = new FakeClock(new Date("2026-01-01T12:00:00.000Z"));

    const stop = startHeartbeat(path, 30_000, clock);

    expect(readFileSync(path, "utf8")).toBe("2026-01-01T12:00:00.000Z");

    clock.advance(30_000);
    vi.advanceTimersByTime(30_000);
    expect(readFileSync(path, "utf8")).toBe("2026-01-01T12:00:30.000Z");

    stop();
    clock.advance(30_000);
    vi.advanceTimersByTime(30_000);
    expect(readFileSync(path, "utf8")).toBe("2026-01-01T12:00:30.000Z");
  });
});
