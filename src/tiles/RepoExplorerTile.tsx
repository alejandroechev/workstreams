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
import { isAudioFile, isImageFile, makeAudioBlobUrl, makeImageBlobUrl, dirnameOf, classifyLinkTarget, type LinkTargetKind } from "../domain/file-types";
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
  MagnifyingGlassIcon,
  MinusIcon,
  PlusIcon,
  MusicalNoteIcon,
  EyeIcon,
  PencilSquareIcon,
  ClipboardDocumentIcon,
  BeakerIcon,
} from "@heroicons/react/24/outline";
import { openPath } from "@tauri-apps/plugin-opener";
import { writeTextToClipboard } from "../domain/clipboard";
import { dispatchAddToWorkbench } from "../domain/workbench-events";
import type { FileSearchMatch } from "../backend/types";

interface Props {
  tileId: string;
  isFocused: boolean;
  rootDir?: string;
  initialPath?: string;
  workstreamId?: string;
}

interface DirEntry {
  name: string;
  isDir: boolean;
  fullPath: string;
  modifiedEpoch: number;
  size: number;
}

type Mode = "browse" | "view" | "audio" | "image" | "log" | "hooks";
type DiffMode = "unstaged" | "last_commit" | "branch_vs_master";

const MARKDOWN_EXTS = new Set(["md", "mdx", "markdown"]);
const FILE_EDITOR_EXCLUDED_EXTS = new Set([
  "wav", "mp3", "ogg", "flac",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico",
  "mp4", "mov", "webm",
  "pdf", "zip", "gz", "tar", "7z", "exe", "dll", "so", "dylib",
]);
const AUDIO_SIZE_LIMIT_BYTES = 100 * 1024 * 1024; // 100 MB

function extensionFor(path: string): string {
  return path.split(/[\\/.]/).pop()?.toLowerCase() || "";
}

