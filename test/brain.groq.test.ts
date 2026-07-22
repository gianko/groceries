import { describe, expect, it, vi } from "vitest";
import { GroqBrain, type GroqChatClient } from "../src/brain/groq.js";
import { BrainUnavailableError, type ChatTool, type ReceiptExtraction } from "../src/brain.js";

function jsonResponse(body: unknown) {
  return { choices: [{ message: { content: JSON.stringify(body) } }] };
}

const validExtraction: ReceiptExtraction = {
  lines: [
    { rawName: "T.FIN B/BEANS 420G", name: "baked beans", category: "food" as const, quantity: 1 },
  ],
};

function createBrain(client: GroqChatClient, sleepCalls: number[] = []): GroqBrain {
  return new GroqBrain(client, {
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
  });
}

describe("GroqBrain", () => {
  it("returns the parsed result on a clean first response", async () => {
    const createChatCompletion = vi.fn().mockResolvedValue(jsonResponse(validExtraction));
    const brain = createBrain({ createChatCompletion });

    const result = await brain.extractReceipt(Buffer.from("photo"), []);

    expect(result.lines).toHaveLength(1);
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("sends the receipt photo as an image_url data URI alongside the prompt", async () => {
    const createChatCompletion = vi.fn().mockResolvedValue(jsonResponse(validExtraction));
    const brain = createBrain({ createChatCompletion });

    await brain.extractReceipt(Buffer.from("photo-bytes"), []);

    const params = createChatCompletion.mock.calls[0]![0];
    const content = params.messages[0].content;
    expect(content[0]).toEqual({ type: "text", text: expect.any(String) });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${Buffer.from("photo-bytes").toString("base64")}` },
    });
    expect(params.response_format).toEqual({ type: "json_object" });
  });

  it("retries once on a parse failure and succeeds on the second attempt", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: "not json" } }] })
      .mockResolvedValueOnce(jsonResponse(validExtraction));
    const brain = createBrain({ createChatCompletion });

    const result = await brain.extractReceipt(Buffer.from("photo"), []);

    expect(result.lines).toHaveLength(1);
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("gives up with BrainUnavailableError after a parse failure survives the retry", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValue({ choices: [{ message: { content: "not json" } }] });
    const brain = createBrain({ createChatCompletion });

    await expect(brain.extractReceipt(Buffer.from("photo"), [])).rejects.toThrow(
      BrainUnavailableError,
    );
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("backs off with exponential delay on 429 and eventually succeeds", async () => {
    const sleepCalls: number[] = [];
    const createChatCompletion = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(validExtraction));
    const brain = createBrain({ createChatCompletion }, sleepCalls);

    const result = await brain.extractReceipt(Buffer.from("photo"), []);

    expect(result.lines).toHaveLength(1);
    expect(createChatCompletion).toHaveBeenCalledTimes(3);
    expect(sleepCalls).toEqual([500, 1500]);
  });

  it("backs off on 5xx and gives up with BrainUnavailableError once the backoff budget is exhausted", async () => {
    const sleepCalls: number[] = [];
    const createChatCompletion = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("server error"), { status: 503 }));
    const brain = createBrain({ createChatCompletion }, sleepCalls);

    await expect(brain.extractReceipt(Buffer.from("photo"), [])).rejects.toThrow(
      BrainUnavailableError,
    );
    expect(createChatCompletion).toHaveBeenCalledTimes(6);
    expect(sleepCalls).toEqual([500, 1500, 500, 1500]);
  });

  it("includes the Catalog name list in the extraction prompt", async () => {
    const createChatCompletion = vi.fn().mockResolvedValue(jsonResponse(validExtraction));
    const brain = createBrain({ createChatCompletion });

    await brain.extractReceipt(Buffer.from("photo"), ["baked beans", "milk"]);

    const content = createChatCompletion.mock.calls[0]![0].messages[0].content;
    const promptText = content[0].text as string;
    expect(promptText).toContain("baked beans");
    expect(promptText).toContain("milk");
  });

  it("estimateShelfLife returns the parsed estimates array", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValue(jsonResponse({ estimates: [{ name: "milk", days: 7 }] }));
    const brain = createBrain({ createChatCompletion });

    const result = await brain.estimateShelfLife(["milk"]);

    expect(result).toEqual([{ name: "milk", days: 7 }]);
  });

  it("parseFreeTextItems returns the parsed lines and includes the free text in a plain-string prompt", async () => {
    const parsed = {
      lines: [{ name: "baked beans", category: "food" as const, quantity: 2, unit: null }],
    };
    const createChatCompletion = vi.fn().mockResolvedValue(jsonResponse(parsed));
    const brain = createBrain({ createChatCompletion });

    const result = await brain.parseFreeTextItems("2 tins baked beans", ["milk"]);

    expect(result).toEqual(parsed);
    const promptText = createChatCompletion.mock.calls[0]![0].messages[0].content as string;
    expect(promptText).toContain("2 tins baked beans");
    expect(promptText).toContain("milk");
  });

  describe("converse", () => {
    const tools: ChatTool[] = [
      { name: "checkInventory", description: "Check pantry inventory", parameters: {} },
    ];

    it("returns a toolCall turn when Groq responds with a tool call", async () => {
      const createChatCompletion = vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_0",
                  type: "function",
                  function: {
                    name: "checkInventory",
                    arguments: JSON.stringify({ category: "food" }),
                  },
                },
              ],
            },
          },
        ],
      });
      const brain = createBrain({ createChatCompletion });

      const turn = await brain.converse([{ role: "user", text: "what's in the pantry?" }], tools);

      expect(turn).toEqual({
        role: "toolCall",
        call: { name: "checkInventory", args: { category: "food" } },
      });
    });

    it("returns a model text turn when Groq responds with plain text", async () => {
      const createChatCompletion = vi.fn().mockResolvedValue({
        choices: [{ message: { content: "You have plenty of pasta." } }],
      });
      const brain = createBrain({ createChatCompletion });

      const turn = await brain.converse([{ role: "user", text: "what's in the pantry?" }], tools);

      expect(turn).toEqual({ role: "model", text: "You have plenty of pasta." });
    });

    it("maps tool declarations and turn history into Groq's OpenAI-compatible shape", async () => {
      const createChatCompletion = vi.fn().mockResolvedValue({
        choices: [{ message: { content: "ok" } }],
      });
      const brain = createBrain({ createChatCompletion });

      await brain.converse(
        [
          { role: "user", text: "add milk" },
          { role: "toolCall", call: { name: "addToShoppingList", args: { name: "milk" } } },
          { role: "toolResult", name: "addToShoppingList", result: { added: true } },
        ],
        tools,
      );

      const params = createChatCompletion.mock.calls[0]![0];
      expect(params.tools).toEqual([
        {
          type: "function",
          function: {
            name: "checkInventory",
            description: "Check pantry inventory",
            parameters: {},
          },
        },
      ]);
      expect(params.messages[0]).toEqual({ role: "user", content: "add milk" });
      expect(params.messages[1].role).toBe("assistant");
      expect(params.messages[1].tool_calls[0].function).toEqual({
        name: "addToShoppingList",
        arguments: JSON.stringify({ name: "milk" }),
      });
      expect(params.messages[2]).toEqual({
        role: "tool",
        tool_call_id: params.messages[1].tool_calls[0].id,
        content: JSON.stringify({ added: true }),
      });
    });

    it("throws BrainUnavailableError on an empty response with no text and no tool call", async () => {
      const createChatCompletion = vi.fn().mockResolvedValue({ choices: [{ message: {} }] });
      const brain = createBrain({ createChatCompletion });

      await expect(brain.converse([{ role: "user", text: "hi" }], tools)).rejects.toThrow(
        BrainUnavailableError,
      );
    });

    it("throws BrainUnavailableError after the backoff budget is exhausted", async () => {
      const sleepCalls: number[] = [];
      const createChatCompletion = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("server error"), { status: 503 }));
      const brain = createBrain({ createChatCompletion }, sleepCalls);

      await expect(brain.converse([{ role: "user", text: "hi" }], tools)).rejects.toThrow(
        BrainUnavailableError,
      );
      expect(sleepCalls).toEqual([500, 1500]);
    });
  });
});
