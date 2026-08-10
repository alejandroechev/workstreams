import { useState, useEffect, useCallback, useMemo } from "react";

import { useBackend } from "../backend/context";
import type { CodeTrace, TraceStaleness } from "../backend/types";
import type { TraceFile } from "../domain/trace-format";
import {
  createWalkthrough,
  currentStep,
  canStepBack,
  canStepForward,
  stepForward,
  stepBack,
  gotoStep,
  progressLabel,
  resolveStepPath,
  type Walkthrough,
} from "../domain/walkthrough";
import {
  dispatchWalkthroughNavigate,
  selectExplorerBinding,
  type ExplorerCandidate,
} from "../domain/walkthrough-nav";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";

export interface DebugWalkthroughTileProps {
  tileId: string;
  workstreamId?: string | null;
  /** Repo Explorer tiles in this workstream, for binding. */
  explorerCandidates?: ReadonlyArray<ExplorerCandidate>;
  /** Explicit binding chosen previously, persisted in tile config. */
  boundExplorerId?: string | null;
  onBindExplorer?: (explorerTileId: string) => void;
  /** Current HEAD, for staleness. Undefined means "unknown, don't judge". */
  headCommitSha?: string | null;
}

const panelStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  background: "#1e1e2e",
  color: "#cdd6f4",
  fontSize: 12,
  overflow: "hidden",
};

const barStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 8px",
  borderBottom: "1px solid #313244",
  flexShrink: 0,
};

const buttonStyle: React.CSSProperties = {
  background: "#313244",
  color: "#cdd6f4",
  border: "none",
  borderRadius: 4,
  padding: "4px 8px",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 4,
};

/**
 * Controller for a recorded code walkthrough.
 *
 * It deliberately owns no editor. Stepping fires a navigation event at a bound
 * Repo Explorer, which keeps that tile a fully usable editor — the user can
 * wander off to read anything and press Resync to come back to the current
 * step. Owning an editor here would have made "debug order" and "free order"
 * mutually exclusive, which is the thing this feature exists to avoid.
 */
