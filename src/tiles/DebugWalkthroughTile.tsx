import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";

import { useBackend } from "../backend/context";
import type { CodeTrace, TraceStaleness } from "../backend/types";
import type { TraceFile } from "../domain/trace-format";
import {
  createWalkthrough,
  currentStep,
  canStepBack,
  canStepForward,
  canStepOut,
  stepOut,
  stepForward,
  stepBack,
  gotoStep,
  progressLabel,
  resolveStepPath,
  totalSteps,
  type Walkthrough,
} from "../domain/walkthrough";
import { parseWalkthroughKey } from "../domain/walkthrough-keys";
import {
  dispatchWalkthroughNavigate,
  selectExplorerBinding,
  type ExplorerCandidate,
} from "../domain/walkthrough-nav";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  ExclamationTriangleIcon,
  PlusIcon,
  VideoCameraIcon,
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
  /** Repo root. Without one there is nothing to point cargo at, so recording
   *  is unavailable rather than failing obscurely on click. */
  workstreamDir?: string | null;
  /** Copilot sessions linked to this workstream. The first owns new traces,
   *  which keeps recordings out of the repo. */
  linkedSessionIds?: string[];
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

/** One labelled row of the toolbar. Rows rather than a single line so the
 *  controls stay usable in a narrow tile — the previous single row pushed the
 *  stepping buttons off the right edge. */
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 8px",
  flexShrink: 0,
};

const rowLabelStyle: React.CSSProperties = {
  color: "#6c7086",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  width: 48,
  flexShrink: 0,
};

const iconStyle: React.CSSProperties = { width: 14, height: 14 };

