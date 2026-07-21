import { describe, expect, it } from "vitest";
import { createFakeBrain } from "../src/brain/fake.js";
import type { ChatTool, ChatTurn } from "../src/brain.js";
import { BrainUnavailableError } from "../src/brain.js";

const tools: ChatTool[] = [
  { name: "checkInventory", description: "Check pantry inventory", parameters: {} },
];

describe("FakeBrain.converse", () => {
  it("returns scripted turns one at a time, advancing on each call", async () => {
    const toolCallTurn: ChatTurn = {
      role: "toolCall",
      call: { name: "checkInventory", args: { category: "food" } },
    };
    const finalTurn: ChatTurn = { role: "model", text: "You have plenty of pasta." };
    const brain = createFakeBrain({ scriptedConversation: [toolCallTurn, finalTurn] });

    const first = await brain.converse([{ role: "user", text: "what's in the pantry?" }], tools);
    expect(first).toEqual(toolCallTurn);

    const second = await brain.converse(
      [
        { role: "user", text: "what's in the pantry?" },
        toolCallTurn,
        { role: "toolResult", name: "checkInventory", result: { items: ["pasta"] } },
      ],
      tools,
    );
    expect(second).toEqual(finalTurn);
  });

  it("extracts the tool name and arguments from a scripted tool call turn", async () => {
    const call = { name: "addToShoppingList", args: { ingredients: ["milk", "eggs"] } };
    const brain = createFakeBrain({ scriptedConversation: [{ role: "toolCall", call }] });

    const turn = await brain.converse([{ role: "user", text: "add milk and eggs" }], tools);

    expect(turn.role).toBe("toolCall");
    expect(turn).toMatchObject({ role: "toolCall", call });
  });

  it("throws BrainUnavailableError once the scripted conversation is exhausted", async () => {
    const brain = createFakeBrain({
      scriptedConversation: [{ role: "model", text: "done" }],
    });

    await brain.converse([{ role: "user", text: "hi" }], tools);

    await expect(brain.converse([{ role: "user", text: "and then?" }], tools)).rejects.toThrow(
      BrainUnavailableError,
    );
  });

  it("defaults to an empty script and throws immediately when none is provided", async () => {
    const brain = createFakeBrain();

    await expect(brain.converse([{ role: "user", text: "hi" }], tools)).rejects.toThrow(
      BrainUnavailableError,
    );
  });
});
