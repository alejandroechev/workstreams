import { useState, useEffect, useCallback, useRef } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { open } from "@tauri-apps/plugin-dialog";
import { useBackend } from "../backend/context";
import { detectLanguage } from "../domain/tile-config";

interface Props {
  tileId: string;
  isFocused: boolean;
  rootDir?: string;
  initialPath?: string;
}

interface DirEntry {
  name: string;
  isDir: boolean;
  fullPath: string;
}

type Mode = "browse" | "view";
type DiffMode = "unstaged" | "last_commit" | "branch_vs_master";

const MARKDOWN_EXTS = new Set(["md", "mdx", "markdown"]);

function isMarkdown(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return MARKDOWN_EXTS.has(ext);
}

function parseEntries(raw: string[], currentDir: string): DirEntry[] {
  return raw.map((entry) => {
    const isDir = entry.startsWith("📁 ");
    const name = entry.replace(/^📁 /, "").replace(/^ {3}/, "");
    const sep = currentDir.endsWith("\\") ? "" : "\\";
    return { name, isDir, fullPath: `${currentDir}${sep}${name}` };
  });
}

function fileIcon(name: string, isDir: boolean): string {
  if (isDir) return "📁";
  const ext = name.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "ts": case "tsx": return "🟦";
    case "js": case "jsx": return "🟨";
    case "rs": return "🦀";
    case "json": return "📋";
    case "md": case "mdx": return "📝";
    case "toml": case "yaml": case "yml": return "⚙️";
    case "css": return "🎨";
    case "html": return "🌐";
    case "png": case "jpg": case "ico": case "svg": return "🖼️";
    case "lock": return "🔒";
    default: return "📄";
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

export default function ExplorerTile({ tileId, isFocused, rootDir, initialPath }: Props) {
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

  const containerRef = useRef<HTMLDivElement>(null);

  const loadDir = useCallback(async (dir: string) => {
    setDirLoading(true);
    setDirError(null);
    try {
      const raw = await backend.listDirectory(dir);
      setEntries(parseEntries(raw, dir));
      setCurrentDir(dir);
    } catch (e) {
      setDirError(String(e));
    } finally {
      setDirLoading(false);
    }
  }, [backend]);

  const openFile = useCallback(async (path: string) => {
    if (!path.trim()) return;
    setFileError(null);
    setFileLoading(true);
    try {
      const data = await backend.readFile(path.trim());
      setContent(data);
      setFilePath(path.trim());
      setMode("view");
      setActiveDiffMode(null);
      setDiffContent("");
      setDiffFilePath("");
    } catch (e) {
      setFileError(String(e));
      setContent(null);
    } finally {
      setFileLoading(false);
    }
  }, [backend]);

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

  // Debounced file search
  useEffect(() => {
    if (!showFileSearch || !fileSearchQuery.trim()) {
      setFileSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setFileSearchLoading(true);
      try {
        const results = await backend.searchFiles(currentDir, fileSearchQuery.trim());
        setFileSearchResults(results);
      } catch {
        setFileSearchResults([]);
      } finally {
        setFileSearchLoading(false);
      }
    }, 200);
    return () => clearTimeout(timer);
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
      openFile(entry.fullPath);
    }
  };

  const goBackToBrowse = () => {
    setMode("browse");
    setContent(null);
    setFilePath("");
    setFileError(null);
    setActiveDiffMode(null);
    setDiffContent("");
    setDiffFiles([]);
    setDiffFilePath("");
    if (entries.length === 0) {
      loadDir(currentDir);
    }
  };

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

  // Filter entries by search
  const filteredEntries = searchFilter
    ? entries.filter((e) => e.name.toLowerCase().includes(searchFilter.toLowerCase()))
    : entries;

  // ─── Ctrl+P Search Overlay ───
  const fileSearchOverlay = showFileSearch ? (
    <div style={searchOverlayStyle} data-testid="file-search-overlay">
      <div style={searchModalStyle}>
        <input
          ref={fileSearchInputRef}
          type="text"
          value={fileSearchQuery}
          onChange={(e) => setFileSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") closeFileSearch();
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
          {fileSearchResults.map((path) => (
            <div
              key={path}
              onClick={() => { closeFileSearch(); openFile(path); }}
              style={searchResultItemStyle}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              <span style={{ fontSize: 12, width: 16, textAlign: "center", flexShrink: 0 }}>
                {fileIcon(path.split("\\").pop() || path, false)}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>
                {path}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  ) : null;

  // ─── View mode ───
  if (mode === "view") {
    if (fileLoading) {
      return (
        <div ref={containerRef} style={{ ...containerStyle, alignItems: "center", justifyContent: "center" }}>
          <div style={{ color: "#585b70" }}>Loading...</div>
          {fileSearchOverlay}
        </div>
      );
    }

    if (content === null && !fileLoading) {
      return (
        <div ref={containerRef} style={{ ...containerStyle, alignItems: "center", justifyContent: "center" }}>
          <div style={{ color: "#585b70" }}>No file loaded</div>
          <button onClick={goBackToBrowse} style={backButtonStyle}>← Back</button>
          {fileError && <div style={errorTextStyle}>{fileError}</div>}
          {fileSearchOverlay}
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

    const viewToolbar = (
      <div style={toolbarStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", flex: 1 }}>
          <button onClick={goBackToBrowse} style={toolbarButtonStyle} title="Back to browser">
            ← Back
          </button>
          <span style={pathTextStyle}>
            {isMarkdown(filePath) ? "📝" : "📄"} {activeDiffMode && diffFilePath ? diffFilePath : filePath}
          </span>
        </div>
        {diffToolbar}
      </div>
    );

    // Diff view mode
    if (activeDiffMode) {
      const { original, modified } = parseDiffToSides(diffContent);
      return (
        <div ref={containerRef} style={containerStyle}>
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
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 13,
                  fontFamily: "'Cascadia Code', 'Consolas', monospace",
                  scrollBeyondLastLine: false,
                  renderSideBySide: false,
                  overviewRulerBorder: false,
                }}
              />
            </div>
          </div>
          {fileSearchOverlay}
        </div>
      );
    }

    // Markdown rendering
    if (isMarkdown(filePath)) {
      return (
        <div ref={containerRef} style={containerStyle}>
          {viewToolbar}
          <div style={markdownContainerStyle}>
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {content}
            </Markdown>
          </div>
          {fileSearchOverlay}
        </div>
      );
    }

    // Code rendering (Monaco)
    return (
      <div ref={containerRef} style={containerStyle}>
        {viewToolbar}
        <div style={{ flex: 1 }}>
          <Editor
            height="100%"
            language={detectLanguage(filePath)}
            value={content ?? ""}
            theme="vs-dark"
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: "'Cascadia Code', 'Consolas', monospace",
              scrollBeyondLastLine: false,
              wordWrap: "on",
              lineNumbers: "on",
              renderWhitespace: "none",
              overviewRulerBorder: false,
            }}
          />
        </div>
        {fileSearchOverlay}
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
          onClick={() => activeDiffMode === dm ? exitDiffMode() : activateDiffMode(dm)}
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
    <div ref={containerRef} style={containerStyle}>
      {/* Path bar */}
      <div style={toolbarStyle}>
        {activeDiffMode ? (
          <>
            <button onClick={exitDiffMode} style={{ ...toolbarButtonStyle, fontSize: 11 }} title="Exit diff mode">
              ← Browse
            </button>
            <span style={{ ...pathTextStyle, flex: 1, color: "#f9e2af" }}>
              {activeDiffMode === "unstaged" ? "Unstaged Changes" : activeDiffMode === "last_commit" ? "Last Commit" : "Branch vs Master"}
            </span>
          </>
        ) : (
          <>
            <button onClick={navigateUp} style={{ ...toolbarButtonStyle, fontSize: 14 }} title="Go up">
              ⬆
            </button>
            <span style={{ ...pathTextStyle, flex: 1 }}>
              {currentDir}
            </span>
            <button onClick={() => loadDir(currentDir)} style={toolbarButtonStyle} title="Refresh">
              ↻
            </button>
            <button
              onClick={async (e) => { e.stopPropagation(); await handleBrowseDialog(); }}
              style={toolbarButtonStyle}
              title="Browse file..."
            >
              📁
            </button>
          </>
        )}
      </div>

      {/* Diff mode selector */}
      {browseDiffToolbar}

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
                  // Open the file in view mode with diff active
                  setDiffFilePath(file);
                  const fullPath = (rootDir || currentDir).replace(/\\$/, "") + "\\" + file.replace(/\//g, "\\");
                  openFile(fullPath);
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
                onClick={() => handleEntryClick(entry)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "3px 12px",
                  cursor: "pointer",
                  color: entry.isDir ? "#89b4fa" : "#cdd6f4",
                  fontWeight: entry.isDir ? 500 : 400,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <span style={{ fontSize: 13, width: 20, textAlign: "center", flexShrink: 0 }}>
                  {fileIcon(entry.name, entry.isDir)}
                </span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {entry.name}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
      {fileSearchOverlay}
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

const backButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#89b4fa",
  cursor: "pointer",
  fontSize: 12,
  padding: "4px 8px",
  marginTop: 8,
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
  padding: "16px 20px",
  background: "#1e1e2e",
  color: "#cdd6f4",
  fontFamily: "'Segoe UI', system-ui, sans-serif",
  fontSize: 14,
  lineHeight: 1.7,
};

const markdownComponents = {
  code({ children, className }: { children?: React.ReactNode; className?: string }) {
    return (
      <code className={className} style={{
        background: "#313244", padding: "2px 6px", borderRadius: 3,
        fontSize: 13, fontFamily: "'Cascadia Code', 'Consolas', monospace",
      }}>
        {children}
      </code>
    );
  },
  pre({ children }: { children?: React.ReactNode }) {
    return (
      <pre style={{
        background: "#181825", border: "1px solid #313244",
        borderRadius: 6, padding: 12, overflow: "auto",
        fontSize: 13, fontFamily: "'Cascadia Code', 'Consolas', monospace",
      }}>
        {children}
      </pre>
    );
  },
  h1: ({ children }: { children?: React.ReactNode }) => <h1 style={{ color: "#89b4fa", borderBottom: "1px solid #313244", paddingBottom: 8 }}>{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 style={{ color: "#89b4fa", marginTop: 24 }}>{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 style={{ color: "#a6e3a1" }}>{children}</h3>,
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => <a href={href} style={{ color: "#89b4fa" }}>{children}</a>,
  table: ({ children }: { children?: React.ReactNode }) => <table style={{ borderCollapse: "collapse", width: "100%", margin: "12px 0" }}>{children}</table>,
  th: ({ children }: { children?: React.ReactNode }) => <th style={{ border: "1px solid #45475a", padding: "6px 10px", background: "#181825", textAlign: "left" }}>{children}</th>,
  td: ({ children }: { children?: React.ReactNode }) => <td style={{ border: "1px solid #313244", padding: "6px 10px" }}>{children}</td>,
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
