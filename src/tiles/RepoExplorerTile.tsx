// @test-skip: pre-existing tile shell, individual subcomponents tested separately
import { useState, useEffect, useCallback, useRef } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { MarkdownView } from "../ui/MarkdownView";
import { FileEditorView } from "../files/FileEditorView";
import type { BufferSnapshot } from "../files/FileBufferRegistry";
import AudioPlayer from "./AudioPlayer";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useBackend } from "../backend/context";
import { detectLanguage } from "../domain/tile-config";
import { isAudioFile, isImageFile, makeAudioBlobUrl, makeImageBlobUrl, dirnameOf, type LinkTargetKind } from "../domain/file-types";
import { createNavigationStack, currentPath as navCurrent, canGoBack as navCanBack, canGoForward as navCanFwd, pushPath as navPush, goBack as navBack, goForward as navFwd, type NavigationStack } from "../domain/nav-history";
import {
  FolderIcon,
  DocumentIcon,
  DocumentTextIcon,
  CodeBracketIcon,
  ChevronUpIcon,
  ArrowPathIcon,
  FolderOpenIcon,
  CodeBracketSquareIcon,
  ClockIcon,
  BoltIcon,
  MusicalNoteIcon,
  EyeIcon,
  PencilSquareIcon,
  ChatBubbleLeftRightIcon,
  TableCellsIcon,
} from "@heroicons/react/24/outline";
import { SqliteTableView, fileSqliteOps } from "../ui/components/SqliteTableView";
import { FileContextMenu } from "../ui/components/FileContextMenu";
import { openPath } from "@tauri-apps/plugin-opener";
import { useFileComments } from "../files/useFileComments";
import { debounce } from "../domain/debounce";
import { getAppSettings, subscribeAppSettings } from "../domain/app-settings";
import { parseViewState } from "../domain/tile-view-state";
import { useTileViewStatePersist } from "../domain/useTileViewStatePersist";

interface Props {
  tileId: string;
  isFocused: boolean;
  rootDir?: string;
  initialPath?: string;
  workstreamId?: string;
  workstreamVisible?: boolean;
  configJson?: string;
  onConfigChange?: (configJson: string) => void;
}

interface DirEntry {
  name: string;
  isDir: boolean;
  fullPath: string;
  modifiedEpoch: number;
  size: number;
}

type Mode = "browse" | "view" | "audio" | "image" | "log" | "hooks" | "sqlite";
type DiffMode = "unstaged" | "last_commit" | "branch_vs_master";

const MARKDOWN_EXTS = new Set(["md", "mdx", "markdown"]);
const SQLITE_EXTS = new Set(["db", "sqlite", "sqlite3", "db3"]);
const FILE_EDITOR_EXCLUDED_EXTS = new Set([
  "wav", "mp3", "ogg", "flac",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico",
  "mp4", "mov", "webm",
  "pdf", "zip", "gz", "tar", "7z", "exe", "dll", "so", "dylib",
  "db", "sqlite", "sqlite3", "db3",
]);
const AUDIO_SIZE_LIMIT_BYTES = 100 * 1024 * 1024; // 100 MB

function extensionFor(path: string): string {
  return path.split(/[\\/.]/).pop()?.toLowerCase() || "";
}

function isMarkdown(path: string): boolean {
  return MARKDOWN_EXTS.has(extensionFor(path));
}

function isSqliteByExt(path: string): boolean {
  return SQLITE_EXTS.has(extensionFor(path));
}

export function shouldUseFileEditor(path: string): boolean {
  return !FILE_EDITOR_EXCLUDED_EXTS.has(extensionFor(path));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function FileIcon({ name, isDir }: { name: string; isDir: boolean }) {
  if (isDir) return <FolderIcon style={{ width: 16, height: 16, color: "#89b4fa" }} />;
  const ext = name.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "ts": case "tsx": case "js": case "jsx": case "rs": case "py":
      return <CodeBracketIcon style={{ width: 16, height: 16, color: "#a6adc8" }} />;
    case "md": case "mdx": case "markdown":
      return <DocumentTextIcon style={{ width: 16, height: 16, color: "#a6adc8" }} />;
    case "mp3": case "wav": case "ogg": case "flac": case "m4a": case "aac": case "opus": case "webm":
      return <MusicalNoteIcon style={{ width: 16, height: 16, color: "#cba6f7" }} />;
    default:
      return <DocumentIcon style={{ width: 16, height: 16, color: "#6c7086" }} />;
  }
}

/**
 * Parse a unified diff to extract old (original) and new (modified) content.
 */
export function parseDiffToSides(diffText: string): { original: string; modified: string } {
  if (!diffText.trim()) return { original: "", modified: "" };

  const lines = diffText.split("\n");
  const originalLines: string[] = [];
  const modifiedLines: string[] = [];
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith("-")) {
      originalLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      modifiedLines.push(line.slice(1));
    } else if (line.startsWith(" ") || line === "") {
      const content = line.startsWith(" ") ? line.slice(1) : line;
      originalLines.push(content);
      modifiedLines.push(content);
    }
  }

  return { original: originalLines.join("\n"), modified: modifiedLines.join("\n") };
}

