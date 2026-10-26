import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowTopRightOnSquareIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import {
  PIPELINE_MODES,
  PIPELINE_MODE_LABELS,
  isPipelineMode,
  resultLabel,
  type PipelineMode,
  type PipelineStatus,
} from "../domain/pipeline-inbox";
import { resultColor } from "./pipeline-result";

interface Props {
  pipelines: PipelineStatus[];
  onAdd: (url: string) => Promise<unknown>;
  onSetMode: (id: string, mode: PipelineMode) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onClose: () => void;
}

/**
 * The watched pipelines (ADR 038): paste a link to a pipeline or one of its
 * runs to add it, pick what notifies, remove it. Chrome mirrors the Inbox and
 * the Repo manager.
 */
export function PipelinesModal({ pipelines, onAdd, onSetMode, onRemove, onClose }: Props) {
  const [url, setUrl] = useState("");
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
          <button aria-label="Close pipelines" data-testid="pipelines-close" onClick={onClose} title="Close" style={iconButtonStyle}>
            <XMarkIcon style={{ width: 16, height: 16 }} />
          </button>
        </div>

        <div style={noteStyle}>
          Paste a link to an Azure DevOps pipeline or to one of its runs. Runs that finish from now on
          notify in the Inbox according to the mode; earlier runs never do. Uses your Azure CLI account
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
