import { useState, useCallback } from "react";
import Editor from "@monaco-editor/react";
import { useBackend } from "../backend/context";
import { detectLanguage } from "../domain/tile-config";

interface Props {
  tileId: string;
  isFocused: boolean;
}

export default function CodeViewerTile({ tileId, isFocused }: Props) {
  const backend = useBackend();
  const [filePath, setFilePath] = useState("");
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputPath, setInputPath] = useState("");

  const openFile = useCallback(async (path: string) => {
    if (!path.trim()) return;
    setError(null);
    try {
      const data = await backend.readFile(path.trim());
      setContent(data);
      setFilePath(path.trim());
    } catch (e) {
      setError(String(e));
      setContent(null);
    }
  }, [backend]);

  if (content === null) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#1e1e2e",
          color: "#6c7086",
          fontFamily: "monospace",
          gap: 12,
          padding: 20,
        }}
      >
        <div style={{ fontSize: 24 }}>📄</div>
        <div>Enter a file path to view</div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openFile(inputPath);
          }}
          style={{ display: "flex", gap: 6, width: "100%", maxWidth: 400 }}
        >
          <input
            type="text"
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="C:\path\to\file.ts"
            style={{
              flex: 1,
              background: "#313244",
              border: "1px solid #45475a",
              borderRadius: 4,
              color: "#cdd6f4",
              padding: "6px 10px",
              fontSize: 12,
              fontFamily: "monospace",
              outline: "none",
            }}
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openFile(inputPath);
            }}
            style={{
              background: "#89b4fa",
              color: "#1e1e2e",
              border: "none",
              borderRadius: 4,
              padding: "6px 14px",
              fontSize: 12,
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Open
          </button>
        </form>
        {error && (
          <div style={{ color: "#f38ba8", fontSize: 11, marginTop: 4 }}>
            {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "2px 8px",
          background: "#181825",
          borderBottom: "1px solid #313244",
          fontSize: 11,
          color: "#585b70",
          flexShrink: 0,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {filePath}
        </span>
        <button
          onClick={() => { setContent(null); setFilePath(""); setInputPath(""); }}
          style={{
            background: "none",
            border: "none",
            color: "#585b70",
            cursor: "pointer",
            fontSize: 11,
            padding: "0 4px",
          }}
        >
          ✕ close
        </button>
      </div>
      <div style={{ flex: 1 }}>
        <Editor
          height="100%"
          language={detectLanguage(filePath)}
          value={content}
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
