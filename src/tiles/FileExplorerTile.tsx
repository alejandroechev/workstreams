import { useState, useEffect, useCallback } from "react";
import { useBackend } from "../backend/context";

interface Props {
  tileId: string;
  isFocused: boolean;
  rootDir?: string;
  onOpenFile?: (path: string) => void;
}

interface DirEntry {
  name: string;
  isDir: boolean;
  fullPath: string;
}

function parseEntries(raw: string[], currentDir: string): DirEntry[] {
  return raw.map((entry) => {
    const isDir = entry.startsWith("📁 ");
    const name = entry.replace(/^📁 /, "").replace(/^ {3}/, "");
    const sep = currentDir.endsWith("\\") ? "" : "\\";
    return { name, isDir, fullPath: `${currentDir}${sep}${name}` };
  });
}

export default function FileExplorerTile({ tileId, isFocused, rootDir, onOpenFile }: Props) {
  const backend = useBackend();
  const [currentDir, setCurrentDir] = useState(rootDir || "C:\\");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadDir = useCallback(async (dir: string) => {
    setLoading(true);
    setError(null);
    try {
      const raw = await backend.listDirectory(dir);
      setEntries(parseEntries(raw, dir));
      setCurrentDir(dir);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    loadDir(currentDir);
  }, []);

  const navigateUp = () => {
    const parent = currentDir.replace(/\\[^\\]+\\?$/, "");
    if (parent && parent !== currentDir) {
      loadDir(parent.endsWith("\\") ? parent : parent + "\\");
    }
  };

  const handleClick = (entry: DirEntry) => {
    if (entry.isDir) {
      loadDir(entry.fullPath);
    } else if (onOpenFile) {
      onOpenFile(entry.fullPath);
    }
  };

  const fileIcon = (name: string, isDir: boolean) => {
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
  };

  return (
    <div style={{
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      background: "#1e1e2e",
      color: "#cdd6f4",
      fontFamily: "monospace",
      fontSize: 12,
    }}>
      {/* Path bar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 8px",
        background: "#181825",
        borderBottom: "1px solid #313244",
        flexShrink: 0,
      }}>
        <button
          onClick={navigateUp}
          style={{
            background: "none",
            border: "none",
            color: "#89b4fa",
            cursor: "pointer",
            fontSize: 14,
            padding: "0 4px",
          }}
          title="Go up"
        >
          ⬆
        </button>
        <span style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "#585b70",
          fontSize: 11,
          flex: 1,
        }}>
          {currentDir}
        </span>
        <button
          onClick={() => loadDir(currentDir)}
          style={{
            background: "none",
            border: "none",
            color: "#585b70",
            cursor: "pointer",
            fontSize: 12,
            padding: "0 4px",
          }}
          title="Refresh"
        >
          ↻
        </button>
      </div>

      {/* File list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
        {loading && (
          <div style={{ padding: "8px 12px", color: "#585b70" }}>Loading...</div>
        )}
        {error && (
          <div style={{ padding: "8px 12px", color: "#f38ba8", fontSize: 11 }}>{error}</div>
        )}
        {!loading && entries.length === 0 && !error && (
          <div style={{ padding: "8px 12px", color: "#585b70" }}>Empty directory</div>
        )}
        {entries.map((entry) => (
          <div
            key={entry.name}
            onClick={() => handleClick(entry)}
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
