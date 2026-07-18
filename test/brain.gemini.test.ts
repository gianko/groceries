import { describe, expect, it, vi } from "vitest";
import { GeminiBrain, type GeminiModelsClient } from "../src/brain/gemini.js";
import { BrainUnavailableError } from "../src/brain.js";

function jsonResponse(body: unknown): { text: string } {
  return { text: JSON.stringify(body) };
}

const validExtraction = {
  lines: [{ rawName: "T.FIN B/BEANS 420G", name: "baked beans", category: "food", quantity: 1 }],
};

function createBrain(models: GeminiModelsClient, sleepCalls: number[] = []): GeminiBrain {
  return new GeminiBrain(models, {
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
  });
}

describe("GeminiBrain", () => {
  it("returns the parsed result on a clean first response", async () => {
    const generateContent = vi.fn().mockResolvedValue(jsonResponse(validExtraction));
    const brain = createBrain({ generateContent });

    const result = await brain.extractReceipt(Buffer.from("photo"));

    expect(result.lines).toHaveLength(1);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("retries once on a parse failure and succeeds on the second attempt", async () => {
    const generateContent = vi
      .fn()
      .mockResolvedValueOnce({ text: "not json" })
      .mockResolvedValueOnce(jsonResponse(validExtraction));
    const brain = createBrain({ generateContent });

    const result = await brain.extractReceipt(Buffer.from("photo"));

    expect(result.lines).toHaveLength(1);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("gives up with BrainUnavailableError after a parse failure survives the retry", async () => {
    const generateContent = vi.fn().mockResolvedValue({ text: "not json" });
    const brain = createBrain({ generateContent });

    await expect(brain.extractReceipt(Buffer.from("photo"))).rejects.toThrow(BrainUnavailableError);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("backs off with exponential delay on 429 and eventually succeeds", async () => {
    const sleepCalls: number[] = [];
    const generateContent = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(validExtraction));
    const brain = createBrain({ generateContent }, sleepCalls);

    const result = await brain.extractReceipt(Buffer.from("photo"));

    expect(result.lines).toHaveLength(1);
    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(sleepCalls).toEqual([500, 1500]);
  });

  it("backs off on 5xx and gives up with BrainUnavailableError once the backoff budget is exhausted", async () => {
    const sleepCalls: number[] = [];
    const generateContent = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("server error"), { status: 503 }));
    const brain = createBrain({ generateContent }, sleepCalls);

    await expect(brain.extractReceipt(Buffer.from("photo"))).rejects.toThrow(BrainUnavailableError);
    // 2 outer parse-retry attempts, each backing off through 3 raw calls
    // (initial + 2 retries) before giving up on that attempt.
    expect(generateContent).toHaveBeenCalledTimes(6);
    expect(sleepCalls).toEqual([500, 1500, 500, 1500]);
  });

  it("does not back off on a non-retryable error, but still allows the outer parse retry", async () => {
    const sleepCalls: number[] = [];
    const generateContent = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("bad request"), { status: 400 }))
      .mockResolvedValueOnce(jsonResponse(validExtraction));
    const brain = createBrain({ generateContent }, sleepCalls);

    const result = await brain.extractReceipt(Buffer.from("photo"));

    expect(result.lines).toHaveLength(1);
    expect(sleepCalls).toEqual([]);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("estimateShelfLife returns the parsed estimates array", async () => {
    const generateContent = vi
      .fn()
      .mockResolvedValue(jsonResponse({ estimates: [{ name: "milk", days: 7 }] }));
    const brain = createBrain({ generateContent });

    const result = await brain.estimateShelfLife(["milk"]);

    expect(result).toEqual([{ name: "milk", days: 7 }]);
  });
});
