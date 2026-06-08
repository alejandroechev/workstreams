import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TableCellsIcon } from "@heroicons/react/24/outline";

export interface SqliteTable {
  name: string;
  row_count: number;
}

export interface SqliteTableData {
  columns: string[];
  rows: Array<Array<unknown>>;
}

interface FetchOps {
  listTables: () => Promise<SqliteTable[]>;
  queryTable: (table: string, limit: number) => Promise<SqliteTableData>;
}

interface Props {
  ops: FetchOps;
  /** Optional starting table — restored from persisted view state. */
  initialTable?: string | null;
  /** Notifies parent when the user selects/clears a table (for persistence). */
  onSelectTable?: (table: string | null) => void;
  /** Page size cap for SELECT. Defaults to 200. */
  limit?: number;
}

/**
 * Read-only SQLite browser: shows the table list with row counts, then a
 * paged grid of the selected table's rows. Used by both SessionMetaTile
 * (against a session.db via list_session_db_tables) and Repo Explorer
 * (against an arbitrary .db file via list_db_tables).
 */
export function SqliteTableView({ ops, initialTable = null, onSelectTable, limit = 200 }: Props) {
  const [tables, setTables] = useState<SqliteTable[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(initialTable);
  const [tableData, setTableData] = useState<SqliteTableData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh ops reference each call — re-fetch tables when the underlying
  // data source changes (e.g. user opens a different .db file).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void ops.listTables()
      .then((t) => { if (!cancelled) setTables(t); })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ops]);

  const loadTable = useCallback(async (name: string) => {
    setLoading(true);
    setError(null);
    setSelectedTable(name);
    onSelectTable?.(name);
    try {
      const data = await ops.queryTable(name, limit);
      setTableData(data);
    } catch (e) {
      setError(String(e));
      setTableData(null);
    } finally {
      setLoading(false);
    }
  }, [ops, limit, onSelectTable]);

  // Auto-load initial table once tables are listed.
  useEffect(() => {
    if (!selectedTable) return;
    if (tableData) return;
    if (tables.length === 0) return;
    if (!tables.some((t) => t.name === selectedTable)) return;
    void loadTable(selectedTable);
  }, [selectedTable, tableData, tables, loadTable]);

  const handleBack = () => {
    setSelectedTable(null);
    setTableData(null);
    onSelectTable?.(null);
  };

  if (loading && !tableData && tables.length === 0) {
    return <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>Loading…</div>;
  }
  if (error && !tableData && tables.length === 0) {
    return <div style={{ padding: 12, color: "#f38ba8", fontSize: 11 }}>{error}</div>;
  }

  if (!selectedTable) {
    if (tables.length === 0) {
      return <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>No tables found</div>;
    }
    return (
      <>
        {tables.map((t) => (
          <div
            key={t.name}
            data-testid="sqlite-table-row"
            onClick={() => loadTable(t.name)}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", cursor: "pointer", color: "#cdd6f4" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          >
            <TableCellsIcon style={{ width: 14, height: 14, color: "#89b4fa", flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{t.name}</span>
            <span style={{ fontSize: 10, color: "#585b70" }}>{t.row_count} rows</span>
          </div>
        ))}
      </>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderBottom: "1px solid #313244", flexShrink: 0 }}>
        <button
          data-testid="sqlite-back"
          onClick={handleBack}
          style={{ background: "none", border: "none", color: "#89b4fa", cursor: "pointer", fontSize: 11, padding: "2px 4px" }}
        >← Tables</button>
        <span style={{ color: "#cdd6f4", fontWeight: 600, fontSize: 11 }}>{selectedTable}</span>
        {tableData && (
          <span style={{ color: "#585b70", fontSize: 10 }}>({tableData.rows.length} rows)</span>
        )}
        {loading && (
          <span style={{ color: "#585b70", fontSize: 10 }}>Loading…</span>
        )}
        {error && (
          <span style={{ color: "#f38ba8", fontSize: 10 }}>{error}</span>
        )}
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {tableData && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "monospace" }}>
            <thead>
              <tr>
                {tableData.columns.map((col) => (
                  <th
                    key={col}
                    style={{ padding: "4px 6px", borderBottom: "1px solid #313244", color: "#89b4fa", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap", position: "sticky", top: 0, background: "#181825" }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableData.rows.map((row, ri) => (
                <tr key={ri} style={{ borderBottom: "1px solid #1e1e2e" }}>
                  {row.map((val, ci) => (
                    <td
                      key={ci}
                      style={{ padding: "3px 6px", color: "#cdd6f4", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={val != null ? String(val) : ""}
                    >
                      {val === null ? <span style={{ color: "#585b70" }}>null</span> : String(val)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** Factory: ops bound to an absolute file path (Repo Explorer use case). */
export function fileSqliteOps(path: string): FetchOps {
  return {
    listTables: () => invoke<SqliteTable[]>("list_db_tables", { path }),
    queryTable: (table, limit) => invoke<SqliteTableData>("query_db_table", {
      path, tableName: table, limit,
    }),
  };
}

/** Factory: ops bound to a Copilot session id (SessionMetaTile use case). */
export function sessionSqliteOps(sessionIds: string[]): FetchOps {
  return {
    listTables: async () => {
      const all: SqliteTable[] = [];
      for (const sid of sessionIds) {
        try {
          const t = await invoke<SqliteTable[]>("list_session_db_tables", { sessionId: sid });
          all.push(...t);
        } catch { /* ignore */ }
      }
      return all;
    },
    queryTable: async (table, limit) => {
      for (const sid of sessionIds) {
        try {
          return await invoke<SqliteTableData>("query_session_db_table", {
            sessionId: sid, tableName: table, limit,
          });
        } catch { /* try next */ }
      }
      throw new Error(`Table ${table} not found in any linked session`);
    },
  };
}
