import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowTopRightOnSquareIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import {
  adoRepoDisplay,
  PIPELINE_MODES,
  PIPELINE_MODE_LABELS,
  isBranchScope,
  isPipelineMode,
  resultLabel,
  type BranchScope,
  type PipelineMode,
  type PipelineStatus,
  type RepoRef,
} from "../domain/pipeline-inbox";
import { resultColor } from "./pipeline-result";
import { AUTO_INVESTIGATE_LABELS, DEFAULT_DIGEST_TIME, isDigestTime, type AutoInvestigate } from "../domain/pipeline-digest";

interface Props {
  pipelines: PipelineStatus[];
  onAdd: (url: string) => Promise<unknown>;
  onSetMode: (id: string, mode: PipelineMode) => Promise<void>;
  /** Chooses whose runs notify: the default branch's, or every branch's. */
  onSetBranches: (id: string, branches: BranchScope) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  /** Sets a pipeline's repo: a repo id, "none", or "auto". */
  onSetRepo: (id: string, repo: string) => Promise<void>;
  /** Every Workstreams repo, for the repo menu. */
  repos: RepoRef[];
  /** The one time Daily-failures pipelines post their digest, HH:MM local (ADR 045). */
  digestTime?: string;
  onSetDigestTime?: (time: string) => Promise<void>;
  /** Whether a Daily-failures pipeline's digest also starts its investigation. */
  onSetAutoInvestigate?: (id: string, value: AutoInvestigate) => Promise<void>;
  onClose: () => void;
}

const names = (repos: RepoRef[]) => (repos.length <= 1 ? repos[0]?.name ?? "" : `${repos[0].name} +${repos.length - 1}`);

/** What Automatic would show: the matched repos, ADO's repo, or nothing known yet. */
function automaticLabel(pipeline: PipelineStatus): string {
  if (pipeline.auto_repos.length > 0) return names(pipeline.auto_repos);
  return pipeline.ado_repo ? `${adoRepoDisplay(pipeline.ado_repo)} (not in Workstreams)` : "not known yet";
}

