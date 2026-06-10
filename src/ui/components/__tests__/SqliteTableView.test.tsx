import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SqliteTableView, type SqliteTable, type SqliteTableData } from "../SqliteTableView";

describe("SqliteTableView", () => {
  const tables: SqliteTable[] = [
    { name: "todos", row_count: 12 },
    { name: "plans", row_count: 3 },
  ];
  const todosData: SqliteTableData = {
    columns: ["id", "title"],
    rows: [
      [1, "first"],
      [2, "second"],
      [3, null],
    ],
  };

  function ops(overrides: Partial<{ listTables: () => Promise<SqliteTable[]>; queryTable: (table: string, limit: number) => Promise<SqliteTableData> }> = {}) {
    return {
      listTables: vi.fn(async () => tables),
      queryTable: vi.fn(async () => todosData),
      ...overrides,
    };
  }

  it("renders the table list with row counts", async () => {
    render(<SqliteTableView ops={ops()} />);
    expect(await screen.findByText("todos")).toBeTruthy();
    expect(screen.getByText("plans")).toBeTruthy();
    expect(screen.getByText("12 rows")).toBeTruthy();
    expect(screen.getByText("3 rows")).toBeTruthy();
    cleanup();
  });

  it("loads a table's rows on click and renders columns + cells", async () => {
    render(<SqliteTableView ops={ops()} />);
    fireEvent.click(await screen.findByText("todos"));
    await waitFor(() => expect(screen.queryByText("first")).toBeTruthy());
    expect(screen.getByText("id")).toBeTruthy();
    expect(screen.getByText("title")).toBeTruthy();
    expect(screen.getByText("second")).toBeTruthy();
    expect(screen.getByText("null")).toBeTruthy();
    cleanup();
  });

  it("calls onSelectTable on selection and Back", async () => {
    const onSelectTable = vi.fn();
    render(<SqliteTableView ops={ops()} onSelectTable={onSelectTable} />);
    fireEvent.click(await screen.findByText("todos"));
    await waitFor(() => expect(onSelectTable).toHaveBeenCalledWith("todos"));
    fireEvent.click(screen.getByTestId("sqlite-back"));
    expect(onSelectTable).toHaveBeenLastCalledWith(null);
    cleanup();
  });

  it("auto-loads initialTable after the table list is fetched", async () => {
    const queryTable = vi.fn(async () => todosData);
    render(<SqliteTableView ops={ops({ queryTable })} initialTable="todos" />);
    await waitFor(() => expect(queryTable).toHaveBeenCalledWith("todos", 200));
    expect(await screen.findByText("first")).toBeTruthy();
    cleanup();
  });

  it("surfaces listTables errors", async () => {
    render(<SqliteTableView ops={ops({ listTables: vi.fn(async () => { throw new Error("not a db"); }) })} />);
    await waitFor(() => expect(screen.queryByText(/not a db/)).toBeTruthy());
    cleanup();
  });
});
