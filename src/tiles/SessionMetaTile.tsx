import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useBackend } from "../backend/context";
import type { CopilotConfigItem } from "../domain/types";
import {
  SparklesIcon,
  PuzzlePieceIcon,
  UserGroupIcon,
  ServerIcon,
  DocumentTextIcon,
  CubeIcon,
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DocumentIcon,
  FolderIcon,
  TableCellsIcon,
  BoltIcon,
} from "@heroicons/react/24/outline";

interface Props {
  tileId: string;
  isFocused: boolean;
  workstreamDir?: string;
  linkedSessionIds?: string[];
}

interface CategoryMeta {
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  color: string;
}

interface SessionFileEntry {
  file_path: string;
  tool_name: string | null;
  turn_index: number | null;
}

interface GitHookEntry {
  name: string;
  path: string;
  content_preview: string;
}

const CATEGORY_META: Record<string, CategoryMeta> = {
  skill: { label: "Skills", icon: SparklesIcon, color: "#f9e2af" },
  extension: { label: "Extensions", icon: PuzzlePieceIcon, color: "#89b4fa" },
  agent: { label: "Agents", icon: UserGroupIcon, color: "#a6e3a1" },
  mcp_server: { label: "MCP Servers", icon: ServerIcon, color: "#cba6f7" },
  instruction: { label: "Instructions", icon: DocumentTextIcon, color: "#fab387" },
  plugin: { label: "Plugins", icon: CubeIcon, color: "#94e2d5" },
  git_hook: { label: "Git Hooks", icon: BoltIcon, color: "#f5c2e7" },
};

const CATEGORY_ORDER = ["skill", "extension", "agent", "mcp_server", "instruction", "git_hook"];

type TabId = "config" | "files" | "database";

interface SessionDbTable {
  name: string;
  row_count: number;
}

interface SessionDbTableData {
  columns: string[];
  rows: unknown[][];
}

const SKIP_PREFIXES = [".git/", ".git\\", "node_modules/", "node_modules\\"];
const SKIP_PATTERNS = [/[/\\]\.git[/\\]/, /[/\\]node_modules[/\\]/];

function isRelevantFile(filePath: string): boolean {
  for (const prefix of SKIP_PREFIXES) {
    if (filePath.startsWith(prefix)) return false;
  }
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(filePath)) return false;
  }
  if (filePath.includes(".copilot/session-state/") || filePath.includes(".copilot\\session-state\\")) return false;
  return true;
}