export default function RepoExplorerTile({ tileId: _tileId, isFocused, rootDir, initialPath, workstreamId, workstreamVisible = true, configJson, onConfigChange }: Props) {
  const backend = useBackend();

  const [mode, setMode] = useState<Mode>(initialPath ? "view" : "browse");
  // Browse state
  const [currentDir, setCurrentDir] = useState(rootDir || "C:\\");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [dirError, setDirError] = useState<string | null>(null);
  const [dirLoading, setDirLoading] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  // View state
  const [filePath, setFilePath] = useState(initialPath || "");
  const [content, setContent] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  // Audio state — populated when openFile detects an audio extension.
  // We keep both the object URL (for `<audio src>`) and the raw bytes
  // (so the waveform component can decode them).
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioBytes, setAudioBytes] = useState<ArrayBuffer | null>(null);
  const [audioSizeBytes, setAudioSizeBytes] = useState(0);
  const [audioTooLarge, setAudioTooLarge] = useState(false);
  // Image preview state.
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  // File-viewer navigation history: each entry is an absolute file path.
  // Empty when not in a file/image/audio view (i.e. we're browsing).
  const [navStack, setNavStack] = useState<NavigationStack | null>(null);
  const [imageSizeBytes, setImageSizeBytes] = useState(0);
  // Ctrl+P search overlay
  const [showFileSearch, setShowFileSearch] = useState(false);
  const [fileSearchQuery, setFileSearchQuery] = useState("");
  const [fileSearchResults, setFileSearchResults] = useState<string[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const fileSearchInputRef = useRef<HTMLInputElement>(null);
  // Diff mode state
  const [activeDiffMode, setActiveDiffMode] = useState<DiffMode | null>(null);
  const [diffFiles, setDiffFiles] = useState<Array<{ path: string; status: "A" | "M" | "D" | "R" }>>([]);
  const [diffBefore, setDiffBefore] = useState<string>("");
  const [diffAfter, setDiffAfter] = useState<string>("");
  const [diffFilePath, setDiffFilePath] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  // Diff layout: "split" (default, classic side-by-side) | "unified" (single
  // pane). Persisted in tile view-state.
  const [diffLayout, setDiffLayout] = useState<"split" | "unified">("split");
  // Git branch state
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  // Git log state
  const [logCommits, setLogCommits] = useState<Array<{ hash: string; short_hash: string; message: string; author: string; date: string }>>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logTracking, setLogTracking] = useState<{ ahead: number; behind: number; remoteHeadShort: string } | null>(null);
  const [commitDiffHash, setCommitDiffHash] = useState<string>("");
  // Git hooks state
  const [hooksList, setHooksList] = useState<Array<{ name: string; path: string; content_preview: string }>>([]);
  const [hooksLoading, setHooksLoading] = useState(false);
  const [hookContent, setHookContent] = useState<{ name: string; content: string } | null>(null);
  const [editorSnapshot, setEditorSnapshot] = useState<BufferSnapshot | null>(null);
  // Markdown view/edit toggle from FileEditorView. Null when the current
  // file isn't markdown or no toggle is meaningful (conflict, save_blocked).
  const [editorViewState, setEditorViewState] = useState<{ mode: "preview" | "edit"; toggle: () => void } | null>(null);
  // Inline file-comments toggle. Persisted per-workstream via settings.
  const [commentsEnabled, setCommentsEnabled] = useState(false);
  useEffect(() => {
    if (!workstreamId) return;
    let cancelled = false;
    void invoke<string | null>("get_setting", { key: `comments-visible:${workstreamId}` })
      .then((v) => { if (!cancelled) setCommentsEnabled(v === "1"); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [workstreamId]);
  const fileComments = useFileComments(workstreamId ?? null, filePath || null);
  const toggleCommentsVisible = useCallback(() => {
    setCommentsEnabled((v) => {
      const next = !v;
      if (workstreamId) {
        void invoke("set_setting", { key: `comments-visible:${workstreamId}`, value: next ? "1" : "0" }).catch(() => {});
      }
      return next;
    });
  }, [workstreamId]);
  // Right-click context menu state. Anchored to viewport coordinates of
  // the contextmenu event; null when closed.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(null);

  // Font size (Ctrl+= / Ctrl+- and A-/A+ toolbar buttons)
  // Read global font sizes from app settings. RepoExplorer no longer has a
  // per-tile font size; the Settings modal globals drive Monaco editors
  // (text) and MarkdownView (markdown). We keep two local snapshots so
  // re-render fires when the global changes.
  const [globalTextFont, setGlobalTextFont] = useState<number>(() => getAppSettings().textFontSize);
  const [globalMarkdownFont, setGlobalMarkdownFont] = useState<number>(() => getAppSettings().markdownFontSize);
  useEffect(
    () =>
      subscribeAppSettings((s) => {
        setGlobalTextFont(s.textFontSize);
        setGlobalMarkdownFont(s.markdownFontSize);
      }),
    [],
  );

  // Ctrl+P keyboard navigation
  const [fileSearchSelectedIndex, setFileSearchSelectedIndex] = useState(0);

  // Monaco editor ref (to trigger find widget programmatically)
  const editorRef = useRef<unknown>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  const loadDir = useCallback(async (dir: string) => {
    setDirLoading(true);
    setDirError(null);
    try {
      const raw = await backend.listDirectory(dir);
      const sep = dir.endsWith("\\") ? "" : "\\";
      setEntries(raw.map((e) => ({
        name: e.name,
        isDir: e.is_dir,
        fullPath: `${dir}${sep}${e.name}`,
        modifiedEpoch: e.modified_epoch,
        size: e.size,
      })));
      setCurrentDir(dir);
    } catch (e) {
      setDirError(String(e));
    } finally {
      setDirLoading(false);
    }
  }, [backend]);

  // Helper for audio open path. Reads the file as base64, converts to a
  // Blob with the right MIME, and creates an object URL. The shared
  // makeAudioBlobUrl helper is also used by Meta and Workbench tiles.
  const loadAudioFile = useCallback(async (audioPath: string): Promise<{ url: string; bytes: ArrayBuffer; size: number }> => {
    const b64 = await invoke<string>("read_file_base64", { path: audioPath });
    const r = makeAudioBlobUrl(audioPath, b64);
    return { url: r.url, bytes: r.bytes, size: r.size };
  }, []);

  // Revoke any previously-created audio object URL when it changes or the
  // tile unmounts. Without this we leak megabytes per file open.
  useEffect(() => {
    const prev = audioUrl;
    return () => { if (prev) URL.revokeObjectURL(prev); };
  }, [audioUrl]);

  useEffect(() => {
    const prev = imageUrl;
    return () => { if (prev) URL.revokeObjectURL(prev); };
  }, [imageUrl]);

  const openFile = useCallback(async (path: string, navMode: "push" | "replace" | "none" = "push") => {
    const trimmedPath = path.trim();
    if (!trimmedPath) return;
    if (navMode === "push") {
      setNavStack((prev) => (prev ? navPush(prev, trimmedPath) : createNavigationStack(trimmedPath)));
    }
    setFileError(null);
    setFileLoading(true);
    setAudioUrl(null);
    setAudioBytes(null);
    setAudioTooLarge(false);
    setImageUrl(null);
    setEditorSnapshot(null);
    setCommitDiffHash("");

    // Image branch — fast path: read base64, render <img>.
    if (isImageFile(trimmedPath)) {
      try {
        const b64 = await invoke<string>("read_file_base64", { path: trimmedPath });
        const r = makeImageBlobUrl(trimmedPath, b64);
        setImageUrl(r.url);
        setImageSizeBytes(r.size);
        setFilePath(trimmedPath);
        setContent(null);
        setMode("image");
        return;
      } catch (e) {
        setFileError(String(e));
        return;
      } finally {
        setFileLoading(false);
      }
    }

    // Audio branch.
    if (isAudioFile(trimmedPath)) {
      try {
        // Peek at the size via the directory listing if we have it.
        const found = entries.find((e) => e.fullPath === trimmedPath);
        if (found && found.size > AUDIO_SIZE_LIMIT_BYTES) {
          setAudioUrl(null);
          setAudioBytes(null);
          setAudioSizeBytes(found.size);
          setAudioTooLarge(true);
          setFilePath(trimmedPath);
          setMode("audio");
          setFileLoading(false);
          return;
        }
        const { url, bytes, size } = await loadAudioFile(trimmedPath);
        // Defensive: if size came back larger than the limit anyway, abort.
        if (size > AUDIO_SIZE_LIMIT_BYTES) {
          URL.revokeObjectURL(url);
          setAudioUrl(null);
          setAudioBytes(null);
          setAudioSizeBytes(size);
          setAudioTooLarge(true);
        } else {
          setAudioUrl(url);
          setAudioBytes(bytes);
          setAudioSizeBytes(size);
        }
        setFilePath(trimmedPath);
        setContent(null);
        setMode("audio");
        return;
      } catch (e) {
        setFileError(String(e));
        return;
      } finally {
        setFileLoading(false);
      }
    }

    // SQLite branch — try by extension first, then sniff the magic header
    // to catch non-standard names (e.g. Copilot's session.db).
    if (isSqliteByExt(trimmedPath) || await invoke<boolean>("is_sqlite_file", { path: trimmedPath }).catch(() => false)) {
      setFilePath(trimmedPath);
      setContent(null);
      setMode("sqlite");
      setFileLoading(false);
      return;
    }

    setFilePath(trimmedPath);
    setContent(null);
    setMode("view");
    setFileLoading(false);
    // Don't clear activeDiffMode here — it persists from browse diff selection.
  }, [entries, loadAudioFile]);

  // Load directory on mount (browse mode)
  useEffect(() => {
    if (!initialPath) {
      loadDir(currentDir);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-open if initialPath provided
  useEffect(() => {
    if (initialPath) openFile(initialPath);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Watch directory for filesystem changes (replaces 3s polling).
  // The fs-change events from Rust are already debounced to 500 ms and
  // filtered for node_modules/.git/target, but a single user action can
  // still produce many distinct event paths under the watched dir. We
  // debounce again on the React side so we issue at most one
  // listDirectory() round-trip per quiet window.
  useEffect(() => {
    invoke("watch_directory", { path: currentDir }).catch(() => {});
    const refreshEntries = debounce(async () => {
      if (mode === "browse" && !activeDiffMode) {
        try {
          const raw = await backend.listDirectory(currentDir);
          const sep = currentDir.endsWith("\\") ? "" : "\\";
          const fresh = raw.map((e) => ({
            name: e.name,
            isDir: e.is_dir,
            fullPath: `${currentDir}${sep}${e.name}`,
            modifiedEpoch: e.modified_epoch,
            size: e.size,
          }));
          setEntries(fresh);
        } catch { /* ignore */ }
      }
    }, 200);
    const refreshLegacyContent = debounce(async () => {
      if (mode === "view" && filePath && !shouldUseFileEditor(filePath)) {
        try {
          const newContent = await backend.readFile(filePath);
          setContent((prev) => prev === newContent ? prev : newContent);
        } catch { /* ignore */ }
      }
    }, 200);
    const unlisten = listen<{ path: string; kind: string }>("fs-change", (event) => {
      // Skip when our workstream isn't active — the user can't see refreshes
      // anyway and a fs-change burst would otherwise wake every Repo
      // Explorer subscriber across every loaded workstream.
      if (!workstreamVisible) return;
      const changedPath = event.payload.path.replace(/\//g, "\\");
      const normalDir = currentDir.replace(/\//g, "\\");
      if (!changedPath.startsWith(normalDir)) return;
      if (mode === "browse" && !activeDiffMode) {
        refreshEntries();
      } else if (mode === "view" && filePath && !shouldUseFileEditor(filePath)) {
        const normalFile = filePath.replace(/\//g, "\\");
        if (changedPath === normalFile || changedPath.startsWith(normalDir)) {
          refreshLegacyContent();
        }
      }
    });
    return () => {
      refreshEntries.cancel();
      refreshLegacyContent.cancel();
      invoke("unwatch_directory", { path: currentDir }).catch(() => {});
      unlisten.then((u) => u());
    };
  }, [currentDir, mode, activeDiffMode, filePath, backend, workstreamVisible]);

  // Fetch current branch on mount and when directory changes
  useEffect(() => {
    const gitDir = rootDir || currentDir;
    backend.gitCurrentBranch(gitDir)
      .then((b) => setCurrentBranch(b || null))
      .catch(() => setCurrentBranch(null));
  }, [rootDir, currentDir, backend]);

  // Ctrl+P handler
  useEffect(() => {
    if (!isFocused) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "p") {
        e.preventDefault();
        e.stopPropagation();
        setShowFileSearch(true);
        setFileSearchQuery("");
        setFileSearchResults([]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isFocused]);

  // Focus search input when overlay opens
  useEffect(() => {
    if (showFileSearch) {
      setTimeout(() => fileSearchInputRef.current?.focus(), 50);
    }
  }, [showFileSearch]);

  // Debounced file search (Ctrl+P).
  // The cleanup function cancels the in-flight search via the Rust epoch
  // counter so the backend bails out promptly when the user keeps typing
  // (this is what prevented the IPC queue from blocking other tiles).
  useEffect(() => {
    if (!showFileSearch || !fileSearchQuery.trim()) {
      setFileSearchResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      // Cancel any previous in-flight search before starting a new one.
      try { await backend.cancelSearches(); } catch { /* ignore */ }
      if (cancelled) return;
      setFileSearchLoading(true);
      try {
        const results = await backend.searchFiles(currentDir, fileSearchQuery.trim());
        if (!cancelled) setFileSearchResults(results);
      } catch {
        if (!cancelled) setFileSearchResults([]);
      } finally {
        if (!cancelled) setFileSearchLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      // Bump the epoch immediately so any running search bails on its next iter.
      void backend.cancelSearches();
    };
  }, [fileSearchQuery, showFileSearch, backend, currentDir]);

  const closeFileSearch = useCallback(() => {
    setShowFileSearch(false);
    setFileSearchQuery("");
    setFileSearchResults([]);
  }, []);

  const navigateUp = () => {
    const parent = currentDir.replace(/\\[^\\]+\\?$/, "");
    if (parent && parent !== currentDir) {
      loadDir(parent.endsWith("\\") ? parent : parent + "\\");
    }
  };

  const handleEntryClick = (entry: DirEntry) => {
    if (entry.isDir) {
      loadDir(entry.fullPath);
      setSearchFilter("");
    } else {
      // Normal browse click clears diff mode
      setActiveDiffMode(null);
      setDiffBefore(""); setDiffAfter("");
      setDiffFilePath("");
      openFile(entry.fullPath);
    }
  };

  const handleBackToBrowse = useCallback(() => {
    setContent(null);
    setFilePath("");
    setFileError(null);
    setEditorSnapshot(null);
    setAudioUrl(null);
    setAudioBytes(null);
    setAudioTooLarge(false);
    setNavStack(null);
    setMode("browse");
  }, []);

  const handleLinkClick = useCallback(async (absPath: string, kind: LinkTargetKind) => {
    if (kind === "markdown" || kind === "image" || kind === "audio" || kind === "file") {
      await openFile(absPath, "push");
      return;
    }
    // Fallback (shouldn't happen with current LinkTargetKind union).
    openPath(absPath).catch(() => {});
  }, [openFile]);

  const handleNavBack = useCallback(async () => {
    if (!navStack || !navCanBack(navStack)) return;
    const next = navBack(navStack);
    setNavStack(next);
    await openFile(navCurrent(next), "none");
  }, [navStack, openFile]);

  const handleNavForward = useCallback(async () => {
    if (!navStack || !navCanFwd(navStack)) return;
    const next = navFwd(navStack);
    setNavStack(next);
    await openFile(navCurrent(next), "none");
  }, [navStack, openFile]);

  const handleBrowseDialog = async () => {
    const file = await open({ title: "Open file", multiple: false, directory: false });
    if (file) openFile(file as string);
  };

  // Git root directory for diff commands (use rootDir, not browsed currentDir)
  const gitRoot = rootDir || currentDir;

  // Diff mode handlers
  const loadDiffSides = useCallback(async (file: string, mode: DiffMode) => {
    try {
      const { before, after } = await backend.gitDiffFileSides(gitRoot, file, mode);
      setDiffBefore(before);
      setDiffAfter(after);
    } catch {
      setDiffBefore("");
      setDiffAfter("");
    }
  }, [backend, gitRoot]);

  const activateDiffMode = useCallback(async (diffMode: DiffMode) => {
    setActiveDiffMode(diffMode);
    setDiffLoading(true);
    setDiffBefore("");
    setDiffAfter("");
    try {
      const files = await backend.gitDiffFilesWithStatus(gitRoot, diffMode);
      setDiffFiles(files);
      // If the previously-selected file is still in the new mode's list,
      // keep it; otherwise drop to the first.
      const keep = diffFilePath && files.some((f) => f.path === diffFilePath)
        ? diffFilePath
        : files[0]?.path ?? "";
      setDiffFilePath(keep);
      if (keep) {
        await loadDiffSides(keep, diffMode);
      }
    } catch (e) {
      console.error("[Explorer] diff error:", e);
      setDiffFiles([]);
    } finally {
      setDiffLoading(false);
    }
  }, [backend, gitRoot, diffFilePath, loadDiffSides]);

  const selectDiffFile = useCallback(async (file: string) => {
    if (!activeDiffMode) return;
    setDiffFilePath(file);
    setDiffLoading(true);
    try {
      await loadDiffSides(file, activeDiffMode);
    } finally {
      setDiffLoading(false);
    }
  }, [activeDiffMode, loadDiffSides]);

  const exitDiffMode = useCallback(() => {
    setActiveDiffMode(null);
    setDiffBefore("");
    setDiffAfter("");
    setDiffFiles([]);
    setDiffFilePath("");
  }, []);

  // Git log handlers
  const openGitLog = useCallback(async () => {
    setMode("log");
    setLogLoading(true);
    setCommitDiffHash("");
    setLogTracking(null);
    try {
      const [commits, tracking] = await Promise.all([
        backend.gitLog(gitRoot, 50),
        backend.gitBranchTrackingInfo(gitRoot).catch(() => ({ ahead: 0, behind: 0, remoteHeadShort: "" })),
      ]);
      setLogCommits(commits);
      setLogTracking(tracking);
    } catch {
      setLogCommits([]);
    } finally {
      setLogLoading(false);
    }
  }, [backend, gitRoot]);

  const viewCommitDiff = useCallback(async (hash: string) => {
    setCommitDiffHash(hash);
    setLogLoading(true);
    try {
      const diff = await backend.gitShowCommit(gitRoot, hash);
      setEditorSnapshot(null);
      setMode("view");
      setContent(diff);
      setFilePath(`commit:${hash}`);
    } catch {
      setContent("");
    } finally {
      setLogLoading(false);
    }
  }, [backend, gitRoot]);

  // Note: previously had goBackToLog (used by removed back button).
  // Returning to the log is now handled by clicking the Log tab.

  // Git hooks handlers
  const openGitHooks = useCallback(async () => {
    setMode("hooks");
    setHooksLoading(true);
    setHookContent(null);
    try {
      const hooks = await invoke<Array<{ name: string; path: string; content_preview: string }>>("list_git_hooks", { directory: gitRoot });
      setHooksList(hooks);
    } catch {
      setHooksList([]);
    } finally {
      setHooksLoading(false);
    }
  }, [gitRoot]);

  const viewHookContent = useCallback(async (hook: { name: string; path: string }) => {
    try {
      const content = await backend.readFile(hook.path);
      setHookContent({ name: hook.name, content });
    } catch (e) {
      setHookContent({ name: hook.name, content: `Error reading hook: ${e}` });
    }
  }, [backend]);

  // ─── Tabs ────────────────────────────────────────────────────────────
  type TabId = "files" | "diff" | "log" | "hooks";
  const activeTab: TabId =
    mode === "log" ? "log" :
    mode === "hooks" ? "hooks" :
    activeDiffMode ? "diff" :
    "files";

  const selectTab = useCallback((tab: TabId) => {
    // For the "files" tab, always reset to plain browse — even if the
    // computed activeTab already says "files" (which happens when the
    // user is in view/audio mode looking at a file). Without this the
    // Files tab is unclickable from those modes, leaving the user stuck.
    if (tab === "files") {
      setActiveDiffMode(null);
      setDiffBefore(""); setDiffAfter("");
      setDiffFiles([]);
      setDiffFilePath("");
      setContent(null);
      setFilePath("");
      setEditorSnapshot(null);
      setAudioUrl(null);
      setAudioBytes(null);
      setAudioTooLarge(false);
      setMode("browse");
      return;
    }
    if (tab === activeTab) return;
    switch (tab) {
      case "diff":
        setMode("browse");
        setContent(null);
        setFilePath("");
        setEditorSnapshot(null);
        activateDiffMode("unstaged");
        break;
      case "log":
        setActiveDiffMode(null);
        setDiffBefore(""); setDiffAfter("");
        setDiffFiles([]);
        setDiffFilePath("");
        openGitLog();
        break;
      case "hooks":
        setActiveDiffMode(null);
        setDiffBefore(""); setDiffAfter("");
        setDiffFiles([]);
        setDiffFilePath("");
        openGitHooks();
        break;
    }
  }, [activeTab, activateDiffMode, openGitLog, openGitHooks]);

  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!workstreamVisible || hydratedRef.current) return;
    hydratedRef.current = true;
    const vs = parseViewState(configJson, "repo_explorer");
    if (vs.currentDir) setCurrentDir(vs.currentDir);
    if (vs.diffLayout) setDiffLayout(vs.diffLayout);
    const tab = vs.activeTab as TabId | undefined;
    if (tab && tab !== "files") {
      if (tab === "diff") {
        const dm = (vs.diffMode as DiffMode | undefined) ?? "unstaged";
        activateDiffMode(dm);
      } else if (tab === "log") {
        void openGitLog();
      } else if (tab === "hooks") {
        void openGitHooks();
      }
    }
    if (vs.filePath && (!tab || tab === "files")) {
      void openFile(vs.filePath, "none").catch(() => {});
    }
  }, [workstreamVisible, configJson, activateDiffMode, openGitLog, openGitHooks, openFile]);

  // Restore selected hook once hooksList loads after hooks tab hydration.
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (mode !== "hooks") return;
    if (hookContent) return;
    if (hooksList.length === 0) return;
    const vs = parseViewState(configJson, "repo_explorer");
    if (vs.hookName) {
      const hook = hooksList.find((h) => h.name === vs.hookName);
      if (hook) void viewHookContent(hook);
    }
  }, [hooksList, mode, hookContent, configJson, viewHookContent]);

  useTileViewStatePersist(
    configJson,
    "repo_explorer",
    {
      activeTab,
      currentDir,
      filePath: mode === "view" && filePath && !filePath.startsWith("commit:") ? filePath : undefined,
      diffMode: activeTab === "diff" && activeDiffMode ? activeDiffMode : undefined,
      diffLayout: activeTab === "diff" ? diffLayout : undefined,
      hookName: activeTab === "hooks" && hookContent ? hookContent.name : undefined,
      mdViewMode: editorViewState?.mode,
    },
    onConfigChange,
    { enabled: hydratedRef.current },
  );

  // Reset Ctrl+P selection when results change
  useEffect(() => { setFileSearchSelectedIndex(0); }, [fileSearchResults]);

  // Filter entries by search
  const filteredEntries = searchFilter
    ? entries.filter((e) => e.name.toLowerCase().includes(searchFilter.toLowerCase()))
    : entries;

  // ─── Tab bar (rendered above every mode body) ───
  const TABS: Array<{ id: TabId; label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement>> }> = [
    { id: "files", label: "Files", icon: FolderIcon },
    { id: "diff", label: "Diff", icon: CodeBracketSquareIcon },
    { id: "log", label: "Log", icon: ClockIcon },
    { id: "hooks", label: "Hooks", icon: BoltIcon },
  ];
  const tabBar = (
    <div style={tabBarStyle} data-testid="repo-explorer-tabs">
      {TABS.map((t) => {
        const Icon = t.icon;
        const active = activeTab === t.id;
        return (
          <button
            key={t.id}
            onClick={() => selectTab(t.id)}
            style={{
              ...tabButtonStyle,
              color: active ? "#cdd6f4" : "#6c7086",
              borderBottom: active ? "2px solid #89b4fa" : "2px solid transparent",
              background: active ? "#1e1e2e" : "transparent",
            }}
            data-testid={`repo-explorer-tab-${t.id}`}
            data-active={active ? "true" : "false"}
          >
            <Icon style={{ width: 12, height: 12 }} />
            {t.label}
          </button>
        );
      })}
      <div style={{ flex: 1 }} />
    </div>
  );

  // ─── Ctrl+P Search Overlay (filename search, scoped to tile) ───
  const fileSearchOverlay = showFileSearch ? (
    <div style={searchOverlayStyle} data-testid="file-search-overlay" onClick={closeFileSearch}>
      <div style={searchModalStyle} onClick={(e) => e.stopPropagation()}>
        <input
          ref={fileSearchInputRef}
          type="text"
          value={fileSearchQuery}
          onChange={(e) => setFileSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") closeFileSearch();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setFileSearchSelectedIndex((i) => Math.min(fileSearchResults.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setFileSearchSelectedIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const p = fileSearchResults[fileSearchSelectedIndex];
              if (p) { closeFileSearch(); openFile(p); }
            }
          }}
          placeholder="Search files by name..."
          style={searchInputStyle}
          data-testid="file-search-input"
        />
        <div style={searchResultsStyle}>
          {fileSearchLoading && (
            <div style={{ padding: "8px 12px", color: "#585b70" }}>Searching...</div>
          )}
          {!fileSearchLoading && fileSearchQuery && fileSearchResults.length === 0 && (
            <div style={{ padding: "8px 12px", color: "#585b70" }}>No files found</div>
          )}
          {fileSearchResults.map((path, idx) => {
            const selected = idx === fileSearchSelectedIndex;
            return (
            <div
              key={path}
              onClick={() => { closeFileSearch(); openFile(path); }}
              onMouseEnter={() => setFileSearchSelectedIndex(idx)}
              style={{
                ...searchResultItemStyle,
                background: selected ? "#313244" : "transparent",
              }}
              data-testid={`file-search-result-${idx}`}
              data-selected={selected ? "true" : "false"}
            >
              <span style={{ width: 16, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <FileIcon name={path.split("\\").pop() || path} isDir={false} />
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>
                {path}
              </span>
            </div>
            );
          })}
        </div>
      </div>
    </div>
  ) : null;

  const overlays = (
    <>
      {fileSearchOverlay}
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          path={contextMenu.path}
          isDir={contextMenu.isDir}
          workstreamId={workstreamId ?? null}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );

  // ─── Diff mode (unified: file list + DiffEditor) ───
  // Render regardless of `mode` so the user lands here as soon as they
  // pick a diff sub-mode, and stays put across mode/file changes.
  const diffModeToolbar = (
    <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderBottom: "1px solid #313244", background: "#181825" }}>
      {(["unstaged", "last_commit", "branch_vs_master"] as DiffMode[]).map((dm) => (
        <button
          key={dm}
          onClick={() => activeDiffMode === dm ? exitDiffMode() : activateDiffMode(dm)}
          style={{
            ...toolbarButtonStyle,
            fontSize: 10,
            padding: "2px 6px",
            borderRadius: 3,
            background: activeDiffMode === dm ? "#45475a" : "transparent",
            color: activeDiffMode === dm ? "#cdd6f4" : "#89b4fa",
          }}
          data-testid={`diff-btn-${dm}`}
        >
          {dm === "unstaged" ? "Unstaged" : dm === "last_commit" ? "Last Commit" : "vs Master"}
        </button>
      ))}
      {activeDiffMode && (
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: "#6c7086" }} data-testid="diff-file-count">
            {diffFiles.length} file{diffFiles.length !== 1 ? "s" : ""} changed
          </span>
          <div style={{ display: "flex", gap: 2, border: "1px solid #313244", borderRadius: 3, padding: 1 }}>
            {(["split", "unified"] as const).map((layout) => (
              <button
                key={layout}
                onClick={() => setDiffLayout(layout)}
                title={layout === "split" ? "Side-by-side diff" : "Unified diff"}
                data-testid={`diff-layout-${layout}`}
                style={{
                  ...toolbarButtonStyle,
                  fontSize: 10,
                  padding: "2px 6px",
                  borderRadius: 2,
                  background: diffLayout === layout ? "#45475a" : "transparent",
                  color: diffLayout === layout ? "#cdd6f4" : "#89b4fa",
                }}
              >
                {layout === "split" ? "Split" : "Unified"}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  if (activeDiffMode) {
    return (
      <div ref={containerRef} style={containerStyle}>
        {tabBar}
        {diffModeToolbar}
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          <div style={diffFilePanelStyle} data-testid="diff-file-list">
            {diffLoading && diffFiles.length === 0 && (
              <div style={{ padding: "6px 8px", color: "#585b70", fontSize: 11 }}>Loading...</div>
            )}
            {!diffLoading && diffFiles.length === 0 && (
              <div style={{ padding: "6px 8px", color: "#585b70", fontSize: 11 }}>No changes</div>
            )}
            {diffFiles.map((f) => {
              const badgeColor = f.status === "A" ? "#a6e3a1" : f.status === "D" ? "#f38ba8" : f.status === "R" ? "#cba6f7" : "#f9e2af";
              return (
                <div
                  key={f.path}
                  onClick={() => selectDiffFile(f.path)}
                  title={f.path}
                  data-testid="diff-file-item"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "3px 8px",
                    cursor: "pointer",
                    fontSize: 11,
                    color: f.path === diffFilePath ? "#cdd6f4" : "#a6adc8",
                    background: f.path === diffFilePath ? "#313244" : "transparent",
                  }}
                  onMouseEnter={(e) => { if (f.path !== diffFilePath) (e.currentTarget as HTMLElement).style.background = "#1e1e2e"; }}
                  onMouseLeave={(e) => { if (f.path !== diffFilePath) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  <span style={{ color: badgeColor, fontWeight: 600, flexShrink: 0, width: 12, textAlign: "center" }}>{f.status}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
                </div>
              );
            })}
          </div>
          <div style={{ flex: 1 }}>
            {diffFilePath ? (
              <DiffEditor
                height="100%"
                language={detectLanguage(diffFilePath)}
                original={diffBefore}
                modified={diffAfter}
                theme="vs-dark"
                onMount={(editor) => { editorRef.current = editor.getModifiedEditor(); }}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: globalTextFont,
                  fontFamily: "'Cascadia Code', 'Consolas', monospace",
                  scrollBeyondLastLine: false,
                  renderSideBySide: diffLayout === "split",
                  overviewRulerBorder: false,
                }}
              />
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#585b70" }}>
                {diffFiles.length === 0 ? "No changes in this diff mode" : "Pick a file from the list"}
              </div>
            )}
          </div>
        </div>
        {overlays}
      </div>
    );
  }

  // ─── View mode ───
  if (mode === "view") {
    if (fileLoading) {
      return (
        <div ref={containerRef} style={{ ...containerStyle, alignItems: "center", justifyContent: "center" }}>
          {tabBar}
          <div style={{ color: "#585b70" }}>Loading...</div>
          {overlays}
        </div>
      );
    }

    if (!filePath && !fileLoading && !activeDiffMode) {
      return (
        <div ref={containerRef} style={{ ...containerStyle, alignItems: "center", justifyContent: "center" }}>
          {tabBar}
          <div style={{ color: "#585b70" }}>No file loaded — pick one from the Files tab</div>
          {fileError && <div style={errorTextStyle}>{fileError}</div>}
          {overlays}
        </div>
      );
    }

    const isEditorDirty = editorSnapshot?.dirty === true;
    const viewToolbar = (
      <div style={toolbarStyle}>
        <button
          onClick={handleBackToBrowse}
          style={{ ...toolbarButtonStyle, display: "flex", alignItems: "center" }}
          title="Go to folder"
          data-testid="repo-explorer-go-to-folder"
        >
          <ChevronUpIcon style={{ width: 16, height: 16 }} />
        </button>
        <button
          onClick={handleNavBack}
          disabled={!navStack || !navCanBack(navStack)}
          style={{
            ...toolbarButtonStyle,
            opacity: !navStack || !navCanBack(navStack) ? 0.35 : 1,
            cursor: !navStack || !navCanBack(navStack) ? "default" : "pointer",
          }}
          title="Previous file in this view"
          data-testid="repo-explorer-nav-back"
        >
          ←
        </button>
        <button
          onClick={handleNavForward}
          disabled={!navStack || !navCanFwd(navStack)}
          style={{
            ...toolbarButtonStyle,
            opacity: !navStack || !navCanFwd(navStack) ? 0.35 : 1,
            cursor: !navStack || !navCanFwd(navStack) ? "default" : "pointer",
          }}
          title="Next file in this view"
          data-testid="repo-explorer-nav-forward"
        >
          →
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", flex: 1 }}>
          <span style={{ ...pathTextStyle, display: "flex", alignItems: "center", gap: 4 }} data-testid="repo-explorer-file-title">
            {isMarkdown(filePath)
              ? <DocumentTextIcon style={{ width: 14, height: 14, flexShrink: 0 }} />
              : <DocumentIcon style={{ width: 14, height: 14, flexShrink: 0 }} />
            }
            {isEditorDirty && <span data-testid="repo-explorer-dirty-dot" style={dirtyDotStyle} />}
            {filePath}{isEditorDirty ? "*" : ""}
          </span>
        </div>
        {editorViewState && (
          <button
            onClick={editorViewState.toggle}
            style={{ background: "none", border: "none", color: "#89b4fa", cursor: "pointer", display: "flex", alignItems: "center", padding: "2px 4px" }}
            title={editorViewState.mode === "preview" ? "Edit (raw markdown)" : "Preview (rendered)"}
            data-testid="repo-explorer-md-toggle"
          >
            {editorViewState.mode === "preview"
              ? <PencilSquareIcon style={{ width: 14, height: 14 }} />
              : <EyeIcon style={{ width: 14, height: 14 }} />}
          </button>
        )}
        {workstreamId && filePath ? (
          <button
            onClick={toggleCommentsVisible}
            style={{
              background: commentsEnabled ? "#313244" : "none",
              border: "none",
              color: commentsEnabled ? "#a6e3a1" : "#89b4fa",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              padding: "2px 4px",
              borderRadius: 3,
            }}
            title={commentsEnabled ? "Hide inline comments" : "Show inline comments"}
            data-testid="repo-explorer-comments-toggle"
          >
            <ChatBubbleLeftRightIcon style={{ width: 14, height: 14 }} />
          </button>
        ) : null}
      </div>
    );

    if (shouldUseFileEditor(filePath) && !commitDiffHash) {
      return (
        <div ref={containerRef} style={containerStyle}>
      {tabBar}
          {viewToolbar}
          <div style={{ flex: 1, minHeight: 0 }}>
            <FileEditorView
              key={filePath}
              path={filePath}
              onBack={handleBackToBrowse}
              showHeader={false}
              renderMarkdownPreview={(markdownContent) => (
                <MarkdownView
                  style={markdownContainerStyle}
                  basePath={dirnameOf(filePath)}
                  onLinkClick={handleLinkClick}
                >{markdownContent}</MarkdownView>
              )}
              onSnapshotChange={setEditorSnapshot}
              onViewStateChange={setEditorViewState}
              comments={fileComments.comments}
              commentsEnabled={commentsEnabled}
              onAddComment={fileComments.add}
              onUpdateComment={fileComments.update}
              onDeleteComment={fileComments.remove}
            />
          </div>
          {overlays}
        </div>
      );
    }

    if (!commitDiffHash) {
      return (
        <div ref={containerRef} style={containerStyle}>
      {tabBar}
          {viewToolbar}
          <div style={unsupportedPreviewStyle}>Preview not supported for this file type.</div>
          {overlays}
        </div>
      );
    }

    // Legacy read-only rendering for virtual content such as commit diffs.
    return (
      <div ref={containerRef} style={containerStyle}>
      {tabBar}
        {viewToolbar}
        <div style={{ flex: 1 }}>
          <Editor
            height="100%"
            language="diff"
            value={content ?? ""}
            theme="vs-dark"
            onMount={(editor) => { editorRef.current = editor; }}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: globalTextFont,
              fontFamily: "'Cascadia Code', 'Consolas', monospace",
              scrollBeyondLastLine: false,
              wordWrap: "on",
              lineNumbers: "on",
              renderWhitespace: "none",
              overviewRulerBorder: false,
            }}
          />
        </div>
        {overlays}
      </div>
    );
  }

  // ─── SQLite mode ───
  if (mode === "sqlite") {
    return (
      <div ref={containerRef} style={containerStyle}>
        {tabBar}
        <div style={toolbarStyle}>
          <button
            onClick={handleBackToBrowse}
            style={{ ...toolbarButtonStyle, display: "flex", alignItems: "center" }}
            title="Go to folder"
            data-testid="repo-explorer-go-to-folder"
          >
            <ChevronUpIcon style={{ width: 16, height: 16 }} />
          </button>
          <span style={{ ...pathTextStyle, display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
            <TableCellsIcon style={{ width: 14, height: 14, flexShrink: 0, color: "#89b4fa" }} />
            {filePath}
          </span>
        </div>
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <SqliteTableView ops={fileSqliteOps(filePath)} limit={200} />
        </div>
        {overlays}
      </div>
    );
  }

  // ─── Audio mode ───
  if (mode === "audio") {
    return (
      <div ref={containerRef} style={containerStyle}>
        {tabBar}
        <div style={toolbarStyle}>
          <button
            onClick={handleBackToBrowse}
            style={{ ...toolbarButtonStyle, display: "flex", alignItems: "center" }}
            title="Go to folder"
            data-testid="repo-explorer-go-to-folder"
          >
            <ChevronUpIcon style={{ width: 16, height: 16 }} />
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", flex: 1 }}>
            <span style={{ ...pathTextStyle, display: "flex", alignItems: "center", gap: 4 }}>
              <MusicalNoteIcon style={{ width: 14, height: 14, color: "#cba6f7", flexShrink: 0 }} />
              {filePath}
            </span>
          </div>
        </div>
        {audioTooLarge ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, gap: 12, color: "#cdd6f4" }}>
            <MusicalNoteIcon style={{ width: 36, height: 36, color: "#cba6f7" }} />
            <div data-testid="audio-too-large" style={{ fontSize: 13, color: "#f9e2af", textAlign: "center" }}>
              File is too large to preview ({formatBytes(audioSizeBytes)} &gt; {formatBytes(AUDIO_SIZE_LIMIT_BYTES)}).
            </div>
            <div style={{ fontSize: 11, color: "#6c7086", wordBreak: "break-all", textAlign: "center", maxWidth: 480 }}>
              {filePath}
            </div>
            <button
              onClick={() => openPath(filePath).catch(() => {})}
              data-testid="audio-open-system-large"
              style={{
                background: "#313244",
                border: "1px solid #45475a",
                borderRadius: 4,
                color: "#cdd6f4",
                cursor: "pointer",
                fontSize: 12,
                padding: "6px 14px",
              }}
            >
              Open in system player
            </button>
          </div>
        ) : audioUrl ? (
          <div style={{ flex: 1, overflow: "hidden" }}>
            <AudioPlayer
              url={audioUrl}
              path={filePath}
              sizeBytes={audioSizeBytes}
              audioBytes={audioBytes}
              isFocused={isFocused}
            />
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#585b70" }}>
            {fileLoading ? "Loading audio…" : fileError ? fileError : "No audio loaded"}
          </div>
        )}
        {overlays}
      </div>
    );
  }

  // ─── Image mode ───
  if (mode === "image") {
    return (
      <div ref={containerRef} style={containerStyle}>
        {tabBar}
        <div style={toolbarStyle}>
          <button
            onClick={handleBackToBrowse}
            style={{ ...toolbarButtonStyle, display: "flex", alignItems: "center" }}
            title="Go to folder"
            data-testid="repo-explorer-go-to-folder"
          >
            <ChevronUpIcon style={{ width: 16, height: 16 }} />
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", flex: 1 }}>
            <span style={{ ...pathTextStyle, display: "flex", alignItems: "center", gap: 4 }}>
              <DocumentIcon style={{ width: 14, height: 14, color: "#f5c2e7", flexShrink: 0 }} />
              {filePath}
            </span>
            <span style={{ fontSize: 11, color: "#6c7086", marginLeft: 8 }}>
              {formatBytes(imageSizeBytes)}
            </span>
          </div>
        </div>
        {imageUrl ? (
          <div
            data-testid="image-preview"
            style={{
              flex: 1,
              overflow: "auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 12,
              background: "#181825",
            }}
          >
            <img
              src={imageUrl}
              alt={filePath}
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
                borderRadius: 4,
                boxShadow: "0 2px 12px rgba(0,0,0,0.5)",
              }}
            />
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#585b70" }}>
            {fileLoading ? "Loading image…" : fileError ? fileError : "No image loaded"}
          </div>
        )}
        {overlays}
      </div>
    );
  }

  // ─── Log mode ───
  if (mode === "log") {
    const hasTracking = logTracking && (logTracking.ahead > 0 || logTracking.behind > 0 || logTracking.remoteHeadShort);
    return (
      <div ref={containerRef} style={containerStyle}>
      {tabBar}
        <div style={toolbarStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", flex: 1 }}>
            <span style={{ ...pathTextStyle, display: "flex", alignItems: "center", gap: 4, color: "#f9e2af" }}>
              <ClockIcon style={{ width: 14, height: 14, flexShrink: 0 }} />
              Git Log{currentBranch ? ` — ${currentBranch}` : ""}
            </span>
            {hasTracking && logTracking && (
              <span data-testid="log-tracking-summary" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10 }}>
                {logTracking.ahead > 0 && (
                  <span title={`${logTracking.ahead} commit(s) on local not on origin/${currentBranch ?? ""}`}
                    style={{ color: "#a6e3a1", background: "#1e1e2e", border: "1px solid #313244", borderRadius: 4, padding: "1px 6px" }}>
                    ↑{logTracking.ahead}
                  </span>
                )}
                {logTracking.behind > 0 && (
                  <span title={`${logTracking.behind} commit(s) on origin/${currentBranch ?? ""} not on local`}
                    style={{ color: "#f38ba8", background: "#1e1e2e", border: "1px solid #313244", borderRadius: 4, padding: "1px 6px" }}>
                    ↓{logTracking.behind}
                  </span>
                )}
                {logTracking.ahead === 0 && logTracking.behind === 0 && logTracking.remoteHeadShort && (
                  <span title={`in sync with origin/${currentBranch ?? ""}`}
                    style={{ color: "#94e2d5", background: "#1e1e2e", border: "1px solid #313244", borderRadius: 4, padding: "1px 6px" }}>
                    ✓ synced
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
          {logLoading && (
            <div style={{ padding: "8px 12px", color: "#585b70" }}>Loading log...</div>
          )}
          {!logLoading && logCommits.length === 0 && (
            <div style={{ padding: "8px 12px", color: "#585b70" }}>No commits found</div>
          )}
          {logCommits.map((c) => {
            const isRemoteHead = !!logTracking?.remoteHeadShort && c.short_hash === logTracking.remoteHeadShort;
            return (
              <div
                key={c.hash}
                onClick={() => viewCommitDiff(c.hash)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  padding: "6px 12px",
                  cursor: "pointer",
                  borderBottom: "1px solid #181825",
                  borderLeft: isRemoteHead ? "3px solid #89b4fa" : "3px solid transparent",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                data-testid={`log-commit-${c.short_hash}`}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: "#f9e2af", fontFamily: "monospace", fontSize: 11, flexShrink: 0 }}>
                    {c.short_hash}
                  </span>
                  {isRemoteHead && currentBranch && (
                    <span
                      data-testid="log-remote-head-badge"
                      title={`origin/${currentBranch} points here`}
                      style={{ color: "#89b4fa", background: "#1e1e2e", border: "1px solid #45475a", borderRadius: 3, padding: "0 4px", fontSize: 9, fontFamily: "monospace", flexShrink: 0 }}
                    >
                      origin/{currentBranch}
                    </span>
                  )}
                  <span style={{ color: "#cdd6f4", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.message}
                  </span>
                </div>
                <div style={{ color: "#585b70", fontSize: 10 }}>
                  {c.author} · {c.date}
                </div>
              </div>
            );
          })}
        </div>
        {overlays}
      </div>
    );
  }

  // ─── Hooks mode ───
  if (mode === "hooks") {
    return (
      <div ref={containerRef} style={containerStyle}>
      {tabBar}
        <div style={toolbarStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", flex: 1 }}>
            <span style={{ ...pathTextStyle, display: "flex", alignItems: "center", gap: 4, color: "#f5c2e7" }}>
              <BoltIcon style={{ width: 14, height: 14, flexShrink: 0 }} />
              Git Hooks
            </span>
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          {/* Hooks list */}
          <div style={{ width: hookContent ? 200 : "100%", borderRight: hookContent ? "1px solid #313244" : "none", overflowY: "auto", flexShrink: 0 }}>
            {hooksLoading && (
              <div style={{ padding: "8px 12px", color: "#585b70" }}>Loading hooks...</div>
            )}
            {!hooksLoading && hooksList.length === 0 && (
              <div style={{ padding: "8px 12px", color: "#585b70" }}>No active hooks found</div>
            )}
            {hooksList.map((hook) => (
              <div
                key={hook.path}
                onClick={() => viewHookContent(hook)}
                style={{
                  padding: "6px 12px",
                  cursor: "pointer",
                  borderBottom: "1px solid #181825",
                  background: hookContent?.name === hook.name ? "#313244" : "transparent",
                }}
                onMouseEnter={(e) => { if (hookContent?.name !== hook.name) (e.currentTarget as HTMLElement).style.background = "#1e1e2e"; }}
                onMouseLeave={(e) => { if (hookContent?.name !== hook.name) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <BoltIcon style={{ width: 12, height: 12, color: "#f5c2e7", flexShrink: 0 }} />
                  <span style={{ color: "#cdd6f4", fontSize: 12, fontWeight: 500 }}>{hook.name}</span>
                </div>
                <div style={{ color: "#585b70", fontSize: 10, marginTop: 2, marginLeft: 18, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {hook.content_preview}
                </div>
              </div>
            ))}
          </div>
          {/* Hook content viewer */}
          {hookContent && (
            <div style={{ flex: 1, overflow: "auto" }}>
              <pre style={{ padding: "8px 12px", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 11, lineHeight: 1.5, color: "#cdd6f4", fontFamily: "monospace" }}>
                {hookContent.content}
              </pre>
            </div>
          )}
        </div>
        {overlays}
      </div>
    );
  }

  // ─── Browse mode ───

  return (
    <div ref={containerRef} style={containerStyle} data-testid="tile-explorer">
      {tabBar}
      {/* Path bar */}
      <div style={toolbarStyle}>
        <button onClick={navigateUp} style={{ ...toolbarButtonStyle, display: "flex", alignItems: "center" }} title="Go up">
          <ChevronUpIcon style={{ width: 16, height: 16 }} />
        </button>
        <span style={{ ...pathTextStyle, flex: 1 }}>
          {currentDir}
        </span>
        {currentBranch && (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 3,
              fontSize: 10,
              color: "#a6e3a1",
              background: "#1e1e2e",
              border: "1px solid #313244",
              borderRadius: 4,
              padding: "1px 6px",
              flexShrink: 0,
            }}
            data-testid="branch-badge"
          >
            <CodeBracketSquareIcon style={{ width: 12, height: 12 }} />
            {currentBranch}
          </span>
        )}
        <button onClick={() => loadDir(currentDir)} style={{ ...toolbarButtonStyle, display: "flex", alignItems: "center" }} title="Refresh">
          <ArrowPathIcon style={{ width: 14, height: 14 }} />
        </button>
        <button
          onClick={async (e) => { e.stopPropagation(); await handleBrowseDialog(); }}
          style={{ ...toolbarButtonStyle, display: "flex", alignItems: "center" }}
          title="Browse file..."
        >
          <FolderOpenIcon style={{ width: 16, height: 16 }} />
        </button>
      </div>

      {/* Search bar */}
      <div style={{
        padding: "3px 8px",
        background: "#181825",
        borderBottom: "1px solid #313244",
        flexShrink: 0,
      }}>
        <input
          type="text"
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Filter files..."
          style={{
            width: "100%",
            background: "#313244",
            border: "1px solid #45475a",
            borderRadius: 3,
            color: "#cdd6f4",
            padding: "3px 8px",
            fontSize: 11,
            fontFamily: "monospace",
            outline: "none",
          }}
        />
      </div>

      {/* File list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
        {dirLoading && (
          <div style={{ padding: "8px 12px", color: "#585b70" }}>Loading...</div>
        )}
        {dirError && (
          <div style={{ padding: "8px 12px", color: "#f38ba8", fontSize: 11 }}>{dirError}</div>
        )}
        {!dirLoading && filteredEntries.length === 0 && !dirError && (
          <div style={{ padding: "8px 12px", color: "#585b70" }}>
            {searchFilter ? "No matches" : "Empty directory"}
          </div>
        )}
        {filteredEntries.map((entry) => (
          <div
            key={entry.name}
            data-testid="file-tree-item"
            data-path={entry.fullPath}
            onClick={() => handleEntryClick(entry)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY, path: entry.fullPath, isDir: entry.isDir });
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "3px 12px",
              cursor: "pointer",
              color: entry.isDir ? "#89b4fa" : "#cdd6f4",
              fontWeight: entry.isDir ? 500 : 400,
              fontSize: 13,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          >
            <span style={{ width: 20, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <FileIcon name={entry.name} isDir={entry.isDir} />
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {entry.name}
            </span>
          </div>
        ))}
      </div>
      {overlays}
    </div>
  );
}

// ─── Shared styles ───

const containerStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  background: "#1e1e2e",
  color: "#cdd6f4",
  fontFamily: "monospace",
  fontSize: 12,
  position: "relative",
};

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  gap: 0,
  background: "#11111b",
  borderBottom: "1px solid #313244",
  flexShrink: 0,
  padding: "0 4px",
};

const tabButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  background: "transparent",
  border: "none",
  padding: "5px 10px",
  cursor: "pointer",
  fontSize: 11,
  fontFamily: "inherit",
};

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px",
  background: "#181825",
  borderBottom: "1px solid #313244",
  flexShrink: 0,
};

const toolbarButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#89b4fa",
  cursor: "pointer",
  fontSize: 12,
  padding: "0 4px",
};

const pathTextStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "#585b70",
  fontSize: 11,
};

const errorTextStyle: React.CSSProperties = {
  color: "#f38ba8",
  fontSize: 11,
  marginTop: 4,
};

const markdownContainerStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
};

const dirtyDotStyle: React.CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  background: "#f9e2af",
  flexShrink: 0,
};

const unsupportedPreviewStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#585b70",
  padding: 24,
  textAlign: "center",
};

const searchOverlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "rgba(0, 0, 0, 0.5)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  paddingTop: 40,
  zIndex: 100,
};

const searchModalStyle: React.CSSProperties = {
  width: "80%",
  maxWidth: 500,
  background: "#1e1e2e",
  border: "1px solid #45475a",
  borderRadius: 6,
  overflow: "hidden",
  boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
};

const searchInputStyle: React.CSSProperties = {
  width: "100%",
  background: "#181825",
  border: "none",
  borderBottom: "1px solid #313244",
  color: "#cdd6f4",
  padding: "10px 14px",
  fontSize: 13,
  fontFamily: "monospace",
  outline: "none",
  boxSizing: "border-box",
};

const searchResultsStyle: React.CSSProperties = {
  maxHeight: 300,
  overflowY: "auto",
};

const searchResultItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "5px 14px",
  cursor: "pointer",
  color: "#cdd6f4",
};

const diffFilePanelStyle: React.CSSProperties = {
  width: 180,
  minWidth: 120,
  borderRight: "1px solid #313244",
  background: "#181825",
  overflowY: "auto",
  flexShrink: 0,
};
