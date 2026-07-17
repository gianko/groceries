import { statSync } from "node:fs";
import { loadConfig } from "./config.js";

export function isHeartbeatFresh(path: string, staleMs: number, nowMs: number): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return false;
  }
  return nowMs - mtimeMs <= staleMs;
}

// Docker HEALTHCHECK entry point: run standalone via `node dist/healthcheck.js`,
// exit 0/1 per the Docker healthcheck contract.
function main(): void {
  const config = loadConfig();
  process.exit(isHeartbeatFresh(config.heartbeatPath, config.heartbeatStaleMs, Date.now()) ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
