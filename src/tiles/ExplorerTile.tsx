import { useState, useEffect, useCallback } from "react";
import Editor from "@monaco-editor/react";
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
    // Reload the directory listing if we haven't loaded yet
    if (entries.length === 0) {
      loadDir(currentDir);
    }
  };

  const handleBrowseDialog = async () => {
    const file = await open({ title: "Open file", multiple: false, directory: false });
    if (file) openFile(file as string);
  };

  // Filter entries by search
  const filteredEntries = searchFilter
    ? entries.filter((e) => e.name.toLowerCase().includes(searchFilter.toLowerCase()))
    : entries;

  // ─── View mode ───
  if (mode === "view") {
    if (fileLoading) {
      return (
        <div style={{ ...containerStyle, alignItems: "center", justifyContent: "center" }}>
          <div style={{ color: "#585b70" }}>Loading...</div>
        </div>
      );
    }

    if (content === null && !fileLoading) {
      // No content loaded yet — shouldn't normally happen, but handle gracefully
      return (
        <div style={{ ...containerStyle, alignItems: "center", justifyContent: "center" }}>
          <div style={{ color: "#585b70" }}>No file loaded</div>
          <button onClick={goBackToBrowse} style={backButtonStyle}>← Back</button>
          {fileError && <div style={errorTextStyle}>{fileError}</div>}
        </div>
      );
    }

    const viewToolbar = (
      <div style={toolbarStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", flex: 1 }}>
          <button onClick={goBackToBrowse} style={toolbarButtonStyle} title="Back to browser">
            ← Back
          </button>
          <span style={pathTextStyle}>
            {isMarkdown(filePath) ? "📝" : "📄"} {filePath}
          </span>
        </div>
      </div>
    );

    // Markdown rendering
    if (isMarkdown(filePath)) {
      return (
        <div style={containerStyle}>
          {viewToolbar}
          <div style={markdownContainerStyle}>
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {content}
            </Markdown>
          </div>
        </div>
      );
    }

    // Code rendering (Monaco)
    return (
      <div style={containerStyle}>
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
      </div>
    );
  }

  // ─── Browse mode ───
  return (
    <div style={containerStyle}>
      {/* Path bar */}
      <div style={toolbarStyle}>
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
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "#313244";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
            }}
          >
            <span style={{ fontSize: 13, width: 20, textAlign: "center", flexShrink: 0 }}>
              {fileIcon(entry.name, entry.isDir)}
            </span>
            <span style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {entry.name}
            </span>
          </div>
        ))}
      </div>
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