const controlStyle: React.CSSProperties = {
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
  workstreamDir = null,
  linkedSessionIds = [],
}: DebugWalkthroughTileProps) {
  const backend = useBackend();

  const [traces, setTraces] = useState<CodeTrace[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [walkthrough, setWalkthrough] = useState<Walkthrough | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [availableTests, setAvailableTests] = useState<string[] | null>(null);
  const [testsError, setTestsError] = useState<string | null>(null);
  const [selectedTest, setSelectedTest] = useState("");
  const [recording, setRecording] = useState(false);
  const [recordProgress, setRecordProgress] = useState("");

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

  // Offer the crate's own tests as entry points. Using cargo's listing keeps
  // this authoritative and avoids parsing Rust source.
  useEffect(() => {
    if (!workstreamDir) return;
    let cancelled = false;
    setTestsError(null);
    backend
      .listRustTests(workstreamDir)
      .then((tests) => {
        if (!cancelled) setAvailableTests(tests);
      })
      .catch((e) => {
        // Surfaced, not swallowed: a silent catch here hid a real bug where
        // cargo could not find Cargo.toml and the picker just sat empty with
        // nothing for the user to act on.
        if (!cancelled) {
          setAvailableTests([]);
          setTestsError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [backend, workstreamDir]);

  // Progress from the recorder. A recording drives a debugger step by step and
  // takes seconds to minutes, so silence would read as a hang.
  useEffect(() => {
    if (!recording) return;
    let unlisten: (() => void) | undefined;
    listen<{ phase: string; steps: number }>("trace-record-progress", (event) => {
      const { phase, steps } = event.payload;
      setRecordProgress(steps > 0 ? `${phase} (${steps} steps)` : phase);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        // No Tauri host (tests, or the browser E2E server): recording still
        // works, it just reports no intermediate progress. An unhandled
        // rejection here would surface as a spurious test failure.
      });
    return () => unlisten?.();
  }, [recording]);

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

  /**
   * Register a trace file written by `scripts/trace-record.mjs`.
   *
   * The recorder is a CLI and knows nothing about this database, so without an
   * explicit "adopt this file" action a recorded trace would never appear in
   * the picker — the feature would have no entry point at all.
   */
  const addTraceFromDisk = useCallback(async () => {
    setError(null);
    let picked: string | string[] | null;
    try {
      picked = await open({ title: "Open walkthrough trace", multiple: false, directory: false });
    } catch (e) {
      setError(String(e));
      return;
    }
    if (typeof picked !== "string") return; // dismissed
    try {
      const indexed = await backend.indexCodeTrace(picked, workstreamId);
      setTraces(await backend.listCodeTraces(workstreamId));
      await loadTrace(indexed);
    } catch (e) {
      setError(String(e));
    }
  }, [backend, workstreamId, loadTrace]);

  /**
   * Record the selected test, then index and open the resulting trace.
   *
   * The recorder runs in the Rust backend rather than shelling out to the
   * Node CLI: a bundled .app ships neither `scripts/` nor a guaranteed `node`,
   * so shelling out would only have worked when the open workstream happened
   * to be this repo.
   */
  const recordSelectedTest = useCallback(async () => {
    if (!workstreamDir || !selectedTest) return;
    setError(null);
    setRecording(true);
    setRecordProgress("starting");
    try {
      const tracePath = await backend.recordCodeTrace(
        selectedTest,
        workstreamDir,
        workstreamDir,
        linkedSessionIds[0] ?? null,
      );
      const indexed = await backend.indexCodeTrace(tracePath, workstreamId);
      setTraces(await backend.listCodeTraces(workstreamId));
      await loadTrace(indexed);
    } catch (e) {
      setError(String(e));
    } finally {
      setRecording(false);
      setRecordProgress("");
    }
  }, [backend, workstreamDir, selectedTest, workstreamId, linkedSessionIds, loadTrace]);

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

  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * Step from the keyboard.
   *
   * Bare keys are safe here because every app-level command uses `Alt+`, but
   * they must not fire while the user is interacting with a control: a `j`
   * typed to jump inside the trace dropdown should not also advance the
   * walkthrough underneath it.
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "select" || tag === "input" || tag === "textarea" || tag === "button") return;

      const action = parseWalkthroughKey({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      });
      if (!action || !walkthrough) return;
      event.preventDefault();

      switch (action) {
        case "next":
          move(stepForward(walkthrough));
          break;
        case "prev":
          move(stepBack(walkthrough));
          break;
        case "first":
          move(gotoStep(walkthrough, 0));
          break;
        case "last":
          move(gotoStep(walkthrough, totalSteps(walkthrough) - 1));
          break;
        case "out":
          move(stepOut(walkthrough));
          break;
        case "resync":
          revealCurrent(walkthrough);
          break;
      }
    },
    [walkthrough, move, revealCurrent],
  );

  const step = walkthrough ? currentStep(walkthrough) : null;

  return (
    <div
      style={panelStyle}
      data-testid="debug-walkthrough-tile"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      ref={rootRef}
    >
      {/* Trace: which recording is open. */}
      <div style={rowStyle} data-testid="walkthrough-section-trace">
        <span style={rowLabelStyle}>Trace</span>
        <select
          aria-label="Trace"
          value={selectedTraceId ?? ""}
          onChange={(e) => {
            const trace = traces.find((t) => t.id === e.target.value);
            if (trace) void loadTrace(trace);
          }}
          style={{ ...controlStyle, flex: 1, minWidth: 0 }}
        >
          <option value="">Select a trace…</option>
          {traces.map((t) => (
            <option key={t.id} value={t.id}>
              {t.test_name} ({t.step_count} steps)
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="Add trace"
          title="Open a trace file recorded with scripts/trace-record.mjs"
          onClick={() => void addTraceFromDisk()}
          style={controlStyle}
        >
          <PlusIcon style={iconStyle} />
        </button>
      </div>

      {/* Record: produce a new trace from a test in this workstream. */}
      {workstreamDir && (
        <div style={rowStyle} data-testid="walkthrough-section-record">
          <span style={rowLabelStyle}>Record</span>
          <select
            aria-label="Test"
            value={selectedTest}
            onChange={(e) => setSelectedTest(e.target.value)}
            style={{ ...controlStyle, flex: 1, minWidth: 0 }}
          >
            <option value="">Select a test…</option>
            {(availableTests ?? []).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label="Record trace"
            title="Run the test under a debugger and record its execution"
            disabled={!selectedTest || recording}
            onClick={() => void recordSelectedTest()}
            style={controlStyle}
          >
            <VideoCameraIcon style={iconStyle} />
          </button>
        </div>
      )}

      {/* Step: move through the open trace. */}
      <div style={{ ...rowStyle, borderBottom: "1px solid #313244" }} data-testid="walkthrough-section-step">
        <span style={rowLabelStyle}>Step</span>
        <button
          type="button"
          aria-label="Previous step"
          title="Previous step (↑ / k)"
          disabled={!walkthrough || !canStepBack(walkthrough)}
          onClick={() => walkthrough && move(stepBack(walkthrough))}
          style={controlStyle}
        >
          <ArrowLeftIcon style={iconStyle} />
        </button>
        <span data-testid="walkthrough-progress" style={{ minWidth: 56, textAlign: "center" }}>
          {walkthrough ? progressLabel(walkthrough) : "— / —"}
        </span>
        <button
          type="button"
          aria-label="Next step"
          title="Next step (↓ / j / space)"
          disabled={!walkthrough || !canStepForward(walkthrough)}
          onClick={() => walkthrough && move(stepForward(walkthrough))}
          style={controlStyle}
        >
          <ArrowRightIcon style={iconStyle} />
        </button>
        <button
          type="button"
          aria-label="Step out"
          title="Finish this function and return to the caller (o)"
          disabled={!walkthrough || !canStepOut(walkthrough)}
          onClick={() => walkthrough && move(stepOut(walkthrough))}
          style={controlStyle}
        >
          <ArrowUturnLeftIcon style={iconStyle} />
        </button>
        <button
          type="button"
          aria-label="Resync"
          title="Jump the editor back to the current step (r)"
          disabled={!walkthrough}
          onClick={() => revealCurrent(walkthrough)}
          style={controlStyle}
        >
          <ArrowPathIcon style={iconStyle} />
        </button>
        <div style={{ flex: 1 }} />
        {/* Only shown when the choice is real: with one explorer open the tile
            binds silently, so a picker would be noise. */}
        {binding.needsChoice ? (
          <select
            aria-label="Repo Explorer"
            value={boundExplorerId ?? ""}
            onChange={(e) => onBindExplorer?.(e.target.value)}
            style={controlStyle}
          >
            <option value="">Bind explorer…</option>
            {explorerCandidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title || c.id}
              </option>
            ))}
          </select>
        ) : (
          <span style={{ color: "#585b70", fontSize: 10, whiteSpace: "nowrap" }}>
            ↑↓ step · o out · Home/End ends · r resync
          </span>
        )}
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

      {workstreamDir && availableTests !== null && availableTests.length === 0 && (
        <div data-testid="walkthrough-tests-unavailable" style={{ padding: "6px 8px", color: "#f9e2af" }}>
          {testsError ?? "No tests found in this workstream's Rust crate."}
        </div>
      )}

      {recording && (
        <div data-testid="walkthrough-recording" style={{ padding: "6px 8px", color: "#a6e3a1" }}>
          Recording {selectedTest}… {recordProgress}
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
