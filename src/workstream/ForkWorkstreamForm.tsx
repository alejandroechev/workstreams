import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  workstreamName: string;
  workstreamDir: string;
  currentBranch: string | null;
  sessionId: string | null;
  onSubmit: (opts: {
    name: string;
    branchName: string;
    baseBranch: string;
    archiveOld: boolean;
  }) => void;
  onCancel: () => void;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export default function ForkWorkstreamForm({
  workstreamName,
  workstreamDir,
  currentBranch,
  sessionId,
  onSubmit,
  onCancel,
}: Props) {
  const [name, setName] = useState(`${workstreamName} (follow-up)`);
  const [branchName, setBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState(currentBranch || "master");
  const [archiveOld, setArchiveOld] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);

  // Auto-generate branch name from workstream name
  useEffect(() => {
    setBranchName(`alejandroe/${slugify(name)}`);
  }, [name]);

  // Load available branches
  useEffect(() => {
    invoke<string[]>("git_list_branches", { directory: workstreamDir })
      .then(setBranches)
      .catch(() => setBranches([]));
  }, [workstreamDir]);

  const handleSubmit = () => {
    if (!name.trim() || !branchName.trim()) return;
    onSubmit({
      name: name.trim(),
      branchName: branchName.trim(),
      baseBranch,
      archiveOld,
    });
  };

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
          width: 480,
          padding: "20px 24px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ color: "#cdd6f4", fontWeight: 600, fontSize: 14 }}>
            Fork Workstream
          </div>
          <button
            onClick={onCancel}
            style={{ background: "none", border: "none", color: "#585b70", cursor: "pointer", fontSize: 16, padding: "2px 6px", lineHeight: 1 }}
            title="Close"
          >✕</button>
        </div>

        {/* Info about what's being forked */}
        <div style={{
          fontSize: 11,
          color: "#6c7086",
          marginBottom: 14,
          padding: "6px 8px",
          background: "#181825",
          borderRadius: 4,
        }}>
          <div>Forking from: <span style={{ color: "#cdd6f4" }}>{workstreamName}</span></div>
          {currentBranch && <div>Current branch: <span style={{ color: "#89b4fa" }}>{currentBranch}</span></div>}
          {sessionId && <div>Session context: <span style={{ color: "#a6e3a1" }}>will be carried over</span></div>}
        </div>

        {/* New workstream name */}
        <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 4 }}>New Workstream Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") onCancel();
            if (e.key === "Enter") handleSubmit();
          }}
          autoFocus
          style={{
            width: "100%",
            background: "#313244",
            border: "1px solid #45475a",
            borderRadius: 4,
            color: "#cdd6f4",
            padding: "8px 10px",
            fontSize: 13,
            fontFamily: "monospace",
            outline: "none",
            boxSizing: "border-box",
            marginBottom: 14,
          }}
        />

        {/* Branch name */}
        <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 4 }}>New Branch Name</label>
        <input
          type="text"
          value={branchName}
          onChange={(e) => setBranchName(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="alejandroe/feature-name"
          style={{
            width: "100%",
            background: "#313244",
            border: "1px solid #45475a",
            borderRadius: 4,
            color: "#cdd6f4",
            padding: "8px 10px",
            fontSize: 12,
            fontFamily: "monospace",
            outline: "none",
            boxSizing: "border-box",
            marginBottom: 14,
          }}
        />

        {/* Base branch */}
        <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 4 }}>Branch Off From</label>
        <select
          value={baseBranch}
          onChange={(e) => setBaseBranch(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          style={{
            width: "100%",
            background: "#313244",
            border: "1px solid #45475a",
            borderRadius: 4,
            color: "#cdd6f4",
            padding: "8px 10px",
            fontSize: 12,
            outline: "none",
            boxSizing: "border-box",
            marginBottom: 14,
            cursor: "pointer",
          }}
        >
          {currentBranch && <option value={currentBranch}>{currentBranch} (current)</option>}
          {branches.filter((b) => b !== currentBranch).map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>

        {/* Archive old workstream */}
        <label style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderRadius: 4,
          cursor: "pointer",
          background: archiveOld ? "#313244" : "transparent",
          border: archiveOld ? "1px solid #45475a" : "1px solid transparent",
          marginBottom: 14,
        }}>
          <input
            type="checkbox"
            checked={archiveOld}
            onChange={(e) => setArchiveOld(e.target.checked)}
            style={{ accentColor: "#89b4fa" }}
          />
          <div>
            <div style={{ fontSize: 12, color: "#cdd6f4" }}>Archive old workstream</div>
            <div style={{ fontSize: 10, color: "#6c7086" }}>Stop processes and mark as archived</div>
          </div>
        </label>

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            style={{
              padding: "8px 16px",
              background: "#313244",
              color: "#a6adc8",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || !branchName.trim()}
            style={{
              padding: "8px 20px",
              background: !name.trim() || !branchName.trim() ? "#45475a" : "#89b4fa",
              color: "#1e1e2e",
              border: "none",
              borderRadius: 4,
              cursor: !name.trim() || !branchName.trim() ? "default" : "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Fork & Continue
          </button>
        </div>
      </div>
    </div>
  );
}
