import { describe, expect, it } from "vitest";
import { MESSAGE_LIMIT, renderInventory, type InventoryLot } from "../src/inventory.js";

function lot(overrides: Partial<InventoryLot> & { lotId: number }): InventoryLot {
  return {
    productName: "Product",
    category: "food",
    quantity: 1,
    unit: null,
    estExpiry: null,
    ...overrides,
  };
}

describe("renderInventory", () => {
  it("returns a single message saying the pantry is empty when there are no lots", () => {
    expect(renderInventory([])).toEqual([{ text: "Pantry's empty.", lotIds: [] }]);
  });

  it("groups by category and sorts food by soonest expiry first", () => {
    const lots = [
      lot({ lotId: 1, productName: "Bread", category: "food", estExpiry: "2026-07-20" }),
      lot({ lotId: 2, productName: "Milk", category: "food", estExpiry: "2026-07-18" }),
      lot({ lotId: 3, productName: "Toilet roll", category: "household" }),
    ];

    const chunks = renderInventory(lots);

    expect(chunks).toHaveLength(1);
    const [chunk] = chunks;
    const foodIndex = chunk!.text.indexOf("FOOD");
    const milkIndex = chunk!.text.indexOf("Milk");
    const breadIndex = chunk!.text.indexOf("Bread");
    const householdIndex = chunk!.text.indexOf("HOUSEHOLD");

    expect(foodIndex).toBeGreaterThanOrEqual(0);
    expect(milkIndex).toBeLessThan(breadIndex);
    expect(breadIndex).toBeLessThan(householdIndex);
    expect(chunk!.lotIds).toEqual([2, 1, 3]);
  });

  it("sorts food lots with no expiry after lots that have one", () => {
    const lots = [
      lot({ lotId: 1, productName: "Rice", category: "food", estExpiry: null }),
      lot({ lotId: 2, productName: "Milk", category: "food", estExpiry: "2026-07-18" }),
    ];

    const chunks = renderInventory(lots);

    expect(chunks[0]!.lotIds).toEqual([2, 1]);
  });

  it("omits a category header entirely when that category has no lots", () => {
    const lots = [lot({ lotId: 1, productName: "Milk", category: "food" })];

    const [chunk] = renderInventory(lots);

    expect(chunk!.text).not.toContain("HOUSEHOLD");
  });

  it("splits into consecutive messages, none exceeding the Telegram limit", () => {
    const lots = Array.from({ length: 400 }, (_, i) =>
      lot({
        lotId: i,
        productName: `Product number ${i} with a moderately long descriptive name`,
        category: "food",
        estExpiry: "2026-07-20",
      }),
    );

    const chunks = renderInventory(lots);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    }

    const allLotIds = chunks.flatMap((chunk) => chunk.lotIds);
    expect(allLotIds).toHaveLength(400);
    expect(new Set(allLotIds).size).toBe(400);
  });

  it("caps a single implausibly long line so it never exceeds the limit on its own", () => {
    const lots = [
      lot({ lotId: 1, productName: "x".repeat(MESSAGE_LIMIT + 500), category: "food" }),
    ];

    const chunks = renderInventory(lots);

    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    }
    expect(chunks.flatMap((c) => c.lotIds)).toEqual([1]);
  });
});
