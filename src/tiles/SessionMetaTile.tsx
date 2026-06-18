// @test-skip: pre-existing tile shell, domain logic tested separately
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MarkdownView } from "../ui/MarkdownView";
import { dirnameOf } from "../domain/file-types";
import { useBackend } from "../backend/context";
import { makeAudioBlobUrl } from "../domain/file-types";
import { FileEditorView, type MarkdownViewState } from "../files/FileEditorView";
import type { BufferSnapshot } from "../files/FileBufferRegistry";
import AudioPlayer from "./AudioPlayer";
import { parseViewState } from "../domain/tile-view-state";
import { useTileViewStatePersist } from "../domain/useTileViewStatePersist";
import { debounce } from "../domain/debounce";
import type { CopilotConfigItem } from "../domain/types";
import { SqliteTableView, sessionSqliteOps, type SqliteTable } from "../ui/components/SqliteTableView";
import { FileContextMenu } from "../ui/components/FileContextMenu";
import { ZoomableImage } from "../ui/components/ZoomableImage";
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
  ChevronUpIcon,
  EyeIcon,
  PencilSquareIcon,
  PresentationChartBarIcon,
} from "@heroicons/react/24/outline";

interface Props {
  tileId: string;
  isFocused: boolean;
  workstreamDir?: string;
  linkedSessionIds?: string[];
  workstreamId?: string;
  workstreamVisible?: boolean;
  configJson?: string;
  onConfigChange?: (configJson: string) => void;
}

interface CategoryMeta {
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  color: string;
}

const CATEGORY_META: Record<string, CategoryMeta> = {
  skill: { label: "Skills", icon: SparklesIcon, color: "#f9e2af" },
  extension: { label: "Extensions", icon: PuzzlePieceIcon, color: "#89b4fa" },
  agent: { label: "Agents", icon: UserGroupIcon, color: "#a6e3a1" },
  mcp_server: { label: "MCP Servers", icon: ServerIcon, color: "#cba6f7" },
  instruction: { label: "Instructions", icon: DocumentTextIcon, color: "#fab387" },
  plugin: { label: "Plugins", icon: CubeIcon, color: "#94e2d5" },
};