export function DebugWalkthroughTile({
  workstreamId = null,
  explorerCandidates = [],
  boundExplorerId = null,
  onBindExplorer,
  headCommitSha = null,
}: DebugWalkthroughTileProps) {
  const backend = useBackend();

  const [traces, setTraces] = useState<CodeTrace[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [walkthrough, setWalkthrough] = useState<Walkthrough | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const binding = useMemo(
    () => selectExplorerBinding(boundExplorerId, explorerCandidates),
    [boundExplorerId, explorerCandidates],
  );

  useEffect(() => {
    let cancelled = false;
    backend
      .listCodeTraces(workstreamId)
      .then((rows) => {
        if (!cancelled) setTraces(rows);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [backend, workstreamId]);

  const selectedTrace = useMemo(
    () => traces.find((t) => t.id === selectedTraceId) ?? null,
    [traces, selectedTraceId],
  );

  const loadTrace = useCallback(
    async (trace: CodeTrace) => {
      setLoading(true);
      setError(null);
      try {
        const file: TraceFile = await backend.readCodeTraceFile(trace.trace_path);
        setWalkthrough(createWalkthrough(file));
        setSelectedTraceId(trace.id);
      } catch (e) {
        setError(String(e));
        setWalkthrough(null);
      } finally {
        setLoading(false);
      }
    },
    [backend],
  );

  /** Drive the bound explorer to whatever step the walkthrough is on. */
  const revealCurrent = useCallback(
    (w: Walkthrough | null) => {
      if (!w || !binding.boundId) return;
      const step = currentStep(w);
      if (!step) return;
      dispatchWalkthroughNavigate({
        explorerTileId: binding.boundId,
        path: resolveStepPath(w.trace.repoRoot, step.file),
        line: step.line,
        workstreamId,
      });
    },
    [binding.boundId, workstreamId],
  );

  const move = useCallback(
    (next: Walkthrough) => {
      setWalkthrough(next);
      revealCurrent(next);
    },
    [revealCurrent],
  );

  // Staleness is computed by the backend, which can also see uncommitted
  // edits — those shift line numbers just as effectively as a new commit.
  // Replay is never blocked for it: a banner plus one-click re-record is
  // honest, whereas remapping line numbers would silently point at the wrong
  // code.
  const [staleness, setStaleness] = useState<TraceStaleness>("unknown");
  useEffect(() => {
    if (!walkthrough) {
      setStaleness("unknown");
      return;
    }
    let cancelled = false;
    backend
      .traceStaleness(walkthrough.trace.repoRoot, walkthrough.trace.commitSha)
      .then((verdict) => {
        if (!cancelled) setStaleness(verdict);
      })
      .catch(() => {
        // No verdict is better than a wrong one — stay quiet rather than
        // warning on a git failure.
        if (!cancelled) setStaleness("unknown");
      });
    return () => {
      cancelled = true;
    };
  }, [backend, walkthrough]);

  // An explicit headCommitSha prop overrides the backend, for callers that
  // already know HEAD (and for tests that must not shell out to git).
  const isStale = headCommitSha
    ? !!walkthrough && !headCommitSha.startsWith(walkthrough.trace.commitSha)
    : staleness === "head_moved" || staleness === "tree_dirty";

  const step = walkthrough ? currentStep(walkthrough) : null;

  return (
    <div style={panelStyle} data-testid="debug-walkthrough-tile">
      <div style={barStyle}>
        <select
          aria-label="Trace"
          value={selectedTraceId ?? ""}
          onChange={(e) => {
            const trace = traces.find((t) => t.id === e.target.value);
            if (trace) void loadTrace(trace);
          }}
          style={{ ...buttonStyle, maxWidth: 260 }}
        >
          <option value="">Select a trace…</option>
          {traces.map((t) => (
            <option key={t.id} value={t.id}>
              {t.test_name} ({t.step_count} steps)
            </option>
          ))}
        </select>

        {binding.needsChoice && (
          <select
            aria-label="Repo Explorer"
            value={boundExplorerId ?? ""}
            onChange={(e) => onBindExplorer?.(e.target.value)}
            style={buttonStyle}
          >
            <option value="">Bind explorer…</option>
            {explorerCandidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title || c.id}
              </option>
            ))}
          </select>
        )}

        <div style={{ flex: 1 }} />

        <button
          type="button"
          aria-label="Previous step"
          disabled={!walkthrough || !canStepBack(walkthrough)}
          onClick={() => walkthrough && move(stepBack(walkthrough))}
          style={buttonStyle}
        >
          <ArrowLeftIcon style={{ width: 14, height: 14 }} />
        </button>
        <span data-testid="walkthrough-progress" style={{ minWidth: 60, textAlign: "center" }}>
          {walkthrough ? progressLabel(walkthrough) : "— / —"}
        </span>
        <button
          type="button"
          aria-label="Next step"
          disabled={!walkthrough || !canStepForward(walkthrough)}
          onClick={() => walkthrough && move(stepForward(walkthrough))}
          style={buttonStyle}
        >
          <ArrowRightIcon style={{ width: 14, height: 14 }} />
        </button>
        <button
          type="button"
          aria-label="Resync"
          title="Jump the editor back to the current step"
          disabled={!walkthrough}
          onClick={() => revealCurrent(walkthrough)}
          style={buttonStyle}
        >
          <ArrowPathIcon style={{ width: 14, height: 14 }} />
        </button>
      </div>

      {isStale && (
        <div
          data-testid="walkthrough-stale-banner"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 8px",
            background: "#45332f",
            color: "#f9e2af",
          }}
        >
          <ExclamationTriangleIcon style={{ width: 14, height: 14 }} />
          {staleness === "tree_dirty" && !headCommitSha
            ? "Uncommitted changes since this trace was recorded."
            : `Stale — recorded at ${walkthrough?.trace.commitSha.slice(0, 7)}.`}{" "}
          Line numbers may no longer match; re-record with{" "}
          <code>scripts/trace-record.mjs</code>.
        </div>
      )}

      {walkthrough?.trace.truncated && (
        <div data-testid="walkthrough-truncated-banner" style={{ padding: "6px 8px", color: "#f9e2af" }}>
          This trace is truncated — recording stopped at the step cap.
        </div>
      )}

      {error && (
        <div data-testid="walkthrough-error" style={{ padding: 8, color: "#f38ba8" }}>
          {error}
        </div>
      )}

      {!binding.boundId && explorerCandidates.length === 0 && (
        <div style={{ padding: 8, color: "#6c7086" }}>
          Open a Repo Explorer tile to follow the walkthrough.
        </div>
      )}

      {loading && <div style={{ padding: 8, color: "#6c7086" }}>Loading trace…</div>}

      <div style={{ overflow: "auto", flex: 1 }}>
        {walkthrough && walkthrough.trace.steps.length === 0 && (
          <div style={{ padding: 8, color: "#6c7086" }}>
            This trace has no steps — the test never entered code in this repo.
          </div>
        )}
        {walkthrough?.trace.steps.map((s, i) => {
          const isCurrent = s === step;
          return (
            <button
              key={`${s.file}:${s.line}:${i}`}
              type="button"
              onClick={() => move(gotoStep(walkthrough, i))}
              data-testid={isCurrent ? "walkthrough-step-current" : "walkthrough-step"}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                border: "none",
                cursor: "pointer",
                padding: "3px 8px",
                fontFamily: "monospace",
                fontSize: 11,
                background: isCurrent ? "#313244" : "transparent",
                color: isCurrent ? "#a6e3a1" : "#cdd6f4",
              }}
            >
              {i + 1}. {s.file}:{s.line} {s.function.split("::").pop()}
              {s.hits ? `  x${s.hits}` : ""}
            </button>
          );
        })}
      </div>

      {selectedTrace && (
        <div style={{ padding: "4px 8px", borderTop: "1px solid #313244", color: "#6c7086" }}>
          {selectedTrace.test_name} · recorded {selectedTrace.recorded_at.slice(0, 10)} @{" "}
          {selectedTrace.commit_sha.slice(0, 7)}
        </div>
      )}
    </div>
  );
}

export default DebugWalkthroughTile;
