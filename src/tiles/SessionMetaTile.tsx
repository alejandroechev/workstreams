// @test-skip: pre-existing tile shell, domain logic tested separately
import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MarkdownView } from "../ui/MarkdownView";
import { dirnameOf } from "../domain/file-types";
import { useBackend } from "../backend/context";
import { makeAudioBlobUrl } from "../domain/file-types";
import { FileEditorView } from "../files/FileEditorView";
import type { BufferSnapshot } from "../files/FileBufferRegistry";
import AudioPlayer from "./AudioPlayer";
import { dispatchAddToWorkbench } from "../domain/workbench-events";
import { writeTextToClipboard } from "../domain/clipboard";
import { openPath } from "@tauri-apps/plugin-opener";
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
  ArrowLeftIcon,
  ClipboardDocumentListIcon,
  ClipboardDocumentIcon,
  FlagIcon,
  SignalIcon,
  BeakerIcon,
  FolderOpenIcon,
  ChevronUpIcon,
  EyeIcon,
  PencilSquareIcon,
} from "@heroicons/react/24/outline";

interface Props {
  tileId: string;
  isFocused: boolean;
  workstreamDir?: string;
  linkedSessionIds?: string[];
  workstreamId?: string;
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
const AUDIO_EXTS = new Set(["wav", "mp3", "ogg", "flac"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);
const BINARY_EXTS = new Set(["mp4", "mov", "webm", "pdf", "zip", "gz", "tar", "7z", "exe", "dll", "so", "dylib"]);

type TabId = "config" | "files" | "database" | "checkpoints" | "events";

interface SessionCheckpoint {
  number: number;
  title: string;
  fileName: string;
}

interface SessionEvent {
  type: string;
  timestamp: string;
  tool?: string;
  summary?: string;
}

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

export default function SessionMetaTile({ tileId: _tileId, isFocused, workstreamDir, linkedSessionIds, workstreamId }: Props) {
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
  // Plan content removed: see PlanTile.
  // Checkpoints
  const [checkpoints, setCheckpoints] = useState<SessionCheckpoint[]>([]);
  const [checkpointContent, setCheckpointContent] = useState<{ title: string; content: string } | null>(null);
  // Events
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  // Content viewer (for configs and files). For audio entries we store the
  // Blob URL + raw bytes so <AudioPlayer> can drive playback + waveform.
  const [viewContent, setViewContent] = useState<{
    title: string;
    path: string;
    content: string;
    type: "editor" | "image" | "audio" | "unsupported";
    mimeType?: string;
    audioUrl?: string;
    audioBytes?: ArrayBuffer;
    audioPath?: string;
    audioSize?: number;
  } | null>(null);
  const [editorSnapshot, setEditorSnapshot] = useState<BufferSnapshot | null>(null);
  const [editorViewState, setEditorViewState] = useState<{ mode: "preview" | "edit"; toggle: () => void } | null>(null);
  // Right-click context menu on file rows (files-only).
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  // Revoke any object URL the previous audio entry created.
  useEffect(() => {
    const prev = viewContent?.audioUrl;
    return () => { if (prev) URL.revokeObjectURL(prev); };
  }, [viewContent?.audioUrl]);

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

  // Load plan.md when plan tab is selected — removed (now in PlanTile).
  const loadPlan = useCallback(async () => {}, []);

  const loadCheckpoints = useCallback(async () => {
    if (!linkedSessionIds || linkedSessionIds.length === 0) {
      setCheckpoints([]);
      return;
    }
    const all: SessionCheckpoint[] = [];
    for (const sid of linkedSessionIds) {
      try {
        const cps = await invoke<Array<{ number: number; title: string; file_name: string }>>("list_session_checkpoints", { sessionId: sid });
        all.push(...cps.map((c) => ({ number: c.number, title: c.title, fileName: c.file_name })));
      } catch { /* ignore */ }
    }
    setCheckpoints(all);
  }, [linkedSessionIds]);

  useEffect(() => {
    if (activeTab === "checkpoints") loadCheckpoints();
  }, [activeTab, loadCheckpoints]);

  const loadEvents = useCallback(async () => {
    if (!linkedSessionIds || linkedSessionIds.length === 0) {
      setEvents([]);
      return;
    }
    setEventsLoading(true);
    const all: SessionEvent[] = [];
    for (const sid of linkedSessionIds) {
      try {
        const evts = await invoke<Array<{ event_type: string; timestamp: string; tool: string | null; summary: string | null }>>("list_session_events", { sessionId: sid, limit: 200 });
        all.push(...evts.map((e) => ({
          type: e.event_type,
          timestamp: e.timestamp,
          tool: e.tool || undefined,
          summary: e.summary || undefined,
        })));
      } catch { /* ignore */ }
    }
    setEvents(all);
    setEventsLoading(false);
  }, [linkedSessionIds]);

  useEffect(() => {
    if (activeTab === "events") loadEvents();
  }, [activeTab, loadEvents]);

  // Watch filesystem for live updates (debounced to prevent flicker)
  useEffect(() => {
    const watchPaths: string[] = [];
    if (workstreamDir) watchPaths.push(workstreamDir);
    if (linkedSessionIds) {
      const home = "C:\\Users\\alejandroe";
      for (const sid of linkedSessionIds) {
        watchPaths.push(`${home}\\.copilot\\session-state\\${sid}`);
      }
    }
    for (const p of watchPaths) {
      invoke("watch_directory", { path: p }).catch(() => {});
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unlisten = listen<{ path: string }>("fs-change", (event) => {
      const changedPath = event.payload.path.replace(/\//g, "\\").toLowerCase();
      // Skip events.jsonl changes (too frequent, handled by session poller)
      if (changedPath.endsWith("events.jsonl")) return;
      // Debounce: wait 1s after last change before refreshing
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (activeTab === "config") loadConfig();
        if (activeTab === "files") loadSessionData();
        if (activeTab === "database") loadDbTables();
      }, 1000);
    });
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const p of watchPaths) {
        invoke("unwatch_directory", { path: p }).catch(() => {});
      }
      unlisten.then((u) => u());
    };
  }, [workstreamDir, linkedSessionIds, activeTab, loadConfig, loadSessionData, loadPlan, loadDbTables]);