const CATEGORY_ORDER = ["skill", "extension", "agent", "mcp_server", "instruction"];
const AUDIO_EXTS = new Set(["wav", "mp3", "ogg", "flac"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);
const BINARY_EXTS = new Set(["mp4", "mov", "webm", "pdf", "zip", "gz", "tar", "7z", "exe", "dll", "so", "dylib"]);

type TabId = "config" | "state" | "database";

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

export default function SessionMetaTile({ tileId: _tileId, isFocused, workstreamDir, linkedSessionIds, workstreamId, workstreamVisible = true, configJson, onConfigChange }: Props) {
  const backend = useBackend();
  const [items, setItems] = useState<CopilotConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<TabId>("config");
  // Config content viewer
  const [viewingContent, setViewingContent] = useState<{ name: string; content: string } | null>(null);
  // Database explorer: counts shown in the tab label come from a lightweight
  // list call; the table/grid UI is owned by SqliteTableView via sessionSqliteOps.
  const [dbTables, setDbTables] = useState<SqliteTable[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [dbLoading, setDbLoading] = useState(false);
  // Session State browser
  const [stateRootDir, setStateRootDir] = useState<string | null>(null);
  const [stateCurrentDir, setStateCurrentDir] = useState<string | null>(null);
  const [stateEntries, setStateEntries] = useState<Array<{ name: string; is_dir: boolean; full_path: string }>>([]);
  const [stateLoading, setStateLoading] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);
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
  const [editorViewState, setEditorViewState] = useState<MarkdownViewState | null>(null);
  // Right-click context menu on file rows (files-only).
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; createDir?: string } | null>(null);

  // Revoke any object URL the previous audio entry created.
  useEffect(() => {
    const prev = viewContent?.audioUrl;
    return () => { if (prev) URL.revokeObjectURL(prev); };
  }, [viewContent?.audioUrl]);

  const loadConfig = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const result = await backend.discoverCopilotConfig(workstreamDir);
      // Equality-check via JSON: payload is small (handful of items per
      // category) and stable across noisy session-state writes, so most
      // watcher-driven refreshes will be no-ops at the render level.
      setItems((prev) => JSON.stringify(prev) === JSON.stringify(result) ? prev : result);
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [backend, workstreamDir]);

  // Stable string key for the linked-session list. Using the array directly
  // as a dep would trigger every parent re-render (App.tsx recomputes the
  // array on many state changes), causing the State-tab reset effect below
  // to fight against in-flight loadStateDir() calls and flicker between
  // "shows entries" and "empty directory".
  const linkedSessionsKey = (linkedSessionIds ?? []).join("|");

  // Resolve the absolute path of the session-state folder for the first
  // linked session. Cached in stateRootDir.
  const resolveStateRoot = useCallback(async (): Promise<string | null> => {
    if (!linkedSessionIds || linkedSessionIds.length === 0) return null;
    for (const sid of linkedSessionIds) {
      try {
        const dir = await invoke<string>("session_state_dir", { sessionId: sid });
        return dir;
      } catch { /* try next */ }
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedSessionsKey]);

  // Use a ref so loadStateDir's identity doesn't change every time the
  // resolved root is set — otherwise the file-watcher effect (which has
  // loadStateDir as a dep) would tear down + re-install its listener on
  // every successful load, racing with in-flight calls.
  const stateRootRef = useRef<string | null>(null);
  useEffect(() => { stateRootRef.current = stateRootDir; }, [stateRootDir]);

  const loadStateDir = useCallback(async (subdir: string | null, silent = false) => {
    if (!silent) {
      setStateLoading(true);
      setStateError(null);
    }
    try {
      const root = stateRootRef.current ?? await resolveStateRoot();
      if (!root) {
        setStateRootDir(null);
        setStateEntries([]);
        return;
      }
      if (root !== stateRootRef.current) {
        stateRootRef.current = root;
        setStateRootDir(root);
      }
      const target = subdir ? `${root}\\${subdir.replace(/\//g, "\\")}` : root;
      const entries = await backend.listDirectory(target);
      const sep = target.endsWith("\\") ? "" : "\\";
      const next = entries.map((e) => ({
        name: e.name,
        is_dir: e.is_dir,
        full_path: `${target}${sep}${e.name}`,
      }));
      setStateEntries((prev) => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
      setStateCurrentDir(subdir);
    } catch (e) {
      if (!silent) {
        setStateError(e instanceof Error ? e.message : String(e));
        setStateEntries([]);
      }
    } finally {
      if (!silent) setStateLoading(false);
    }
  }, [backend, resolveStateRoot]);

  // Absolute path of the directory currently shown in the State tab.
  const stateAbsoluteDir = stateRootDir
    ? (stateCurrentDir ? `${stateRootDir}\\${stateCurrentDir.replace(/\//g, "\\")}` : stateRootDir)
    : null;

  // Create a new file/folder in the State tab's current directory, prompting
  // for a name and refreshing the listing afterwards.
  const createStateEntry = useCallback(async (dir: string, kind: "file" | "folder") => {
    const name = window.prompt(kind === "file" ? "New file name:" : "New folder name:");
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const sep = dir.endsWith("\\") || dir.endsWith("/") ? "" : "\\";
    const target = `${dir}${sep}${trimmed}`;
    try {
      if (kind === "file") {
        await backend.createFile(target);
      } else {
        await backend.createDirectory(target);
      }
      await loadStateDir(stateCurrentDir);
    } catch (e) {
      setStateError(e instanceof Error ? e.message : String(e));
    }
  }, [backend, loadStateDir, stateCurrentDir]);

  const loadDbTables = useCallback(async (silent = false) => {
    if (!linkedSessionIds || linkedSessionIds.length === 0) {
      setDbTables([]);
      return;
    }
    if (!silent) setDbLoading(true);
    const allTables: SqliteTable[] = [];
    for (const sid of linkedSessionIds) {
      try {
        const tables = await invoke<SqliteTable[]>("list_session_db_tables", { sessionId: sid });
        allTables.push(...tables);
      } catch { /* ignore */ }
    }
    setDbTables((prev) => JSON.stringify(prev) === JSON.stringify(allTables) ? prev : allTables);
    if (!silent) setDbLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedSessionsKey]);

  // SqliteTableView ops, memoised so the component's effect doesn't re-fire
  // unless the underlying session list actually changed.
  const dbOps = useMemo(
    () => sessionSqliteOps(linkedSessionIds ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [linkedSessionsKey],
  );

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (activeTab === "state") {
      void loadStateDir(stateCurrentDir);
    }
    // We intentionally exclude loadStateDir + stateCurrentDir from deps so
    // navigation triggers a single fresh fetch rather than re-fetching on
    // every state change. Navigation handlers below call loadStateDir
    // directly with the new subdir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "database") loadDbTables();
  }, [activeTab, loadDbTables]);

  useEffect(() => {
    stateRootRef.current = null;
    setStateRootDir(null);
    setStateCurrentDir(null);
    setStateEntries([]);
  }, [linkedSessionsKey]);

  // Load plan.md when plan tab is selected — removed (now in PlanTile).
  const loadPlan = useCallback(async () => {}, []);

  // Watch filesystem for live updates. Mirrors RepoExplorerTile's pattern:
  // per-loader 200ms JS-side debounce, silent refreshers (no Loading… flash),
  // and content-equality check skips no-op renders. DB refresh narrows to
  // session.db writes so steady SELECT-COUNT pressure from `session.db-journal`
  // / `inuse.<pid>.lock` chatter doesn't wake the COUNT(*) loop.
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

    const refreshConfig = debounce(() => { void loadConfig(true); }, 200);
    const refreshState = debounce(() => { void loadStateDir(stateCurrentDir, true); }, 200);
    const refreshDb = debounce(() => { void loadDbTables(true); }, 200);

    const unlisten = listen<{ path: string }>("fs-change", (event) => {
      if (!workstreamVisible) return;
      const changedPath = event.payload.path.replace(/\//g, "\\").toLowerCase();
      // Skip events.jsonl writes — the session poller writes here on every
      // turn / tool call; nothing in Meta needs to react to that.
      if (changedPath.endsWith("events.jsonl")) return;
      if (activeTab === "config") refreshConfig();
      else if (activeTab === "state") refreshState();
      else if (activeTab === "database" && changedPath.endsWith("session.db")) refreshDb();
    });
    return () => {
      refreshConfig.cancel();
      refreshState.cancel();
      refreshDb.cancel();
      for (const p of watchPaths) {
        invoke("unwatch_directory", { path: p }).catch(() => {});
      }
      unlisten.then((u) => u());
    };
  }, [workstreamDir, linkedSessionsKey, activeTab, loadConfig, loadStateDir, stateCurrentDir, loadPlan, loadDbTables, workstreamVisible]);

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
    if (activeTab === "state") void loadStateDir(stateCurrentDir);
    if (activeTab === "database") loadDbTables();
  }, [loadConfig, loadStateDir, stateCurrentDir, loadDbTables, activeTab]);

  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!workstreamVisible || hydratedRef.current) return;
    hydratedRef.current = true;
    const vs = parseViewState(configJson, "session_meta");
    if (vs.activeTab) setActiveTab(vs.activeTab as TabId);
    if (vs.filePath) {
      const name = vs.filePath.split(/[\\/]/).pop() || vs.filePath;
      void viewFile(vs.filePath, name);
    }
    if (vs.dbTable) {
      // SqliteTableView reads its initial table from props; just stash it.
      setSelectedTable(vs.dbTable);
    }
  }, [workstreamVisible, configJson, viewFile]);

  useTileViewStatePersist(
    configJson,
    "session_meta",
    {
      activeTab,
      filePath: viewContent?.path,
      dbTable: selectedTable ?? undefined,
      mdViewMode: editorViewState?.mode,
      slideIndex: editorViewState?.mode === "present" ? editorViewState?.slideIndex : undefined,
    },
    onConfigChange,
    { enabled: hydratedRef.current },
  );

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

  const tabs: { id: TabId; label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement>>; count: number }[] = [
    { id: "config", label: "Config", icon: SparklesIcon, count: items.length },
    { id: "state", label: "State", icon: FolderIcon, count: stateEntries.length },
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

        {/* Session State tab — browse ~/.copilot/session-state/<id> like Repo Explorer */}
        {activeTab === "state" && (
          <>
            {(!linkedSessionIds || linkedSessionIds.length === 0) && (
              <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>
                No linked sessions — link a copilot session to browse its state folder
              </div>
            )}
            {linkedSessionIds && linkedSessionIds.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderBottom: "1px solid #313244", flexShrink: 0, fontSize: 11 }}>
                  <button
                    onClick={() => loadStateDir(null)}
                    disabled={!stateCurrentDir}
                    title="Back to session root"
                    style={{
                      background: "none",
                      border: "none",
                      color: stateCurrentDir ? "#89b4fa" : "#45475a",
                      cursor: stateCurrentDir ? "pointer" : "default",
                      padding: "2px 4px",
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    <ChevronUpIcon style={{ width: 14, height: 14 }} />
                  </button>
                  <span style={{ color: "#6c7086", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}
                    title={stateRootDir ? `${stateRootDir}${stateCurrentDir ? `\\${stateCurrentDir}` : ""}` : "session-state"}>
                    .copilot/session-state/{(stateRootDir?.split(/[\\/]/).pop()) || "…"}
                    {stateCurrentDir ? `/${stateCurrentDir.replace(/\\/g, "/")}` : ""}
                  </span>
                </div>
                <div
                  style={{ flex: 1, overflow: "auto" }}
                  onContextMenu={stateAbsoluteDir ? (e) => {
                    if (e.target !== e.currentTarget) return;
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, path: stateAbsoluteDir, createDir: stateAbsoluteDir });
                  } : undefined}
                >
                  {stateLoading && (
                    <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>Loading…</div>
                  )}
                  {stateError && (
                    <div style={{ padding: 12, color: "#f38ba8", fontSize: 11 }}>{stateError}</div>
                  )}
                  {!stateLoading && !stateError && stateEntries.length === 0 && (
                    <div
                      style={{ padding: 12, color: "#585b70", textAlign: "center" }}
                      onContextMenu={stateAbsoluteDir ? (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setContextMenu({ x: e.clientX, y: e.clientY, path: stateAbsoluteDir, createDir: stateAbsoluteDir });
                      } : undefined}
                    >(empty directory)</div>
                  )}
                  {stateEntries.map((entry) => (
                    <div
                      key={entry.full_path}
                      onClick={() => {
                        if (entry.is_dir) {
                          const nextRel = stateCurrentDir ? `${stateCurrentDir}\\${entry.name}` : entry.name;
                          void loadStateDir(nextRel);
                        } else {
                          void viewFile(entry.full_path, entry.name);
                        }
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setContextMenu({
                          x: e.clientX,
                          y: e.clientY,
                          path: entry.full_path,
                          createDir: entry.is_dir ? entry.full_path : (stateAbsoluteDir ?? undefined),
                        });
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "3px 8px",
                        cursor: "pointer",
                        color: entry.is_dir ? "#89b4fa" : "#cdd6f4",
                        fontSize: 12,
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                    >
                      {entry.is_dir
                        ? <FolderIcon style={{ width: 12, height: 12, color: "#89b4fa", flexShrink: 0 }} />
                        : <DocumentIcon style={{ width: 12, height: 12, color: "#cdd6f4", flexShrink: 0 }} />
                      }
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {entry.name}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Database tab */}
        {activeTab === "database" && (
          <>
            {(!linkedSessionIds || linkedSessionIds.length === 0) ? (
              <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>
                No linked sessions — link a copilot session to explore its database
              </div>
            ) : dbLoading && dbTables.length === 0 ? (
              <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>Loading…</div>
            ) : (
              <SqliteTableView
                ops={dbOps}
                initialTable={selectedTable}
                onSelectTable={setSelectedTable}
                limit={200}
              />
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
            {editorViewState?.canPresent && (
              <button
                data-testid="meta-present-toggle"
                onClick={editorViewState.mode === "present" ? editorViewState.exitPresent : editorViewState.enterPresent}
                title={editorViewState.mode === "present" ? "Exit present mode (Esc)" : "Present as slides"}
                style={{ background: editorViewState.mode === "present" ? "#313244" : "none", border: "none", color: editorViewState.mode === "present" ? "#a6e3a1" : "#89b4fa", cursor: "pointer", padding: "2px 4px", display: "flex", alignItems: "center", borderRadius: 3 }}
              >
                <PresentationChartBarIcon style={{ width: 14, height: 14 }} />
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
            <ZoomableImage
              testid="session-meta-image-preview"
              src={`data:${viewContent.mimeType};base64,${viewContent.content}`}
              alt={viewContent.title}
            />
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
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          path={contextMenu.path}
          workstreamId={workstreamId ?? null}
          onClose={() => setContextMenu(null)}
          onNewFile={contextMenu.createDir ? () => createStateEntry(contextMenu.createDir!, "file") : undefined}
          onNewFolder={contextMenu.createDir ? () => createStateEntry(contextMenu.createDir!, "folder") : undefined}
        />
      )}
    </div>
  );
}