/** A pipeline's repo, with a menu to set it by hand (Automatic, a repo, or No repo). */
function RepoChip({ pipeline, repos, disabled, onSet }: { pipeline: PipelineStatus; repos: RepoRef[]; disabled: boolean; onSet: (repo: string) => void }) {
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const manual = pipeline.repo_source === "manual";

  // The menu lives in a portal at a fixed position under the chip, so the
  // pipeline list's scroll area can't clip it; it flips above when there's no
  // room below, and stays inside the window.
  useLayoutEffect(() => {
    if (!open || !chip.current) { setAt(null); return; }
    const place = () => {
      const anchor = chip.current!.getBoundingClientRect();
      const size = menu.current?.getBoundingClientRect() ?? { width: 240, height: 0 };
      const margin = 8;
      const below = anchor.bottom + 4;
      const top = below + size.height > window.innerHeight - margin ? Math.max(margin, anchor.top - 4 - size.height) : below;
      const left = Math.max(margin, Math.min(anchor.right - size.width, window.innerWidth - size.width - margin));
      setAt({ top, left });
    };
    place();
    const raf = requestAnimationFrame(place);
    const close = (event: Event) => {
      if (event.type === "mousedown" && (menu.current?.contains(event.target as Node) || chip.current?.contains(event.target as Node))) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);
  const notInWorkstreams = !manual && pipeline.repos.length === 0 && pipeline.ado_repo;
  const label = pipeline.repo_label
    ? notInWorkstreams ? `${pipeline.repo_label} — not in Workstreams` : pipeline.repo_label
    : "No repo";
  const current = manual ? (pipeline.repos[0]?.id ?? "none") : "auto";
  const option = (value: string, text: string) => (
    <button
      key={value}
      role="menuitemradio"
      aria-checked={current === value}
      data-testid={`pipeline-repo-option-${pipeline.id}-${value}`}
      onClick={() => { setOpen(false); onSet(value); }}
      style={{ ...menuItemStyle, background: current === value ? "#313244" : "transparent" }}
    >
      {text}
    </button>
  );
  return (
    <div style={{ position: "relative", flex: "none" }}>
      <button
        ref={chip}
        data-testid={`pipeline-repo-${pipeline.id}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={manual ? "Repo set by you" : "Repo detected from Azure DevOps"}
        onClick={() => setOpen(!open)}
        style={{ ...chipStyle, color: pipeline.repo_label && !notInWorkstreams ? "#cdd6f4" : "#7f849c", fontStyle: notInWorkstreams || !pipeline.repo_label ? "italic" : "normal" }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{label}</span>
        <span style={{ fontSize: 10, fontStyle: "normal", color: manual ? "#f9e2af" : "#7f849c" }}>{manual ? "set by you" : "auto"}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && createPortal(
        <div
          ref={menu}
          role="menu"
          data-testid={`pipeline-repo-menu-${pipeline.id}`}
          onClick={(event) => event.stopPropagation()}
          style={{ ...menuStyle, top: at?.top ?? -9999, left: at?.left ?? -9999, visibility: at ? "visible" : "hidden" }}
        >
          <div style={{ color: "#6c7086", fontSize: 10, padding: "2px 6px" }}>Repo for this pipeline</div>
          {option("auto", `Automatic — ${automaticLabel(pipeline)}`)}
          {repos.map((repo) => option(repo.id, repo.name))}
          {option("none", "No repo")}
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * The watched pipelines (ADR 038): paste a link to a pipeline or one of its
 * runs to add it, pick what notifies, remove it. Chrome mirrors the Inbox and
 * the Repo manager.
 */
export function PipelinesModal({ pipelines, onAdd, onSetMode, onSetBranches, onRemove, onSetRepo, repos, digestTime = DEFAULT_DIGEST_TIME, onSetDigestTime, onSetAutoInvestigate, onClose }: Props) {
  const [url, setUrl] = useState("");
  const [time, setTime] = useState(digestTime);
  // A new stored time (from an agent, or the save) replaces the edit.
  const [stored, setStored] = useState(digestTime);
  if (stored !== digestTime) {
    setStored(digestTime);
    setTime(digestTime);
  }
  const saveTime = () => {
    if (!onSetDigestTime || time === digestTime) return;
    if (!isDigestTime(time)) { setTime(digestTime); return; }
    void act(() => onSetDigestTime(time));
  };
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const message = (failure: unknown) => String(failure instanceof Error ? failure.message : failure);

  const add = async () => {
    if (adding || !url.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      await onAdd(url.trim());
      setUrl("");
    } catch (failure) {
      setAddError(message(failure));
    } finally {
      setAdding(false);
    }
  };

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try { await action(); }
    catch (failure) { setActionError(message(failure)); }
    finally { setBusy(false); }
  };

  return (
    <div data-testid="pipelines-backdrop" onClick={onClose} style={backdropStyle}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Pipelines"
        data-testid="pipelines-panel"
        onClick={(event) => event.stopPropagation()}
        style={panelStyle}
      >
        <div style={headerStyle}>
          <div>
            <div style={{ color: "#cdd6f4", fontWeight: 600, fontSize: 13 }}>Pipelines</div>
            <div style={{ color: "#6c7086", fontSize: 11 }}>
              {pipelines.length} watched pipeline{pipelines.length === 1 ? "" : "s"}
            </div>
          </div>
          <span style={{ flex: 1 }} />
          {onSetDigestTime && (
            <label
              title="When pipelines in Daily failures mode post their digest: one Inbox entry per failing pipeline, covering the runs since the previous one"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#a6adc8", fontSize: 11, marginRight: 8 }}
            >
              Daily digest at
              <input
                type="time"
                data-testid="pipeline-digest-time"
                aria-label="Daily digest time"
                value={time}
                disabled={busy}
                onChange={(event) => setTime(event.target.value)}
                onBlur={saveTime}
                onKeyDown={(event) => { if (event.key === "Enter") saveTime(); }}
                style={{ ...inputStyle, flex: "none", width: "auto" }}
              />
            </label>
          )}
          <button aria-label="Close pipelines" data-testid="pipelines-close" onClick={onClose} title="Close" style={iconButtonStyle}>
            <XMarkIcon style={{ width: 16, height: 16 }} />
          </button>
        </div>

        <div style={noteStyle}>
          Paste a link to an Azure DevOps pipeline or to one of its runs. Runs that finish from now on
          notify in the Inbox according to the mode; earlier runs never do. Daily failures posts one digest
          entry per failing pipeline a day instead of one per failed run. Uses your Azure CLI account
          (<code>az login</code>) and checks every two minutes while Workstreams is open.
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <input
              data-testid="pipeline-url-input"
              aria-label="Pipeline or run link"
              placeholder="https://dev.azure.com/<org>/<project>/_build/results?buildId=…"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void add(); }}
              style={inputStyle}
            />
            <button data-testid="pipeline-add" disabled={adding || !url.trim()} onClick={() => void add()} style={buttonStyle}>
              {adding ? "Adding…" : "Add"}
            </button>
          </div>
          {addError && (
            <p role="alert" data-testid="pipeline-add-error" style={{ color: "#f38ba8", margin: "6px 0 0" }}>{addError}</p>
          )}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {actionError && <p role="alert" style={{ ...emptyStyle, color: "#f38ba8", textAlign: "left" }}>{actionError}</p>}
          {pipelines.length === 0 && (
            <p data-testid="pipelines-empty" style={emptyStyle}>No pipelines watched yet.</p>
          )}
          {pipelines.map((pipeline) => (
            <div
              key={pipeline.id}
              data-testid={`pipeline-row-${pipeline.id}`}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderTop: "1px solid #313244" }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <button
                  data-testid={`pipeline-open-${pipeline.id}`}
                  onClick={() => void act(() => openUrl(pipeline.url))}
                  title="Open the pipeline in Azure DevOps"
                  style={linkStyle}
                >
                  {pipeline.name}
                  <ArrowTopRightOnSquareIcon aria-hidden="true" width={12} height={12} style={{ display: "inline", marginLeft: 6 }} />
                </button>
                <div style={{ color: "#6c7086", fontSize: 11, marginTop: 2 }}>
                  {pipeline.project} ·{" "}
                  {pipeline.last_result ? (
                    <button
                      data-testid={`pipeline-last-${pipeline.id}`}
                      disabled={!pipeline.last_run_url}
                      onClick={() => pipeline.last_run_url && void act(() => openUrl(pipeline.last_run_url!))}
                      title="Open the last run"
                      style={{ ...linkStyle, fontSize: 11, color: resultColor(pipeline.last_result) }}
                    >
                      {resultLabel(pipeline.last_result)} · #{pipeline.last_run_number}
                    </button>
                  ) : (
                    <span data-testid={`pipeline-last-${pipeline.id}`}>No finished runs yet</span>
                  )}
                </div>
                {pipeline.error && (
                  <div role="status" data-testid={`pipeline-error-${pipeline.id}`} style={{ color: "#f38ba8", fontSize: 11, marginTop: 2 }}>
                    {pipeline.error}
                  </div>
                )}
              </div>
              <RepoChip pipeline={pipeline} repos={repos} disabled={busy} onSet={(repo) => void act(() => onSetRepo(pipeline.id, repo))} />
              <select
                data-testid={`pipeline-mode-${pipeline.id}`}
                aria-label={`Notifications for ${pipeline.name}`}
                value={pipeline.mode}
                disabled={busy}
                onChange={(event) => {
                  const next = event.target.value;
                  if (isPipelineMode(next)) void act(() => onSetMode(pipeline.id, next));
                }}
                style={{ ...inputStyle, flex: "none", width: "auto" }}
              >
                {PIPELINE_MODES.map((mode) => (
                  <option key={mode} value={mode}>{PIPELINE_MODE_LABELS[mode]}</option>
                ))}
              </select>
              <select
                data-testid={`pipeline-branches-${pipeline.id}`}
                aria-label={`Branches that notify for ${pipeline.name}`}
                title="Whose runs notify: only the repo's default branch, or every branch (feature and experiment branches included)"
                value={pipeline.branches}
                disabled={busy}
                onChange={(event) => {
                  const next = event.target.value;
                  if (isBranchScope(next)) void act(() => onSetBranches(pipeline.id, next));
                }}
                style={{ ...inputStyle, flex: "none", width: "auto" }}
              >
                <option value="default">{pipeline.default_branch ? `Default branch (${pipeline.default_branch})` : "Default branch"}</option>
                <option value="all">All branches</option>
              </select>
              {onSetAutoInvestigate && (
                <select
                  data-testid={`pipeline-auto-${pipeline.id}`}
                  aria-label={`Auto-investigate for ${pipeline.name}`}
                  title={pipeline.mode === "daily_failures"
                    ? "Auto-investigate: start a Copilot investigation of the failed runs when the daily digest is posted (at most 3 new ones a day)"
                    : "Auto-investigate needs Daily failures mode"}
                  value={pipeline.mode === "daily_failures" ? pipeline.auto_investigate ?? "off" : "off"}
                  disabled={busy || pipeline.mode !== "daily_failures"}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (next === "off" || next === "digest") void act(() => onSetAutoInvestigate(pipeline.id, next));
                  }}
                  style={{ ...inputStyle, flex: "none", width: "auto" }}
                >
                  {(["off", "digest"] as const).map((value) => (
                    <option key={value} value={value}>Auto-investigate: {AUTO_INVESTIGATE_LABELS[value]}</option>
                  ))}
                </select>
              )}
              <button
                data-testid={`pipeline-remove-${pipeline.id}`}
                aria-label={`Stop watching ${pipeline.name}`}
                title="Stop watching (removes its notifications)"
                disabled={busy}
                onClick={() => void act(() => onRemove(pipeline.id))}
                style={{ ...buttonStyle, display: "inline-flex", alignItems: "center" }}
              >
                <TrashIcon aria-hidden="true" width={12} height={12} />
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const chipStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 280, background: "#11111b", border: "1px solid #45475a",
  borderRadius: 10, padding: "2px 8px", fontSize: 11, cursor: "pointer", fontFamily: "inherit",
};

const menuStyle: React.CSSProperties = {
  position: "fixed", zIndex: 2100, minWidth: 240, maxHeight: 260, overflowY: "auto",
  background: "#181825", border: "1px solid #45475a", borderRadius: 6, padding: 4, display: "grid", gap: 1,
  boxShadow: "0 6px 16px rgba(0,0,0,0.45)",
};

const menuItemStyle: React.CSSProperties = {
  border: "none", borderRadius: 4, padding: "4px 6px", textAlign: "left", color: "#cdd6f4", fontSize: 11,
  cursor: "pointer", fontFamily: "inherit",
};

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 2001,
};

const panelStyle: React.CSSProperties = {
  width: "min(720px, 92vw)",
  maxHeight: "82vh",
  display: "flex",
  flexDirection: "column",
  background: "#1e1e2e",
  color: "#cdd6f4",
  border: "1px solid #313244",
  borderRadius: 8,
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 12px",
  borderBottom: "1px solid #313244",
};

const noteStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid #313244",
  color: "#a6adc8",
  fontSize: 11,
  lineHeight: 1.5,
};

const emptyStyle: React.CSSProperties = {
  padding: 16,
  margin: 0,
  color: "#a6adc8",
  fontSize: 12,
  textAlign: "center",
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "4px 8px",
  fontSize: 11,
  color: "#cdd6f4",
  background: "#181825",
  border: "1px solid #45475a",
  borderRadius: 4,
  fontFamily: "inherit",
};

const buttonStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 11,
  color: "#cdd6f4",
  background: "#181825",
  border: "1px solid #45475a",
  borderRadius: 4,
  cursor: "pointer",
  whiteSpace: "nowrap",
  fontFamily: "inherit",
};

const iconButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#6c7086",
  cursor: "pointer",
  padding: 2,
  display: "flex",
};

const linkStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  textAlign: "left",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
  color: "#89b4fa",
  overflowWrap: "anywhere",
};
