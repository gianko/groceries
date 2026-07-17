import { writeFileSync } from "node:fs";
import { type Clock, systemClock } from "./clock.js";

export function touchHeartbeat(path: string, clock: Clock = systemClock): void {
  writeFileSync(path, clock.now().toISOString());
}

// Runs independently of the Telegram poll loop: if the process wedges (event
// loop blocked, crashed), this interval stops firing along with everything
// else, and the Docker healthcheck sees a stale file.
export function startHeartbeat(
  path: string,
  intervalMs: number,
  clock: Clock = systemClock,
): () => void {
  touchHeartbeat(path, clock);
  const timer = setInterval(() => touchHeartbeat(path, clock), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
