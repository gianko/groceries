import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isHeartbeatFresh } from "../src/healthcheck.js";

describe("isHeartbeatFresh", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "healthcheck-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is fresh when the file's mtime is within the stale threshold", () => {
    const path = join(dir, "heartbeat");
    writeFileSync(path, "2026-01-01T12:00:00.000Z");

    expect(isHeartbeatFresh(path, 90_000, Date.now())).toBe(true);
  });

  it("is stale once the file's age exceeds the threshold", () => {
    const path = join(dir, "heartbeat");
    writeFileSync(path, "2026-01-01T12:00:00.000Z");

    const farFuture = Date.now() + 10 * 60_000;
    expect(isHeartbeatFresh(path, 90_000, farFuture)).toBe(false);
  });

  it("is unhealthy when the heartbeat file doesn't exist", () => {
    const path = join(dir, "missing-heartbeat");

    expect(isHeartbeatFresh(path, 90_000, Date.now())).toBe(false);
  });
});
