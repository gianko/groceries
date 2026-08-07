import { describe, expect, it } from "vitest";
import {
  filterLots,
  groupForDisplay,
  type InventoryLot,
  MESSAGE_LIMIT,
  renderInventory,
} from "../src/inventory.js";

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

describe("groupForDisplay", () => {
  it("splits by category, sorting food by soonest-expiry-then-name and household alphabetically", () => {
    const lots = [
      lot({ lotId: 1, productName: "Bread", category: "food", estExpiry: "2026-07-20" }),
      lot({ lotId: 2, productName: "Milk", category: "food", estExpiry: "2026-07-18" }),
      lot({ lotId: 3, productName: "Toilet roll", category: "household" }),
      lot({ lotId: 4, productName: "Bleach", category: "household" }),
    ];

    const sections = groupForDisplay(lots);

    expect(sections.food.map((l: InventoryLot) => l.lotId)).toEqual([2, 1]);
    expect(sections.household.map((l: InventoryLot) => l.lotId)).toEqual([4, 3]);
  });

  it("omits a category's key content when that category has no lots", () => {
    const lots = [lot({ lotId: 1, productName: "Milk", category: "food" })];

    const sections = groupForDisplay(lots);

    expect(sections.food).toHaveLength(1);
    expect(sections.household).toHaveLength(0);
  });
});

describe("filterLots", () => {
  const lots = [
    lot({ lotId: 1, productName: "Whole Milk" }),
    lot({ lotId: 2, productName: "Bread" }),
    lot({ lotId: 3, productName: "Oat milk" }),
  ];

  it("returns all lots when the query is empty or whitespace", () => {
    expect(filterLots(lots, "")).toEqual(lots);
    expect(filterLots(lots, "   ")).toEqual(lots);
  });

  it("matches product names case-insensitively as a substring", () => {
    expect(filterLots(lots, "milk").map((l) => l.lotId)).toEqual([1, 3]);
    expect(filterLots(lots, "MILK").map((l) => l.lotId)).toEqual([1, 3]);
  });

  it("matches on a substring anywhere in the name, not just a prefix", () => {
    expect(filterLots(lots, "read").map((l) => l.lotId)).toEqual([2]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterLots(lots, "xyz")).toEqual([]);
  });

  it("ignores leading/trailing whitespace in the query", () => {
    expect(filterLots(lots, "  bread  ").map((l) => l.lotId)).toEqual([2]);
  });
});