function isMarkdown(path: string): boolean {
  return MARKDOWN_EXTS.has(extensionFor(path));
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

export default function RepoExplorerTile({ tileId: _tileId, isFocused, rootDir, initialPath, workstreamId }: Props) {
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
  const [diffFiles, setDiffFiles] = useState<string[]>([]);
  const [diffContent, setDiffContent] = useState<string>("");
  const [diffFilePath, setDiffFilePath] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  // Git branch state
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  // Git log state
  const [logCommits, setLogCommits] = useState<Array<{ hash: string; short_hash: string; message: string; author: string; date: string }>>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [commitDiffHash, setCommitDiffHash] = useState<string>("");
  // Git hooks state
  const [hooksList, setHooksList] = useState<Array<{ name: string; path: string; content_preview: string }>>([]);
  const [hooksLoading, setHooksLoading] = useState(false);
  const [hookContent, setHookContent] = useState<{ name: string; content: string } | null>(null);
  const [editorSnapshot, setEditorSnapshot] = useState<BufferSnapshot | null>(null);
  // Markdown view/edit toggle from FileEditorView. Null when the current
  // file isn't markdown or no toggle is meaningful (conflict, save_blocked).
  const [editorViewState, setEditorViewState] = useState<{ mode: "preview" | "edit"; toggle: () => void } | null>(null);
  // Right-click context menu state. Anchored to viewport coordinates of
  // the contextmenu event; null when closed.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(null);

  // Font size (Ctrl+= / Ctrl+- and A-/A+ toolbar buttons)
  const [fontSize, setFontSize] = useState<number>(13);

  // Ctrl+P keyboard navigation
  const [fileSearchSelectedIndex, setFileSearchSelectedIndex] = useState(0);

  // Ctrl+Shift+F cross-file content search
  const [showContentSearch, setShowContentSearch] = useState(false);
  const [contentSearchQuery, setContentSearchQuery] = useState("");
  const [contentSearchResults, setContentSearchResults] = useState<FileSearchMatch[]>([]);
  const [contentSearchLoading, setContentSearchLoading] = useState(false);
  const [contentSearchSelectedIndex, setContentSearchSelectedIndex] = useState(0);
  const contentSearchInputRef = useRef<HTMLInputElement>(null);

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

  // Watch directory for filesystem changes (replaces 3s polling)
  useEffect(() => {
    invoke("watch_directory", { path: currentDir }).catch(() => {});
    const unlisten = listen<{ path: string; kind: string }>("fs-change", async (event) => {
      // Check if the change is within our current directory
      const changedPath = event.payload.path.replace(/\//g, "\\");
      const normalDir = currentDir.replace(/\//g, "\\");
      if (!changedPath.startsWith(normalDir)) return;

      if (mode === "browse" && !activeDiffMode) {
        // Refresh directory listing
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
      } else if (mode === "view" && filePath && !shouldUseFileEditor(filePath)) {
        // Refresh legacy read-only content if the changed file matches.
        const normalFile = filePath.replace(/\//g, "\\");
        if (changedPath === normalFile || changedPath.startsWith(normalDir)) {
          try {
            const newContent = await backend.readFile(filePath);
            setContent((prev) => prev === newContent ? prev : newContent);
          } catch { /* ignore */ }
        }
      }
    });
    return () => {
      invoke("unwatch_directory", { path: currentDir }).catch(() => {});
      unlisten.then((u) => u());
    };
  }, [currentDir, mode, activeDiffMode, filePath, backend]);

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
      setDiffContent("");
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
  const activateDiffMode = useCallback(async (diffMode: DiffMode) => {
    setActiveDiffMode(diffMode);
    setDiffLoading(true);
    setDiffContent("");
    setDiffFilePath("");
    try {
      const files = await backend.gitDiffFiles(gitRoot, diffMode);
      setDiffFiles(files);
      if (files.length > 0) {
        const firstFile = files[0];
        setDiffFilePath(firstFile);
        const diff = await backend.gitDiffFile(gitRoot, firstFile, diffMode);
        setDiffContent(diff);
      }
    } catch (e) {
      console.error("[Explorer] diff error:", e);
      setDiffFiles([]);
    } finally {
      setDiffLoading(false);
    }
  }, [backend, gitRoot]);

  const selectDiffFile = useCallback(async (file: string) => {
    if (!activeDiffMode) return;
    setDiffFilePath(file);
    setDiffLoading(true);
    try {
      const diff = await backend.gitDiffFile(gitRoot, file, activeDiffMode);
      setDiffContent(diff);
    } catch {
      setDiffContent("");
    } finally {
      setDiffLoading(false);
    }
  }, [backend, gitRoot, activeDiffMode]);

  const exitDiffMode = useCallback(() => {
    setActiveDiffMode(null);
    setDiffContent("");
    setDiffFiles([]);
    setDiffFilePath("");
  }, []);

  // Git log handlers
  const openGitLog = useCallback(async () => {
    setMode("log");
    setLogLoading(true);
    setCommitDiffHash("");
    try {
      const commits = await backend.gitLog(gitRoot, 50);
      setLogCommits(commits);
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
      setDiffContent("");
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
        setDiffContent("");
        setDiffFiles([]);
        setDiffFilePath("");
        openGitLog();
        break;
      case "hooks":
        setActiveDiffMode(null);
        setDiffContent("");
        setDiffFiles([]);
        setDiffFilePath("");
        openGitHooks();
        break;
    }
  }, [activeTab, activateDiffMode, openGitLog, openGitHooks]);

  // Reset Ctrl+P selection when results change
  useEffect(() => { setFileSearchSelectedIndex(0); }, [fileSearchResults]);
  useEffect(() => { setContentSearchSelectedIndex(0); }, [contentSearchResults]);

  // Ctrl+Shift+F: open cross-file content search overlay
  useEffect(() => {
    if (!isFocused) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        e.stopPropagation();
        setShowContentSearch(true);
        setContentSearchQuery("");
        setContentSearchResults([]);
        setTimeout(() => contentSearchInputRef.current?.focus(), 50);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isFocused]);

  // Font-size shortcuts (Ctrl+= / Ctrl+- / Ctrl+0)
  useEffect(() => {
    if (!isFocused) return;
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setFontSize((s) => Math.min(28, s + 1));
      } else if (e.key === "-") {
        e.preventDefault();
        setFontSize((s) => Math.max(8, s - 1));
      } else if (e.key === "0") {
        e.preventDefault();
        setFontSize(13);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isFocused]);

  // Debounced cross-file content search (Ctrl+Shift+F).
  // Same cancellation pattern as Ctrl+P: bump the Rust epoch on cleanup so
  // a slow walk doesn't keep the IPC queue full and freeze adjacent tiles.
  useEffect(() => {
    if (!showContentSearch || !contentSearchQuery.trim()) {
      setContentSearchResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try { await backend.cancelSearches(); } catch { /* ignore */ }
      if (cancelled) return;
      setContentSearchLoading(true);
      try {
        const root = rootDir || currentDir;
        const r = await backend.searchInFiles(root, contentSearchQuery.trim());
        if (!cancelled) setContentSearchResults(r);
      } catch {
        if (!cancelled) setContentSearchResults([]);
      } finally {
        if (!cancelled) setContentSearchLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      void backend.cancelSearches();
    };
  }, [contentSearchQuery, showContentSearch, backend, rootDir, currentDir]);

  const closeContentSearch = useCallback(() => {
    setShowContentSearch(false);
    setContentSearchQuery("");
    setContentSearchResults([]);
  }, []);

  const triggerEditorFind = useCallback(() => {
    const ed = editorRef.current as { getAction?: (id: string) => { run?: () => void } | undefined } | null;
    ed?.getAction?.("actions.find")?.run?.();
  }, []);

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
      <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
        <button
          onClick={() => setFontSize((s) => Math.max(8, s - 1))}
          style={tabIconButtonStyle}
          title="Decrease font size (Ctrl+-)"
          data-testid="repo-explorer-font-dec"
        >
          <MinusIcon style={{ width: 12, height: 12 }} />
        </button>
        <span style={{ fontSize: 10, color: "#6c7086", minWidth: 20, textAlign: "center" }} data-testid="repo-explorer-font-size">{fontSize}</span>
        <button
          onClick={() => setFontSize((s) => Math.min(28, s + 1))}
          style={tabIconButtonStyle}
          title="Increase font size (Ctrl+=)"
          data-testid="repo-explorer-font-inc"
        >
          <PlusIcon style={{ width: 12, height: 12 }} />
        </button>
      </div>
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

  // ─── Ctrl+Shift+F Content Search Overlay (cross-file, scoped to tile) ───
  const contentSearchOverlay = showContentSearch ? (
    <div style={searchOverlayStyle} data-testid="content-search-overlay" onClick={closeContentSearch}>
      <div style={searchModalStyle} onClick={(e) => e.stopPropagation()}>
        <input
          ref={contentSearchInputRef}
          type="text"
          value={contentSearchQuery}
          onChange={(e) => setContentSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") closeContentSearch();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setContentSearchSelectedIndex((i) => Math.min(contentSearchResults.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setContentSearchSelectedIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const m = contentSearchResults[contentSearchSelectedIndex];
              if (m) {
                const q = contentSearchQuery.trim();
                closeContentSearch();
                openFile(m.path).then(() => {
                  // After file loads, trigger Monaco find with the query
                  setTimeout(() => {
                    const ed = editorRef.current as
                      | { getAction?: (id: string) => { run?: () => void } | undefined; trigger?: (s: string, id: string, p: unknown) => void }
                      | null;
                    try {
                      ed?.trigger?.("repo-explorer", "actions.find", null);
                      // Best-effort: set find input value via clipboard-like API isn't directly exposed,
                      // so users will just see the find widget open; they can paste the query.
                      // (We keep query for them to retype if needed.)
                      void q;
                    } catch { /* ignore */ }
                  }, 200);
                }).catch(() => {});
              }
            }
          }}
          placeholder="Search in files (content)…"
          style={searchInputStyle}
          data-testid="content-search-input"
        />
        <div style={searchResultsStyle}>
          {contentSearchLoading && (
            <div style={{ padding: "8px 12px", color: "#585b70" }}>Searching…</div>
          )}
          {!contentSearchLoading && contentSearchQuery && contentSearchResults.length === 0 && (
            <div style={{ padding: "8px 12px", color: "#585b70" }}>No matches</div>
          )}
          {contentSearchResults.map((m, idx) => {
            const selected = idx === contentSearchSelectedIndex;
            const fileName = m.path.split(/[\\/]/).pop() || m.path;
            return (
              <div
                key={`${m.path}:${m.line_number}:${idx}`}
                onClick={() => { closeContentSearch(); openFile(m.path); }}
                onMouseEnter={() => setContentSearchSelectedIndex(idx)}
                style={{
                  ...searchResultItemStyle,
                  flexDirection: "column",
                  alignItems: "stretch",
                  background: selected ? "#313244" : "transparent",
                  gap: 2,
                }}
                data-testid={`content-search-result-${idx}`}
                data-selected={selected ? "true" : "false"}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <FileIcon name={fileName} isDir={false} />
                  <span style={{ fontSize: 11, color: "#cdd6f4" }}>{fileName}</span>
                  <span style={{ fontSize: 10, color: "#6c7086" }}>:{m.line_number}</span>
                  <span style={{ flex: 1, fontSize: 10, color: "#585b70", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.path}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "#a6adc8", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingLeft: 22 }}>
                  {m.line_text}
                </div>
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
      {contentSearchOverlay}
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

    // Diff toolbar buttons
    const diffToolbar = (
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
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
      </div>
    );

    const displayedFilePath = activeDiffMode && diffFilePath ? diffFilePath : filePath;
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
            {displayedFilePath}{isEditorDirty ? "*" : ""}
          </span>
        </div>
        {editorViewState && (
          <button
            onClick={editorViewState.toggle}
            style={{ ...toolbarButtonStyle, display: "flex", alignItems: "center", gap: 4 }}
            title={editorViewState.mode === "preview" ? "Edit (raw markdown)" : "Preview (rendered)"}
            data-testid="repo-explorer-md-toggle"
          >
            {editorViewState.mode === "preview" ? (
              <><PencilSquareIcon style={{ width: 14, height: 14 }} /><span>Edit</span></>
            ) : (
              <><EyeIcon style={{ width: 14, height: 14 }} /><span>View</span></>
            )}
          </button>
        )}
        <button
          onClick={triggerEditorFind}
          style={{ ...toolbarButtonStyle, display: "flex", alignItems: "center", gap: 2 }}
          title="Find in file (Ctrl+F)"
          data-testid="find-in-file-btn"
        >
          <MagnifyingGlassIcon style={{ width: 14, height: 14 }} />
        </button>
        {diffToolbar}
      </div>
    );

    // Diff view mode
    if (activeDiffMode) {
      const { original, modified } = parseDiffToSides(diffContent);
      return (
        <div ref={containerRef} style={containerStyle}>
      {tabBar}
          {viewToolbar}
          <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
            {/* Diff file list panel */}
            <div style={diffFilePanelStyle} data-testid="diff-file-list">
              {diffLoading && <div style={{ padding: "6px 8px", color: "#585b70", fontSize: 11 }}>Loading...</div>}
              {!diffLoading && diffFiles.length === 0 && (
                <div style={{ padding: "6px 8px", color: "#585b70", fontSize: 11 }}>No changes</div>
              )}
              {diffFiles.map((f) => (
                <div
                  key={f}
                  onClick={() => selectDiffFile(f)}
                  style={{
                    padding: "3px 8px",
                    cursor: "pointer",
                    fontSize: 11,
                    color: f === diffFilePath ? "#cdd6f4" : "#a6adc8",
                    background: f === diffFilePath ? "#313244" : "transparent",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  onMouseEnter={(e) => { if (f !== diffFilePath) (e.currentTarget as HTMLElement).style.background = "#1e1e2e"; }}
                  onMouseLeave={(e) => { if (f !== diffFilePath) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  {f.split("/").pop() || f}
                </div>
              ))}
            </div>
            {/* Diff editor */}
            <div style={{ flex: 1 }}>
              <DiffEditor
                height="100%"
                language={detectLanguage(diffFilePath || filePath)}
                original={original}
                modified={modified}
                theme="vs-dark"
                onMount={(editor) => { editorRef.current = editor.getModifiedEditor(); }}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize,
                  fontFamily: "'Cascadia Code', 'Consolas', monospace",
                  scrollBeyondLastLine: false,
                  renderSideBySide: false,
                  overviewRulerBorder: false,
                }}
              />
            </div>
          </div>
          {overlays}
        </div>
      );
    }

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
                  baseFontSize={fontSize}
                  basePath={dirnameOf(filePath)}
                  onLinkClick={handleLinkClick}
                >{markdownContent}</MarkdownView>
              )}
              onSnapshotChange={setEditorSnapshot}
              onViewStateChange={setEditorViewState}
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
              fontSize,
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
    return (
      <div ref={containerRef} style={containerStyle}>
      {tabBar}
        <div style={toolbarStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", flex: 1 }}>
            <span style={{ ...pathTextStyle, display: "flex", alignItems: "center", gap: 4, color: "#f9e2af" }}>
              <ClockIcon style={{ width: 14, height: 14, flexShrink: 0 }} />
              Git Log{currentBranch ? ` — ${currentBranch}` : ""}
            </span>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
          {logLoading && (
            <div style={{ padding: "8px 12px", color: "#585b70" }}>Loading log...</div>
          )}
          {!logLoading && logCommits.length === 0 && (
            <div style={{ padding: "8px 12px", color: "#585b70" }}>No commits found</div>
          )}
          {logCommits.map((c) => (
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
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              data-testid={`log-commit-${c.short_hash}`}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: "#f9e2af", fontFamily: "monospace", fontSize: 11, flexShrink: 0 }}>
                  {c.short_hash}
                </span>
                <span style={{ color: "#cdd6f4", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.message}
                </span>
              </div>
              <div style={{ color: "#585b70", fontSize: 10 }}>
                {c.author} · {c.date}
              </div>
            </div>
          ))}
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

  // Diff mode toolbar for browse mode
  const browseDiffToolbar = (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 4,
      padding: "3px 8px",
      background: "#181825",
      borderBottom: "1px solid #313244",
      flexShrink: 0,
    }}>
      <span style={{ fontSize: 10, color: "#585b70", marginRight: 4 }}>Diff:</span>
      {(["unstaged", "last_commit", "branch_vs_master"] as DiffMode[]).map((dm) => (
        <button
          key={dm}
          onClick={(e) => {
            e.stopPropagation();
            if (activeDiffMode === dm) exitDiffMode();
            else activateDiffMode(dm);
          }}
          style={{
            background: activeDiffMode === dm ? "#45475a" : "transparent",
            border: activeDiffMode === dm ? "1px solid #585b70" : "1px solid transparent",
            borderRadius: 3,
            color: activeDiffMode === dm ? "#cdd6f4" : "#6c7086",
            cursor: "pointer",
            fontSize: 10,
            padding: "2px 6px",
          }}
        >
          {dm === "unstaged" ? "Unstaged" : dm === "last_commit" ? "Last Commit" : "vs Master"}
        </button>
      ))}
      {activeDiffMode && diffFiles.length > 0 && (
        <span style={{ fontSize: 10, color: "#a6e3a1", marginLeft: 4 }}>
          {diffFiles.length} file{diffFiles.length !== 1 ? "s" : ""} changed
        </span>
      )}
    </div>
  );

  // When diff mode is active in browse, show diff files instead of directory entries
  const browseFileList = activeDiffMode ? diffFiles : [];

  return (
    <div ref={containerRef} style={containerStyle} data-testid="tile-explorer">
      {tabBar}
      {/* Path bar */}
      <div style={toolbarStyle}>
        {activeDiffMode ? (
          <>
            <span style={{ ...pathTextStyle, flex: 1, color: "#f9e2af" }}>
              {activeDiffMode === "unstaged" ? "Unstaged Changes" : activeDiffMode === "last_commit" ? "Last Commit" : "Branch vs Master"}
            </span>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>

      {/* Diff mode selector */}
      {/* Diff sub-mode selector (only shown in Diff tab) */}
      {activeTab === "diff" && browseDiffToolbar}

      {/* Search bar (only in normal browse, not diff mode) */}
      {!activeDiffMode && (
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
      )}

      {/* File list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
        {activeDiffMode ? (
          // Diff mode: show changed files
          <>
            {diffLoading && (
              <div style={{ padding: "8px 12px", color: "#585b70" }}>Loading diff...</div>
            )}
            {!diffLoading && browseFileList.length === 0 && (
              <div style={{ padding: "8px 12px", color: "#585b70" }}>No changes found</div>
            )}
            {browseFileList.map((file) => (
              <div
                key={file}
                onClick={() => {
                  // Switch to view mode showing only this file's diff
                  setDiffFilePath(file);
                  setFilePath(file);
                  setMode("view");
                  // Load diff content for this file
                  selectDiffFile(file);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 12px",
                  cursor: "pointer",
                  color: "#f9e2af",
                  fontSize: 12,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <span style={{ fontSize: 12, color: "#f38ba8", flexShrink: 0 }}>M</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {file}
                </span>
              </div>
            ))}
          </>
        ) : (
          // Normal browse mode
          <>
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
                  fontSize,
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
          </>
        )}
      </div>
      {overlays}
    </div>
  );
}

// ─── File context menu ───

interface FileContextMenuProps {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
  workstreamId: string | null;
  onClose: () => void;
}

function FileContextMenu({ x, y, path, isDir, workstreamId, onClose }: FileContextMenuProps) {
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
  const segments = path.split(/[\\/]/).filter(Boolean);
  const name = segments[segments.length - 1] || path;

  return (
    <div
      ref={ref}
      data-testid="file-context-menu"
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
      <ContextMenuItem
        icon={<ClipboardDocumentIcon style={{ width: 14, height: 14, color: "#a6adc8", flexShrink: 0 }} />}
        label="Copy full path"
        onClick={close(() => { void writeTextToClipboard(path); })}
        testid="ctx-copy-path"
      />
      <ContextMenuItem
        icon={<ClipboardDocumentIcon style={{ width: 14, height: 14, color: "#a6adc8", flexShrink: 0 }} />}
        label={isDir ? "Copy folder name" : "Copy file name"}
        onClick={close(() => { void writeTextToClipboard(name); })}
        testid="ctx-copy-name"
      />
      <ContextMenuItem
        icon={<FolderOpenIcon style={{ width: 14, height: 14, color: "#a6adc8", flexShrink: 0 }} />}
        label="Open in system"
        onClick={close(() => { openPath(path).catch(() => {}); })}
        testid="ctx-open-system"
      />
      {!isDir && (
        <ContextMenuItem
          icon={<BeakerIcon style={{ width: 14, height: 14, color: "#a6adc8", flexShrink: 0 }} />}
          label="Add to Workbench"
          onClick={close(() => { dispatchAddToWorkbench({ path, workstreamId }); })}
          testid="ctx-add-to-workbench"
        />
      )}
    </div>
  );
}

function ContextMenuItem({
  icon, label, onClick, testid,
}: { icon: React.ReactNode; label: string; onClick: () => void; testid: string }) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      style={{
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
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
    >
      {icon}
      <span>{label}</span>
    </button>
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

const tabIconButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#6c7086",
  cursor: "pointer",
  padding: "0 4px",
  display: "flex",
  alignItems: "center",
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
