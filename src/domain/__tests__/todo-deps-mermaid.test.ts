import { describe, it, expect } from "vitest";
import { buildTodoDepsMermaid } from "../todo-deps-mermaid";

describe("buildTodoDepsMermaid", () => {
  it("returns placeholder when empty", () => {
    const src = buildTodoDepsMermaid([], []);
    expect(src).toContain("graph TD");
    expect(src).toContain("no todos");
  });

  it("emits node lines, edges, and style per status", () => {
    const src = buildTodoDepsMermaid(
      [
        { id: "a", title: "A", description: null, status: "done", plan_id: "p" },
        { id: "b", title: "B", description: null, status: "in_progress", plan_id: "p" },
      ],
      [{ todo_id: "b", depends_on: "a" }],
    );
    expect(src).toMatch(/a\["A \(done\)"\]/);
    expect(src).toMatch(/b\["B \(in_progress\)"\]/);
    expect(src).toMatch(/a --> b/);
    expect(src).toMatch(/style a fill:#16a34a/);
    expect(src).toMatch(/style b fill:#eab308/);
  });

  it("sanitizes ids with special chars and escapes quotes in titles", () => {
    const src = buildTodoDepsMermaid(
      [
        { id: "a-1", title: 'has "quote"', description: null, status: "pending", plan_id: null },
      ],
      [],
    );
    expect(src).toContain("a_1");
    expect(src).toContain("&quot;quote&quot;");
  });

  it("skips edges referencing missing todos", () => {
    const src = buildTodoDepsMermaid(
      [{ id: "a", title: "A", description: null, status: "pending", plan_id: null }],
      [{ todo_id: "a", depends_on: "ghost" }],
    );
    expect(src).not.toContain("ghost");
    expect(src).not.toMatch(/ghost --> a/);
  });

  it("falls back to the pending color when status is unknown", () => {
    const src = buildTodoDepsMermaid(
      [{ id: "x", title: "X", description: null, status: "unknown" as never, plan_id: null }],
      [],
    );
    expect(src).toMatch(/style x fill:#6b7280/);
  });
});
