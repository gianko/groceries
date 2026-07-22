// Shared retry policy for any Brain implementation: exponential backoff on
// 429/5xx, provider-agnostic since it only inspects the error's HTTP status.
export const BACKOFF_DELAYS_MS = [500, 1500];

export async function withBackoff<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableError(err) || attempt >= BACKOFF_DELAYS_MS.length) {
        throw err;
      }
      await sleep(BACKOFF_DELAYS_MS[attempt]!);
    }
  }
}

function isRetryableError(err: unknown): boolean {
  const status = extractStatus(err);
  return status === 429 || (status !== undefined && status >= 500 && status < 600);
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const candidate = err as { status?: unknown; code?: unknown; message?: unknown };
  if (typeof candidate.status === "number") {
    return candidate.status;
  }
  if (typeof candidate.code === "number") {
    return candidate.code;
  }
  if (typeof candidate.message === "string") {
    const match = candidate.message.match(/\b(429|5\d{2})\b/);
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
