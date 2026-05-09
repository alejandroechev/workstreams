import { useState, useCallback, useMemo } from "react";
import Editor from "@monaco-editor/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useBackend } from "../backend/context";
import { detectLanguage } from "../domain/tile-config";
import {
  PlusIcon,
  XMarkIcon,
  ArrowLeftIcon,
  DocumentIcon,
  DocumentTextIcon,
  CodeBracketIcon,
  FolderOpenIcon,
} from "@heroicons/react/24/outline";

interface Props {
  tileId: string;
  isFocused: boolean;
  configJson: string;
  onConfigChange: (configJson: string) => void;
}

type Mode = "list" | "view";

const MARKDOWN_EXTS = new Set(["md", "mdx", "markdown"]);

function isMarkdown(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return MARKDOWN_EXTS.has(ext);
}

function FileItemIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "ts": case "tsx": case "js": case "jsx": case "rs": case "py":
      return <CodeBracketIcon style={{ width: 14, height: 14, color: "#a6adc8" }} />;
    case "md": case "mdx": case "markdown":
      return <DocumentTextIcon style={{ width: 14, height: 14, color: "#a6adc8" }} />;
    default:
      return <DocumentIcon style={{ width: 14, height: 14, color: "#6c7086" }} />;
  }
}

export default function WorkbenchTile({ tileId: _tileId, isFocused: _isFocused, configJson, onConfigChange }: Props) {
  const backend = useBackend();
  const [mode, setMode] = useState<Mode>("list");
  const [viewingPath, setViewingPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [loadingFile, setLoadingFile] = useState(false);

  const files: string[] = useMemo(() => {
    try {
      const cfg = JSON.parse(configJson || "{}");
      return Array.isArray(cfg.files) ? cfg.files : [];
    } catch {
      return [];
    }
  }, [configJson]);

  const updateFiles = useCallback((newFiles: string[]) => {
    const cfg = JSON.stringify({ files: newFiles });
    onConfigChange(cfg);
  }, [onConfigChange]);

  const handleAddFile = useCallback(async () => {
    try {
      // Dynamic import to avoid issues in test/non-Tauri environments
      const { open } = await import("@tauri-apps/plugin-dialog");
      const result = await open({ multiple: true });
      if (!result) return;
      const paths: string[] = Array.isArray(result) ? result : [result];
      const newFiles = [...files];
      for (const filePath of paths) {
        if (!newFiles.includes(filePath)) {
          newFiles.push(filePath);
        }
      }
      updateFiles(newFiles);
    } catch {
      // Dialog not available (test env) — silently ignore
    }
  }, [files, updateFiles]);

  const handleRemoveFile = useCallback((path: string) => {
    updateFiles(files.filter((f) => f !== path));
  }, [files, updateFiles]);

  const handleViewFile = useCallback(async (path: string) => {
    setLoadingFile(true);
    setViewingPath(path);
    setMode("view");
    try {
      const content = await backend.readFile(path);
      setFileContent(content);
    } catch (e) {
      setFileContent(`Error reading file: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoadingFile(false);
    }
  }, [backend]);

  const handleBack = useCallback(() => {
    setMode("list");
    setViewingPath(null);
    setFileContent("");
  }, []);

  const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

  if (mode === "view" && viewingPath) {
    const md = isMarkdown(viewingPath);
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "#1e1e2e" }}>
        {/* View toolbar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 8px",
            background: "#181825",
            borderBottom: "1px solid #313244",
            flexShrink: 0,
            fontSize: 11,
            fontFamily: "monospace",
            color: "#a6adc8",
          }}
        >
          <button
            onClick={handleBack}
            style={{
              background: "none",
              border: "none",
              color: "#89b4fa",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 4px",
              fontSize: 11,
              fontFamily: "monospace",
            }}
          >
            <ArrowLeftIcon style={{ width: 14, height: 14 }} />
            Back
          </button>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#585b70" }}>
            {viewingPath}
          </span>
        </div>

        {/* File content */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          {loadingFile ? (
            <div style={{ padding: 12, color: "#585b70", textAlign: "center", fontFamily: "monospace", fontSize: 12 }}>
              Loading…
            </div>
          ) : md ? (
            <div style={{ padding: "8px 16px", overflow: "auto", height: "100%", color: "#cdd6f4", fontFamily: "sans-serif", fontSize: 13 }}>
              <Markdown remarkPlugins={[remarkGfm]}>{fileContent}</Markdown>
            </div>
          ) : (
            <Editor
              height="100%"
              language={detectLanguage(viewingPath)}
              value={fileContent}
              theme="vs-dark"
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                wordWrap: "on",
              }}
            />
          )}
        </div>
      </div>
    );
  }

  // List mode
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
      {/* List toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 8px",
          background: "#181825",
          borderBottom: "1px solid #313244",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "#a6adc8", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
          <FolderOpenIcon style={{ width: 14, height: 14 }} />
          Workbench ({files.length})
        </span>
        <button
          onClick={handleAddFile}
          style={{
            background: "#313244",
            border: "none",
            borderRadius: 3,
            color: "#a6e3a1",
            cursor: "pointer",
            fontSize: 11,
            padding: "2px 8px",
            fontFamily: "monospace",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
          title="Add file"
        >
          <PlusIcon style={{ width: 12, height: 12 }} />
          Add File
        </button>
      </div>

      {/* File list */}
      <div style={{ flex: 1, overflow: "auto", padding: "4px 0" }}>
        {files.length === 0 && (
          <div style={{ padding: 12, color: "#585b70", textAlign: "center" }}>
            No files added yet
          </div>
        )}
        {files.map((path) => (
          <div
            key={path}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 8px",
              cursor: "pointer",
              borderBottom: "1px solid #181825",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "#313244"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
          >
            <div
              style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}
              onClick={() => handleViewFile(path)}
            >
              <FileItemIcon name={fileName(path)} />
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "#cdd6f4",
                }}
                title={path}
              >
                {fileName(path)}
              </span>
              <span style={{ color: "#45475a", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1 }}>
                {path}
              </span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleRemoveFile(path);
              }}
              style={{
                background: "none",
                border: "none",
                color: "#585b70",
                cursor: "pointer",
                padding: "2px",
                display: "flex",
                alignItems: "center",
                flexShrink: 0,
              }}
              title="Remove from workbench"
            >
              <XMarkIcon style={{ width: 14, height: 14 }} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