export default function SessionMetaTile({ tileId: _tileId, isFocused: _isFocused, workstreamDir, linkedSessionIds }: Props) {
  const backend = useBackend();
  const [items, setItems] = useState<CopilotConfigItem[]>([]);
  const [files, setFiles] = useState<SessionFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<TabId>("config");
  // Config content viewer
  const [viewingContent, setViewingContent] = useState<{ name: string; content: string } | null>(null);
  // File viewer
  const [viewingFile, setViewingFile] = useState<{ path: string; content: string } | null>(null);
  // Database explorer
  const [dbTables, setDbTables] = useState<SessionDbTable[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableData, setTableData] = useState<SessionDbTableData | null>(null);
  const [dbLoading, setDbLoading] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await backend.discoverCopilotConfig(workstreamDir);
      // Also load git hooks if we have a workstream directory
      if (workstreamDir) {
        try {
          const hooks = await invoke<GitHookEntry[]>("list_git_hooks", { directory: workstreamDir });
          const hookItems: CopilotConfigItem[] = hooks.map((h) => ({
            name: h.name,
            category: "git_hook",
            source: "repo",
            path: h.path,
            description: h.content_preview,
          }));
          setItems([...result, ...hookItems]);
        } catch {
          setItems(result);
        }
      } else {
        setItems(result);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [backend, workstreamDir]);

  const loadSessionData = useCallback(async () => {
    if (!linkedSessionIds || linkedSessionIds.length === 0) {
      setFiles([]);
      return;
    }
    const allFiles: SessionFileEntry[] = [];
    for (const sid of linkedSessionIds) {
      try {
        const f = await invoke<SessionFileEntry[]>("query_session_files", { sessionId: sid });
        allFiles.push(...f);
      } catch { /* ignore */ }
    }
    setFiles(allFiles);
  }, [linkedSessionIds]);

  const loadDbTables = useCallback(async () => {
    if (!linkedSessionIds || linkedSessionIds.length === 0) {
      setDbTables([]);
      return;
    }
    setDbLoading(true);
    const allTables: SessionDbTable[] = [];
    for (const sid of linkedSessionIds) {
      try {
        const tables = await invoke<SessionDbTable[]>("list_session_db_tables", { sessionId: sid });
        allTables.push(...tables);
      } catch { /* ignore */ }
    }
    setDbTables(allTables);
    setDbLoading(false);
  }, [linkedSessionIds]);

  const loadTableData = useCallback(async (tableName: string) => {
    if (!linkedSessionIds || linkedSessionIds.length === 0) return;
    setDbLoading(true);
    setSelectedTable(tableName);
    // Use first linked session that has this table
    for (const sid of linkedSessionIds) {
      try {
        const data = await invoke<SessionDbTableData>("query_session_db_table", { sessionId: sid, tableName, limit: 200 });
        setTableData(data);
        setDbLoading(false);
        return;
      } catch { /* ignore */ }
    }
    setTableData(null);
    setDbLoading(false);
  }, [linkedSessionIds]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    loadSessionData();
  }, [loadSessionData]);

  useEffect(() => {
    if (activeTab === "database") loadDbTables();
  }, [activeTab, loadDbTables]);

  const refresh = useCallback(() => {
    loadConfig();
    loadSessionData();
    if (activeTab === "database") loadDbTables();
  }, [loadConfig, loadSessionData, loadDbTables, activeTab]);

  const toggleCategory = (cat: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const grouped = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    items: items.filter((i) => i.category === cat),
  })).filter((g) => g.items.length > 0);

  // Deduplicate files by path (keep first occurrence)
  const uniqueFiles = files.reduce<SessionFileEntry[]>((acc, f) => {
    if (!acc.some((e) => e.file_path === f.file_path)) acc.push(f);
    return acc;
  }, []);

  const tabs: { id: TabId; label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement>>; count: number }[] = [
    { id: "config", label: "Config", icon: SparklesIcon, count: items.length },
    { id: "files", label: "Files", icon: FolderIcon, count: uniqueFiles.length },
    { id: "database", label: "Database", icon: TableCellsIcon, count: dbTables.reduce((s, t) => s + t.row_count, 0) },
  ];

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "#1e1e2e",
        color: "#cdd6f4",
        fontFamily: "monospace",
        fontSize: 12,
      }}
    >
      {/* Toolbar with tabs */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 4px",
          background: "#181825",
          borderBottom: "1px solid #313244",
          flexShrink: 0,
        }}
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "6px 10px",
                background: "none",
                border: "none",
                borderBottom: activeTab === tab.id ? "2px solid #89b4fa" : "2px solid transparent",
                color: activeTab === tab.id ? "#cdd6f4" : "#585b70",
                cursor: "pointer",
                fontSize: 11,
                fontFamily: "monospace",
              }}
            >
              <Icon style={{ width: 12, height: 12 }} />
              {tab.label}
              {tab.count > 0 && (
                <span style={{ color: "#585b70", fontSize: 10 }}>({tab.count})</span>
              )}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <button
          onClick={refresh}
          style={{
            background: "none",
            border: "none",
            color: "#585b70",
            cursor: "pointer",
            padding: "2px 4px",
            display: "flex",
            alignItems: "center",
          }}
          title="Refresh"
        >
          <ArrowPathIcon style={{ width: 14, height: 14 }} />
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: "4px 0" }}>
        {loading && activeTab === "config" && (
          <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>
            Scanning…
          </div>
        )}
        {error && activeTab === "config" && (
          <div style={{ padding: 12, color: "#f38ba8", textAlign: "center" }}>
            {error}
          </div>
        )}

        {/* Config tab */}
        {activeTab === "config" && !loading && !error && grouped.length === 0 && (
          <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>
            No configuration found
          </div>
        )}
        {activeTab === "config" && !loading &&
          grouped.map(({ category, items: catItems }) => {
            const meta = CATEGORY_META[category] || {
              label: category,
              icon: DocumentTextIcon,
              color: "#a6adc8",
            };
            const Icon = meta.icon;
            const isCollapsed = collapsed.has(category);

            return (
              <div key={category}>
                <button
                  onClick={() => toggleCategory(category)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    width: "100%",
                    padding: "4px 8px",
                    background: "none",
                    border: "none",
                    color: meta.color,
                    cursor: "pointer",
                    fontSize: 11,
                    fontFamily: "monospace",
                    fontWeight: 600,
                    textAlign: "left",
                  }}
                >
                  {isCollapsed ? (
                    <ChevronRightIcon style={{ width: 12, height: 12 }} />
                  ) : (
                    <ChevronDownIcon style={{ width: 12, height: 12 }} />
                  )}
                  <Icon style={{ width: 14, height: 14 }} />
                  {meta.label}
                  <span style={{ color: "#585b70", fontWeight: 400 }}>
                    ({catItems.length})
                  </span>
                </button>

                {!isCollapsed &&
                  catItems.map((item, idx) => (
                    <div
                      key={`${item.name}-${idx}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "3px 8px 3px 28px",
                        color: "#cdd6f4",
                      }}
                      title={item.path}
                    >
                      <Icon style={{ width: 12, height: 12, color: "#585b70", flexShrink: 0 }} />
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.name}
                      </span>
                      <span
                        style={{
                          fontSize: 9,
                          padding: "1px 4px",
                          borderRadius: 3,
                          background: item.source === "repo" ? "#313244" : "#1e1e2e",
                          border: "1px solid #313244",
                          color: item.source === "repo" ? "#89b4fa" : "#585b70",
                          flexShrink: 0,
                        }}
                      >
                        {item.source}
                      </span>
                      {item.description && (
                        <span
                          style={{
                            color: "#585b70",
                            fontSize: 10,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: 150,
                            flexShrink: 1,
                          }}
                          title={item.description}
                        >
                          {item.description}
                        </span>
                      )}
                    </div>
                  ))}
              </div>
            );
          })}

        {/* Files tab */}
        {activeTab === "files" && (
          <>
            {(!linkedSessionIds || linkedSessionIds.length === 0) && (
              <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>
                No linked sessions — link a copilot session to see its files
              </div>
            )}
            {linkedSessionIds && linkedSessionIds.length > 0 && uniqueFiles.length === 0 && (
              <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>
                No files found in linked sessions
              </div>
            )}
            {uniqueFiles.map((f, i) => {
              const fileName = f.file_path.split(/[/\\]/).pop() || f.file_path;
              const dirPath = f.file_path.substring(0, f.file_path.length - fileName.length);
              return (
                <div
                  key={`${f.file_path}-${i}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "3px 8px",
                    color: "#cdd6f4",
                  }}
                  title={f.file_path}
                >
                  <DocumentIcon style={{ width: 12, height: 12, color: "#89b4fa", flexShrink: 0 }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {fileName}
                  </span>
                  {f.tool_name && (
                    <span style={{ color: "#585b70", fontSize: 10, flexShrink: 0 }}>
                      {f.tool_name}
                    </span>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* Database tab */}
        {activeTab === "database" && (
          <>
            {(!linkedSessionIds || linkedSessionIds.length === 0) && (
              <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>
                No linked sessions — link a copilot session to explore its database
              </div>
            )}
            {dbLoading && (
              <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>Loading…</div>
            )}
            {!dbLoading && !selectedTable && linkedSessionIds && linkedSessionIds.length > 0 && (
              <>
                {dbTables.length === 0 && (
                  <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>
                    No session database found
                  </div>
                )}
                {dbTables.map((t) => (
                  <div
                    key={t.name}
                    onClick={() => loadTableData(t.name)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 12px",
                      cursor: "pointer",
                      color: "#cdd6f4",
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                  >
                    <TableCellsIcon style={{ width: 14, height: 14, color: "#89b4fa", flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>{t.name}</span>
                    <span style={{ fontSize: 10, color: "#585b70" }}>{t.row_count} rows</span>
                  </div>
                ))}
              </>
            )}
            {!dbLoading && selectedTable && tableData && (
              <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderBottom: "1px solid #313244", flexShrink: 0 }}>
                  <button
                    onClick={() => { setSelectedTable(null); setTableData(null); }}
                    style={{ background: "none", border: "none", color: "#89b4fa", cursor: "pointer", fontSize: 11, padding: "2px 4px" }}
                  >← Tables</button>
                  <span style={{ color: "#cdd6f4", fontWeight: 600, fontSize: 11 }}>{selectedTable}</span>
                  <span style={{ color: "#585b70", fontSize: 10 }}>({tableData.rows.length} rows)</span>
                </div>
                <div style={{ flex: 1, overflow: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "monospace" }}>
                    <thead>
                      <tr>
                        {tableData.columns.map((col) => (
                          <th key={col} style={{ padding: "4px 6px", borderBottom: "1px solid #313244", color: "#89b4fa", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap", position: "sticky", top: 0, background: "#181825" }}>
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tableData.rows.map((row, ri) => (
                        <tr key={ri} style={{ borderBottom: "1px solid #1e1e2e" }}>
                          {row.map((val, ci) => (
                            <td key={ci} style={{ padding: "3px 6px", color: "#cdd6f4", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={val != null ? String(val) : ""}>
                              {val === null ? <span style={{ color: "#585b70" }}>null</span> : String(val)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
