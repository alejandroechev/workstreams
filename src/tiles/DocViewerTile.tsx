import { useState, useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { open } from "@tauri-apps/plugin-dialog";
import { useBackend } from "../backend/context";

interface Props {
  tileId: string;
  isFocused: boolean;
}

export default function DocViewerTile({ tileId, isFocused }: Props) {
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
        <div style={{ fontSize: 24 }}>📝</div>
        <div>Open a markdown file</div>
        <button
          type="button"
          onClick={async (e) => {
            e.stopPropagation();
            const file = await open({
              title: "Open markdown file",
              multiple: false,
              directory: false,
              filters: [{ name: "Markdown", extensions: ["md", "mdx", "txt"] }],
            });
            if (file) openFile(file as string);
          }}
          style={{
            background: "#a6e3a1",
            color: "#1e1e2e",
            border: "none",
            borderRadius: 4,
            padding: "8px 20px",
            fontSize: 13,
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          📁 Browse...
        </button>
        <div style={{ fontSize: 11, color: "#45475a", marginTop: 4 }}>or type a path below</div>
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
            placeholder="C:\path\to\README.md"
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
              background: "#313244",
              color: "#cdd6f4",
              border: "1px solid #45475a",
              borderRadius: 4,
              padding: "6px 14px",
              fontSize: 12,
              cursor: "pointer",
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
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 20px",
          background: "#1e1e2e",
          color: "#cdd6f4",
          fontFamily: "'Segoe UI', system-ui, sans-serif",
          fontSize: 14,
          lineHeight: 1.7,
        }}
        className="markdown-body"
      >
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ children, className, ...props }) {
              return (
                <code
                  className={className}
                  style={{
                    background: "#313244",
                    padding: "2px 6px",
                    borderRadius: 3,
                    fontSize: 13,
                    fontFamily: "'Cascadia Code', 'Consolas', monospace",
                  }}
                  {...props}
                >
                  {children}
                </code>
              );
            },
            pre({ children }) {
              return (
                <pre
                  style={{
                    background: "#181825",
                    border: "1px solid #313244",
                    borderRadius: 6,
                    padding: 12,
                    overflow: "auto",
                    fontSize: 13,
                    fontFamily: "'Cascadia Code', 'Consolas', monospace",
                  }}
                >
                  {children}
                </pre>
              );
            },
            h1: ({ children }) => <h1 style={{ color: "#89b4fa", borderBottom: "1px solid #313244", paddingBottom: 8 }}>{children}</h1>,
            h2: ({ children }) => <h2 style={{ color: "#89b4fa", marginTop: 24 }}>{children}</h2>,
            h3: ({ children }) => <h3 style={{ color: "#a6e3a1" }}>{children}</h3>,
            a: ({ children, href }) => <a href={href} style={{ color: "#89b4fa" }}>{children}</a>,
            table: ({ children }) => (
              <table style={{ borderCollapse: "collapse", width: "100%", margin: "12px 0" }}>{children}</table>
            ),
            th: ({ children }) => (
              <th style={{ border: "1px solid #45475a", padding: "6px 10px", background: "#181825", textAlign: "left" }}>{children}</th>
            ),
            td: ({ children }) => (
              <td style={{ border: "1px solid #313244", padding: "6px 10px" }}>{children}</td>
            ),
          }}
        >
          {content}
        </Markdown>
      </div>
    </div>
  );
}
