import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface CopilotSession {
  session_id: string;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  summary: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface Props {
  onSelect: (session: CopilotSession) => void;
  onCreateNew: () => void;
  onCancel: () => void;
  /**
   * Active workstream's directory. Sessions whose cwd matches (case-
   * insensitively, separator-normalized) sort to the top with a
   * "this workstream" badge.
   */
  activeWorkstreamDir?: string;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function normalizePath(p: string | null | undefined): string {
  return (p ?? "").replace(/\//g, "\\").toLowerCase();
}

export default function SessionPicker({ onSelect, onCreateNew, onCancel, activeWorkstreamDir }: Props) {
  const [sessions, setSessions] = useState<CopilotSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    invoke<CopilotSession[]>("get_copilot_sessions", { limit: 30 })
      .then((s) => {
        setSessions(s);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const targetDir = normalizePath(activeWorkstreamDir);
  const matchesWorkstream = (s: CopilotSession): boolean => {
    if (!targetDir) return false;
    return normalizePath(s.cwd) === targetDir;
  };

  const filtered = sessions
    .filter((s) => {
      if (!filter) return true;
      const q = filter.toLowerCase();
      return (
        (s.summary?.toLowerCase().includes(q)) ||
        (s.cwd?.toLowerCase().includes(q)) ||
        (s.repository?.toLowerCase().includes(q)) ||
        (s.session_id.toLowerCase().startsWith(q))
      );
    })
    .sort((a, b) => {
      // Matching-workstream rows first; within each group keep updated_at desc.
      const am = matchesWorkstream(a) ? 1 : 0;
      const bm = matchesWorkstream(b) ? 1 : 0;
      if (am !== bm) return bm - am;
      const at = a.updated_at ? Date.parse(a.updated_at) : 0;
      const bt = b.updated_at ? Date.parse(b.updated_at) : 0;
      return bt - at;
    });

  return (
    <div
      style={{
        position: "fixed",
        top: 0, left: 0, right: 0, bottom: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1e1e2e",
          border: "1px solid #313244",
          borderRadius: 8,
          width: 600,
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
      >
        {/* Header */}
        <div style={{
          padding: "14px 16px 10px",
          borderBottom: "1px solid #313244",
        }}>
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 10,
          }}>
            <span style={{ color: "#cdd6f4", fontWeight: 600, fontSize: 14 }}>
              Open Copilot Session
            </span>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button
              onClick={onCreateNew}
              style={{
                background: "#a6e3a1",
                color: "#1e1e2e",
                border: "none",
                borderRadius: 4,
                padding: "5px 14px",
                fontSize: 12,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              + New Session
            </button>
            <button
              onClick={onCancel}
              style={{ background: "none", border: "none", color: "#585b70", cursor: "pointer", fontSize: 16, padding: "2px 6px", lineHeight: 1 }}
              title="Close"
            >✕</button>
            </div>
          </div>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") onCancel();
            }}
            placeholder="Search sessions..."
            autoFocus
            style={{
              width: "100%",
              background: "#313244",
              border: "1px solid #45475a",
              borderRadius: 4,
              color: "#cdd6f4",
              padding: "8px 12px",
              fontSize: 13,
              fontFamily: "monospace",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Session list */}
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
          {loading && (
            <div style={{ padding: 16, color: "#585b70", textAlign: "center" }}>
              Loading sessions...
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div style={{ padding: 16, color: "#585b70", textAlign: "center" }}>
              No sessions found
            </div>
          )}
          {filtered.map((s) => {
            const matching = matchesWorkstream(s);
            return (
            <div
              key={s.session_id}
              onClick={() => onSelect(s)}
              style={{
                padding: "10px 16px",
                cursor: "pointer",
                borderBottom: "1px solid #181825",
                background: matching ? "rgba(166,227,161,0.06)" : "transparent",
                borderLeft: matching ? "3px solid #a6e3a1" : "3px solid transparent",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = "#313244";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = matching
                  ? "rgba(166,227,161,0.06)"
                  : "transparent";
              }}
            >
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}>
                <span style={{ color: "#cdd6f4", fontWeight: 500, fontSize: 13 }}>
                  {s.summary || s.session_id.slice(0, 8)}
                  {matching && (
                    <span style={{ marginLeft: 8, padding: "1px 6px", background: "#a6e3a1", color: "#1e1e2e", borderRadius: 3, fontSize: 10, fontWeight: 600 }}>
                      this workstream
                    </span>
                  )}
                </span>
                <span style={{ color: "#585b70", fontSize: 11 }}>
                  {timeAgo(s.updated_at)}
                </span>
              </div>
              <div style={{
                display: "flex",
                gap: 12,
                marginTop: 3,
                fontSize: 11,
                color: "#6c7086",
              }}>
                {s.repository && <span>📦 {s.repository}</span>}
                {s.branch && <span>🌿 {s.branch}</span>}
                {s.cwd && (
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    📁 {s.cwd}
                  </span>
                )}
                <span style={{ color: "#45475a" }}>{s.session_id.slice(0, 8)}</span>
              </div>
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
