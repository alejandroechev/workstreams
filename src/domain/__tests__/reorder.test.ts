import { describe, it, expect } from "vitest";
import { moveItem, reorderById } from "../reorder";

describe("moveItem", () => {
  const xs = ["a", "b", "c", "d"];
  it("moves an item forward", () => {
    expect(moveItem(xs, 0, 2)).toEqual(["b", "c", "a", "d"]);
  });
  it("moves an item backward", () => {
    expect(moveItem(xs, 3, 1)).toEqual(["a", "d", "b", "c"]);
  });
  it("no-op when from === to", () => {
    expect(moveItem(xs, 1, 1)).toBe(xs);
  });
  it("clamps target beyond bounds", () => {
    expect(moveItem(xs, 0, 99)).toEqual(["b", "c", "d", "a"]);
    expect(moveItem(xs, 3, -5)).toEqual(["d", "a", "b", "c"]);
  });
  it("returns the original ref if from is out of bounds", () => {
    expect(moveItem(xs, 99, 1)).toBe(xs);
    expect(moveItem(xs, -1, 1)).toBe(xs);
  });
});

describe("reorderById", () => {
  const list = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
    { id: "d", name: "D" },
  ];

  it("moves the dragged id to the target id's slot (forward)", () => {
    expect(reorderById(list, "a", "c").map((w) => w.id)).toEqual(["b", "c", "a", "d"]);
  });
  it("moves the dragged id to the target id's slot (backward)", () => {
    expect(reorderById(list, "d", "b").map((w) => w.id)).toEqual(["a", "d", "b", "c"]);
  });
  it("returns the same reference when dragging onto itself", () => {
    expect(reorderById(list, "b", "b")).toBe(list);
  });
  it("returns the same reference when ids are missing", () => {
    expect(reorderById(list, "missing", "a")).toBe(list);
    expect(reorderById(list, "a", "missing")).toBe(list);
  });
});