  // Open a file in the content viewer
  const viewFile = useCallback(async (path: string, title: string) => {
    setEditorSnapshot(null);
    const ext = path.split(".").pop()?.toLowerCase() || "";
    const mimeMap: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon",
    };

    try {
      // Check if path is a directory — try to find a key file inside
      const isDir = await backend.listDirectory(path).then(() => true).catch(() => false);
      if (isDir) {
        // Try common entry files in priority order
        const candidates = ["SKILL.md", "extension.mjs", "extension.js", "README.md", "index.ts", "index.js", "plugin.json", "agency.json"];
        for (const candidate of candidates) {
          const candidatePath = path.endsWith("\\") || path.endsWith("/") ? `${path}${candidate}` : `${path}\\${candidate}`;
          try {
            const content = await backend.readFile(candidatePath);
            setViewContent({
              title: `${title}/${candidate}`,
              path: candidatePath,
              content,
              type: "editor",
            });
            return;
          } catch { /* try next */ }
        }
        // No key file found — list directory contents
        const entries = await backend.listDirectory(path);
        const listing = entries.map((e) => `${e.is_dir ? "📁" : "📄"} ${e.name}`).join("\n");
        setViewContent({ title, path, content: listing || "(empty directory)", type: "unsupported" });
        return;
      }

      // Binary files: images and audio
      if (IMAGE_EXTS.has(ext)) {
        const b64 = await invoke<string>("read_file_base64", { path });
        setViewContent({ title, path, content: b64, type: "image", mimeType: mimeMap[ext] || "image/png" });
        return;
      }
      if (AUDIO_EXTS.has(ext)) {
        const b64 = await invoke<string>("read_file_base64", { path });
        const r = makeAudioBlobUrl(path, b64);
        setViewContent({
          title,
          path,
          content: "",
          type: "audio",
          audioUrl: r.url,
          audioBytes: r.bytes,
          audioPath: path,
          audioSize: r.size,
        });
        return;
      }
      if (BINARY_EXTS.has(ext)) {
        setViewContent({ title, path, content: "Preview is not supported for this file type.", type: "unsupported" });
        return;
      }

      setViewContent({ title, path, content: "", type: "editor" });
    } catch (e) {
      setViewContent({ title, path, content: `Error: ${e}`, type: "unsupported" });
    }
  }, [backend]);

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
    { id: "checkpoints", label: "CP", icon: FlagIcon, count: checkpoints.length },
    { id: "events", label: "Events", icon: SignalIcon, count: events.length },
    { id: "database", label: "DB", icon: TableCellsIcon, count: dbTables.reduce((s, t) => s + t.row_count, 0) },
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
        position: "relative",
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
      <div style={{ flex: 1, overflow: "auto", padding: "4px 0", display: viewContent ? "none" : "block" }}>
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
                      onClick={() => viewFile(item.path, item.name)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenu({ x: e.clientX, y: e.clientY, path: item.path });
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "3px 8px 3px 28px",
                        color: "#cdd6f4",
                        cursor: "pointer",
                      }}
                      title={`Click to view · ${item.path}`}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
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
              return (
                <div
                  key={`${f.file_path}-${i}`}
                  onClick={() => viewFile(f.file_path, fileName)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, path: f.file_path });
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "3px 8px",
                    color: "#cdd6f4",
                    cursor: "pointer",
                  }}
                  title={`Click to view · ${f.file_path}`}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
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

        {/* Checkpoints tab */}
        {activeTab === "checkpoints" && (
          <>
            {(!linkedSessionIds || linkedSessionIds.length === 0) && (
              <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>
                No linked sessions
              </div>
            )}
            {linkedSessionIds && linkedSessionIds.length > 0 && checkpoints.length === 0 && (
              <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>
                No checkpoints found
              </div>
            )}
            {checkpointContent ? (
              <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderBottom: "1px solid #313244", flexShrink: 0 }}>
                  <button
                    onClick={() => setCheckpointContent(null)}
                    style={{ background: "none", border: "none", color: "#89b4fa", cursor: "pointer", fontSize: 11, padding: "2px 4px", display: "flex", alignItems: "center", gap: 2 }}
                  >
                    <ArrowLeftIcon style={{ width: 12, height: 12 }} /> Back
                  </button>
                  <span style={{ color: "#cdd6f4", fontWeight: 600, fontSize: 11 }}>{checkpointContent.title}</span>
                </div>
                <div style={{ flex: 1, overflow: "auto" }}>
                  <MarkdownView>{checkpointContent.content}</MarkdownView>
                </div>
              </div>
            ) : (
              checkpoints.map((cp) => (
                <div
                  key={cp.number}
                  onClick={async () => {
                    if (!linkedSessionIds) return;
                    for (const sid of linkedSessionIds) {
                      try {
                        const content = await invoke<string>("read_session_file", { sessionId: sid, relativePath: `checkpoints/${cp.fileName}` });
                        setCheckpointContent({ title: `#${cp.number} — ${cp.title}`, content });
                        return;
                      } catch { /* try next */ }
                    }
                  }}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", cursor: "pointer", borderBottom: "1px solid #181825" }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  <FlagIcon style={{ width: 14, height: 14, color: "#f9e2af", flexShrink: 0 }} />
                  <span style={{ color: "#585b70", fontSize: 11, flexShrink: 0 }}>#{cp.number}</span>
                  <span style={{ color: "#cdd6f4", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cp.title}</span>
                </div>
              ))
            )}
          </>
        )}

        {/* Events tab */}
        {activeTab === "events" && (
          <>
            {(!linkedSessionIds || linkedSessionIds.length === 0) && (
              <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>
                No linked sessions
              </div>
            )}
            {eventsLoading && (
              <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>Loading events…</div>
            )}
            {!eventsLoading && events.length === 0 && linkedSessionIds && linkedSessionIds.length > 0 && (
              <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>
                No events found
              </div>
            )}
            {!eventsLoading && events.map((evt, i) => {
              const typeColors: Record<string, string> = {
                "user.message": "#89b4fa",
                "assistant.message": "#a6e3a1",
                "assistant.turn_start": "#a6e3a1",
                "assistant.turn_end": "#585b70",
                "tool.execution_start": "#f9e2af",
                "tool.execution_complete": "#f9e2af",
                "session.start": "#cba6f7",
                "session.resume": "#cba6f7",
                "subagent.started": "#f5c2e7",
                "subagent.completed": "#f5c2e7",
                "skill.invoked": "#94e2d5",
              };
              const color = typeColors[evt.type] || "#585b70";
              const time = evt.timestamp.split("T")[1]?.split(".")[0] || evt.timestamp;
              return (
                <div
                  key={`${evt.timestamp}-${i}`}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 8px", fontSize: 10, fontFamily: "monospace" }}
                >
                  <span style={{ color: "#45475a", flexShrink: 0, width: 55 }}>{time}</span>
                  <span style={{ color, flexShrink: 0, width: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{evt.type}</span>
                  {evt.tool && <span style={{ color: "#f9e2af", flexShrink: 0 }}>[{evt.tool}]</span>}
                  {evt.summary && <span style={{ color: "#6c7086", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{evt.summary}</span>}
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

        {/* Plan tab removed — see PlanTile (Alt+P) */}
      </div>

      {/* Content viewer (inline — keeps tab bar visible above) */}
      {viewContent && (
        <div style={{
          flex: 1,
          minHeight: 0,
          background: "#1e1e2e",
          display: "flex",
          flexDirection: "column",
        }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 6px",
            background: "#181825",
            borderBottom: "1px solid #313244",
            flexShrink: 0,
          }}>
            <button
              data-testid="meta-go-to-list"
              onClick={() => { setViewContent(null); setEditorSnapshot(null); setEditorViewState(null); }}
              title="Back to list"
              style={{ background: "none", border: "none", color: "#89b4fa", cursor: "pointer", padding: "2px 4px", display: "flex", alignItems: "center" }}
            >
              <ChevronUpIcon style={{ width: 14, height: 14 }} />
            </button>
            {editorSnapshot?.dirty && (
              <span data-testid="meta-file-dirty-indicator" style={{ color: "#f9e2af", display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0, fontSize: 11 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#f9e2af", display: "inline-block" }} />*
              </span>
            )}
            <div style={{ flex: 1 }} />
            {editorViewState && (
              <button
                data-testid="meta-md-toggle"
                onClick={editorViewState.toggle}
                title={editorViewState.mode === "preview" ? "Edit" : "View"}
                style={{ background: "none", border: "none", color: "#89b4fa", cursor: "pointer", padding: "2px 4px", display: "flex", alignItems: "center" }}
              >
                {editorViewState.mode === "preview"
                  ? <PencilSquareIcon style={{ width: 14, height: 14 }} />
                  : <EyeIcon style={{ width: 14, height: 14 }} />}
              </button>
            )}
          </div>
          {viewContent.type === "unsupported" && (
            <pre style={{
              flex: 1,
              overflow: "auto",
              padding: "8px 12px",
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 11,
              lineHeight: 1.5,
              color: "#cdd6f4",
              fontFamily: "monospace",
            }}>
              {viewContent.content}
            </pre>
          )}
          {viewContent.type === "editor" && (
            <FileEditorView
              key={viewContent.path}
              path={viewContent.path}
              onBack={() => { setViewContent(null); setEditorSnapshot(null); setEditorViewState(null); }}
              showHeader={false}
              renderMarkdownPreview={(content) => (
                <MarkdownView
                  basePath={dirnameOf(viewContent.path)}
                  onLinkClick={(absPath) => viewFile(absPath, absPath.split(/[\\/]/).pop() || absPath)}
                >{content}</MarkdownView>
              )}
              onSnapshotChange={setEditorSnapshot}
              onViewStateChange={setEditorViewState}
            />
          )}
          {viewContent.type === "image" && (
            <div style={{ flex: 1, overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 12 }}>
              <img
                src={`data:${viewContent.mimeType};base64,${viewContent.content}`}
                alt={viewContent.title}
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 4 }}
              />
            </div>
          )}
          {viewContent.type === "audio" && viewContent.audioUrl && (
            <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
              <AudioPlayer
                url={viewContent.audioUrl}
                path={viewContent.audioPath || viewContent.title}
                sizeBytes={viewContent.audioSize ?? 0}
                audioBytes={viewContent.audioBytes ?? null}
                isFocused={isFocused}
              />
            </div>
          )}
        </div>
      )}

      {contextMenu && (
        <SessionMetaContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          path={contextMenu.path}
          workstreamId={workstreamId ?? null}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

interface SessionMetaContextMenuProps {
  x: number;
  y: number;
  path: string;
  workstreamId: string | null;
  onClose: () => void;
}

function SessionMetaContextMenu({ x, y, path, workstreamId, onClose }: SessionMetaContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const t = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleEsc);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [onClose]);

  const close = (fn: () => void) => () => { onClose(); fn(); };
  const name = path.split(/[\\/]/).filter(Boolean).pop() || path;

  const itemStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "6px 10px",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: "#cdd6f4",
    fontSize: 12,
    textAlign: "left",
    borderRadius: 4,
  };

  return (
    <div
      ref={ref}
      data-testid="session-meta-context-menu"
      data-path={path}
      role="menu"
      style={{
        position: "fixed",
        top: y,
        left: x,
        zIndex: 2000,
        minWidth: 200,
        background: "#181825",
        border: "1px solid #45475a",
        borderRadius: 6,
        padding: 4,
        boxShadow: "0 6px 16px rgba(0,0,0,0.45)",
        color: "#cdd6f4",
        fontSize: 12,
        fontFamily: "inherit",
      }}
    >
      <div
        style={{
          padding: "6px 10px 8px",
          borderBottom: "1px solid #313244",
          marginBottom: 4,
          color: "#bac2de",
          fontWeight: 500,
          fontSize: 11,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: 320,
        }}
      >
        {name}
      </div>
      <button
        type="button"
        data-testid="ctx-copy-path"
        onClick={close(() => { void writeTextToClipboard(path); })}
        style={itemStyle}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
      >
        <ClipboardDocumentIcon style={{ width: 14, height: 14, color: "#a6adc8", flexShrink: 0 }} />
        <span>Copy full path</span>
      </button>
      <button
        type="button"
        data-testid="ctx-open-system"
        onClick={close(() => { openPath(path).catch(() => {}); })}
        style={itemStyle}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
      >
        <FolderOpenIcon style={{ width: 14, height: 14, color: "#a6adc8", flexShrink: 0 }} />
        <span>Open in system</span>
      </button>
      <button
        type="button"
        data-testid="ctx-add-to-workbench"
        onClick={close(() => { dispatchAddToWorkbench({ path, workstreamId }); })}
        style={itemStyle}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
      >
        <BeakerIcon style={{ width: 14, height: 14, color: "#a6adc8", flexShrink: 0 }} />
        <span>Add to Workbench</span>
      </button>
    </div>
  );
}
