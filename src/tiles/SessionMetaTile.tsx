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
  CheckCircleIcon,
  ClockIcon,
  FolderIcon,
  TableCellsIcon,
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

interface SessionTodoEntry {
  id: string;
  title: string;
  description: string | null;
  status: string;
}

const CATEGORY_META: Record<string, CategoryMeta> = {
  skill: { label: "Skills", icon: SparklesIcon, color: "#f9e2af" },
  extension: { label: "Extensions", icon: PuzzlePieceIcon, color: "#89b4fa" },
  agent: { label: "Agents", icon: UserGroupIcon, color: "#a6e3a1" },
  mcp_server: { label: "MCP Servers", icon: ServerIcon, color: "#cba6f7" },
  instruction: { label: "Instructions", icon: DocumentTextIcon, color: "#fab387" },
  plugin: { label: "Plugins", icon: CubeIcon, color: "#94e2d5" },
};

const CATEGORY_ORDER = ["skill", "extension", "agent", "mcp_server", "instruction", "plugin"];

type TabId = "config" | "files" | "todos";

const STATUS_COLORS: Record<string, string> = {
  done: "#a6e3a1",
  in_progress: "#89b4fa",
  pending: "#585b70",
  blocked: "#f38ba8",
};

const SKIP_PREFIXES = [".git/", ".git\\", "node_modules/", "node_modules\\"];
const SKIP_PATTERNS = [/[/\\]\.git[/\\]/, /[/\\]node_modules[/\\]/];

function isRelevantFile(filePath: string): boolean {
  for (const prefix of SKIP_PREFIXES) {
    if (filePath.startsWith(prefix)) return false;
  }
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(filePath)) return false;
  }
  // Skip session-state internal files
  if (filePath.includes(".copilot/session-state/") || filePath.includes(".copilot\\session-state\\")) return false;
  return true;
}

export default function SessionMetaTile({ tileId: _tileId, isFocused: _isFocused, workstreamDir, linkedSessionIds }: Props) {
  const backend = useBackend();
  const [items, setItems] = useState<CopilotConfigItem[]>([]);
  const [files, setFiles] = useState<SessionFileEntry[]>([]);
  const [todos, setTodos] = useState<SessionTodoEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<TabId>("config");

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await backend.discoverCopilotConfig(workstreamDir);
      setItems(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [backend, workstreamDir]);

  const loadSessionData = useCallback(async () => {
    if (!linkedSessionIds || linkedSessionIds.length === 0) {
      setFiles([]);
      setTodos([]);
      return;
    }
    // Aggregate files and todos from all linked sessions
    const allFiles: SessionFileEntry[] = [];
    const allTodos: SessionTodoEntry[] = [];
    for (const sid of linkedSessionIds) {
      try {
        const f = await invoke<SessionFileEntry[]>("query_session_files", { sessionId: sid });
        allFiles.push(...f);
      } catch { /* ignore */ }
      try {
        const t = await invoke<SessionTodoEntry[]>("query_session_todos", { sessionId: sid });
        allTodos.push(...t);
      } catch { /* ignore */ }
    }
    setFiles(allFiles.filter((f) => isRelevantFile(f.file_path)));
    setTodos(allTodos);
  }, [linkedSessionIds]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    loadSessionData();
  }, [loadSessionData]);

  const refresh = useCallback(() => {
    loadConfig();
    loadSessionData();
  }, [loadConfig, loadSessionData]);

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
    { id: "todos", label: "Todos", icon: TableCellsIcon, count: todos.length },
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
                  <DocumentIcon style={{ width: 12, height: 12, color: f.tool_name === "create" ? "#a6e3a1" : "#89b4fa", flexShrink: 0 }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {fileName}
                  </span>
                  <span style={{ color: "#585b70", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    {dirPath}
                  </span>
                  {f.tool_name && (
                    <span
                      style={{
                        fontSize: 9,
                        padding: "1px 4px",
                        borderRadius: 3,
                        background: "#313244",
                        color: f.tool_name === "create" ? "#a6e3a1" : "#89b4fa",
                        flexShrink: 0,
                      }}
                    >
                      {f.tool_name}
                    </span>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* Todos tab */}
        {activeTab === "todos" && (
          <>
            {(!linkedSessionIds || linkedSessionIds.length === 0) && (
              <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>
                No linked sessions — link a copilot session to see its todos
              </div>
            )}
            {linkedSessionIds && linkedSessionIds.length > 0 && todos.length === 0 && (
              <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>
                No todos found in linked sessions
              </div>
            )}
            {todos.map((t) => {
              const statusColor = STATUS_COLORS[t.status] || "#585b70";
              const StatusIcon = t.status === "done" ? CheckCircleIcon : ClockIcon;
              return (
                <div
                  key={t.id}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 6,
                    padding: "4px 8px",
                    color: "#cdd6f4",
                  }}
                  title={t.description || undefined}
                >
                  <StatusIcon style={{ width: 14, height: 14, color: statusColor, flexShrink: 0, marginTop: 1 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: t.status === "done" ? "#585b70" : "#cdd6f4",
                      textDecoration: t.status === "done" ? "line-through" : "none",
                    }}>
                      {t.title}
                    </div>
                    {t.description && (
                      <div style={{
                        fontSize: 10,
                        color: "#585b70",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}>
                        {t.description}
                      </div>
                    )}
                  </div>
                  <span
                    style={{
                      fontSize: 9,
                      padding: "1px 4px",
                      borderRadius: 3,
                      background: "#313244",
                      color: statusColor,
                      flexShrink: 0,
                    }}
                  >
                    {t.status}
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
