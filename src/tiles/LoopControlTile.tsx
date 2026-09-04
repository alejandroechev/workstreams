import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowPathIcon,
  ArrowPathRoundedSquareIcon,
  ArrowUturnLeftIcon,
  CheckIcon,
  DocumentTextIcon,
  ExclamationTriangleIcon,
  PauseIcon,
  PlayIcon,
  HandRaisedIcon,
  StopIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";

import {
  LOOP_RUN_FILTERS,
  LOOP_TASK_FILTERS,
  countRunsByFilter,
  describeRun,
  matchesRunFilter,
  matchesTaskFilter,
  orderRuns,
  orderTasks,
  summarizeRunTiming,
  summarizeTaskTiming,
  taskHeadline,
  type LoopRunFilter,
  type LoopTaskFilter,
  type LoopTaskSort,
  type LoopTaskTiming,
} from "../domain/loop-timing";
import { useBackend } from "../backend/context";
import { FileEditorView } from "../files/FileEditorView";
import {
  fileBufferRegistry,
  type BufferSnapshot,
} from "../files/FileBufferRegistry";
import type {
  LoopApprovalDecision,
  LoopApprovalRecord,
  LoopDefinition,
  LoopDefinitionCatalog,
  LoopEvaluationRecord,
  LoopEventRecord,
  LoopRun,
  LoopRunState,
  LoopRunSummary,
  LoopSpec,
  LoopStageRecord,
  LoopTask,
  LoopVerificationRecord,
  PersistedLoopSnapshot,
} from "../domain/loop";

export interface LoopControlTileProps {
  tileId: string;
  workstreamId: string;
  workstreamDir: string;
  isFocused?: boolean;
}

const EMPTY_SNAPSHOT: PersistedLoopSnapshot = {
  spec: null,
  latestRun: null,
  tasks: [],
  verifications: [],
  evaluations: [],
  approvals: [],
  stages: [],
  events: [],
};

const EMPTY_CATALOG: LoopDefinitionCatalog = {
  definitions: [],
  invalid: [],
};

const TERMINAL_RUN_STATES: ReadonlySet<LoopRunState> = new Set([
  "completed",
  "attention",
  "killed",
]);

const rootStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  background: "#1e1e2e",
  color: "#cdd6f4",
  fontSize: 12,
};

const scrollStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: 10,
};

const sectionStyle: React.CSSProperties = {
  background: "#181825",
  border: "1px solid #313244",
  borderRadius: 6,
  padding: 10,
  marginBottom: 10,
};

const headingStyle: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "#a6adc8",
};

const buttonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  border: "1px solid #45475a",
  borderRadius: 4,
  padding: "5px 8px",
  background: "#313244",
  color: "#cdd6f4",
  cursor: "pointer",
  font: "inherit",
};

const iconStyle: React.CSSProperties = { width: 14, height: 14, flexShrink: 0 };

const selectStyle: React.CSSProperties = {
  border: "1px solid #45475a",
  borderRadius: 4,
  padding: "4px 6px",
  background: "#313244",
  color: "#cdd6f4",
  font: "inherit",
};

/**
 * Tab chrome copied from the Repo Explorer so every multi-tab tile reads as one
 * control rather than each inventing its own header.
 */
const tabBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  gap: 0,
  background: "#11111b",
  borderBottom: "1px solid #313244",
  flexShrink: 0,
  padding: "0 4px",
};

const tabButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  background: "transparent",
  border: "none",
  padding: "5px 10px",
  cursor: "pointer",
  fontSize: 11,
  fontFamily: "inherit",
};

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px",
  background: "#181825",
  borderBottom: "1px solid #313244",
  flexShrink: 0,
};

/** Left column shared by both tabs, matching the Repo Explorer diff file list. */
const sidePanelStyle: React.CSSProperties = {
  width: 210,
  minWidth: 150,
  borderRight: "1px solid #313244",
  background: "#181825",
  display: "flex",
  flexDirection: "column",
  flexShrink: 0,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateLabel(state: LoopRunState): string {
  const words = state.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remaining}s` : `${remaining}s`;
}

function nextEvidence(run: LoopRun, spec: LoopSpec): string {
  switch (run.state) {
    case "starting":
    case "resuming":
    case "orchestrating":
      return "Orchestrator task evidence pending";
    case "working":
      if (spec.verifier) return "Verifier is next";
      if (spec.evaluator) return "Evaluator is next";
      return "Completion is next";
    case "verifying":
      return "Verifier evidence in progress";
    case "evaluating":
      return "Evaluator verdict in progress";
    case "awaiting_approval":
      return "Human approval is required";
    case "paused":
      return "Paused at a safe boundary";
    case "stopping":
      return "Waiting for the current safe boundary";
    case "attention":
      return "Operator attention required";
    case "completed":
    case "killed":
      return "No next stage";
  }
}

function feedbackMode(definition: LoopDefinition): string {
  const sensors = [];
  if (definition.hasVerification) sensors.push("Verification");
  if (definition.hasEvaluator) sensors.push("Evaluator");
  if (definition.hasHumanApproval) sensors.push("Human approval");
  return sensors.join(" + ") || "Completion only";
}

function formatPayload(payload: unknown): string {
  try {
    const rendered = JSON.stringify(payload);
    return rendered ?? "";
  } catch {
    return "Unserializable event payload";
  }
}

function ActionButton({
  testId,
  label,
  icon: Icon,
  disabled,
  onClick,
}: {
  testId: string;
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        ...buttonStyle,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <Icon aria-hidden="true" style={iconStyle} />
      {label}
    </button>
  );
}

function DefinitionRow({
  label,
  detail,
  selected,
  invalid,
  testId,
  onSelect,
}: {
  label: string;
  detail: string;
  selected: boolean;
  invalid?: boolean;
  testId: string;
  onSelect: () => void;
}) {
  const Icon = invalid ? ExclamationTriangleIcon : DocumentTextIcon;
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={selected}
      onClick={onSelect}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        border: "none",
        borderBottom: "1px solid #222",
        borderLeft: `2px solid ${selected ? "#89b4fa" : "transparent"}`,
        background: selected ? "#313244" : "transparent",
        color: invalid ? "#f5c2e7" : "#cdd6f4",
        padding: "6px 8px",
        cursor: "pointer",
        font: "inherit",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <Icon aria-hidden="true" style={{ width: 12, height: 12, flexShrink: 0 }} />
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      </span>
      <span
        style={{
          display: "block",
          marginTop: 2,
          color: "#6c7086",
          fontSize: 11,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {detail}
      </span>
    </button>
  );
}

/**
 * Definitions tab: the catalog on the left, the YAML editor on the right.
 *
 * Mirrors the Repo Explorer diff layout so selecting a definition and reading
 * its source is the same gesture as selecting a file and reading its diff. Run
 * lives in the toolbar because it acts on the selection, not on the editor.
 */
function DefinitionsPanel({
  catalog,
  selectedPath,
  editorSnapshot,
  editorRevision,
  busy,
  runIsActive,
  onSelect,
  onSnapshotChange,
  onRun,
}: {
  catalog: LoopDefinitionCatalog;
  selectedPath: string | null;
  editorSnapshot: BufferSnapshot | null;
  editorRevision: number;
  busy: boolean;
  runIsActive: boolean;
  onSelect: (path: string) => void;
  onSnapshotChange: (snapshot: BufferSnapshot | null) => void;
  onRun: () => void;
}) {
  const selectedDefinition = catalog.definitions.find(
    (definition) => definition.path === selectedPath,
  );
  const selectedInvalid = catalog.invalid.find(
    (definition) => definition.path === selectedPath,
  );
  const selectedName =
    selectedDefinition?.name ??
    selectedPath?.split(/[\\/]/).pop() ??
    "Loop definition";
  const empty = catalog.definitions.length === 0 && catalog.invalid.length === 0;

  return (
    <div
      data-testid="loop-definitions-tab"
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <div style={toolbarStyle}>
        <span
          data-testid="loop-definition-title"
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <strong>
            {selectedName}
            {editorSnapshot?.dirty ? "*" : ""}
          </strong>
          {editorSnapshot?.dirty && (
            <span style={{ color: "#f9e2af", marginLeft: 6 }}>Unsaved</span>
          )}
        </span>
        <ActionButton
          testId="loop-run-selected"
          label="Run"
          icon={PlayIcon}
          disabled={busy || runIsActive || !selectedDefinition}
          onClick={onRun}
        />
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={sidePanelStyle} data-testid="loop-definition-list">
          <div style={{ flex: 1, overflowY: "auto" }}>
            {empty && (
              <div
                data-testid="loop-definition-empty"
                style={{ padding: 10, color: "#a6adc8", lineHeight: 1.5 }}
              >
                Create <code>files/loops/&lt;id&gt;.loop.yaml</code> in this
                workstream&apos;s bound Copilot session, or use the{" "}
                <code>create-loop</code> skill to author one.
              </div>
            )}
            {catalog.definitions.map((definition) => (
              <DefinitionRow
                key={definition.path}
                testId={`loop-definition-${definition.id}`}
                label={definition.name}
                detail={feedbackMode(definition)}
                selected={definition.path === selectedPath}
                onSelect={() => onSelect(definition.path)}
              />
            ))}
            {catalog.invalid.map((definition) => (
              <DefinitionRow
                key={definition.path}
                testId={`loop-definition-invalid-${definition.path
                  .split(/[\\/]/)
                  .pop()}`}
                label={definition.path.split(/[\\/]/).pop() ?? definition.path}
                detail="Invalid definition"
                invalid
                selected={definition.path === selectedPath}
                onSelect={() => onSelect(definition.path)}
              />
            ))}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {selectedPath ? (
            <>
              <div
                data-testid="loop-definition-editor-header"
                style={{
                  padding: "5px 10px",
                  borderBottom: "1px solid #313244",
                  background: "#181825",
                }}
              >
                <div
                  style={{
                    color: "#6c7086",
                    fontFamily: "monospace",
                    overflowWrap: "anywhere",
                  }}
                >
                  {selectedPath}
                </div>
                {selectedDefinition && (
                  <div style={{ color: "#bac2de", marginTop: 2 }}>
                    {selectedDefinition.objective}
                  </div>
                )}
                {selectedDefinition && !selectedDefinition.portable && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      color: "#f9e2af",
                      marginTop: 3,
                    }}
                  >
                    <ExclamationTriangleIcon aria-hidden="true" style={iconStyle} />
                    Not portable: this definition uses machine-specific
                    configuration.
                  </div>
                )}
                {selectedInvalid && (
                  <div style={{ color: "#f38ba8", marginTop: 3 }}>
                    {selectedInvalid.error}
                  </div>
                )}
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <FileEditorView
                  key={`${selectedPath}:${editorRevision}`}
                  path={selectedPath}
                  onBack={() => {}}
                  showHeader={false}
                  onSnapshotChange={onSnapshotChange}
                />
              </div>
            </>
          ) : (
            <div style={{ padding: 12, color: "#6c7086" }}>
              Create a YAML definition with the <code>create-loop</code> skill,
              then refresh the catalog.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function VerificationEvidence({ record }: { record: LoopVerificationRecord }) {
  return (
    <div
      data-testid={`loop-verification-${record.id}`}
      style={{ borderLeft: "2px solid #f9e2af", paddingLeft: 8, marginTop: 7 }}
    >
      <div>
        Verifier: <strong>{record.status}</strong>
        {record.exitCode !== undefined ? ` (exit ${record.exitCode})` : ""}
        {` in ${formatDuration(record.durationMs)}`}
      </div>
      {record.stdout && (
        <pre style={{ whiteSpace: "pre-wrap", color: "#a6e3a1", margin: "4px 0" }}>
          {record.stdout}
        </pre>
      )}
      {record.stderr && (
        <pre style={{ whiteSpace: "pre-wrap", color: "#f38ba8", margin: "4px 0" }}>
          {record.stderr}
        </pre>
      )}
    </div>
  );
}

function EvaluationEvidence({ record }: { record: LoopEvaluationRecord }) {
  return (
    <div
      data-testid={`loop-evaluation-${record.id}`}
      style={{ borderLeft: "2px solid #89b4fa", paddingLeft: 8, marginTop: 7 }}
    >
      <div>
        Evaluator: <strong>{record.verdict}</strong>
      </div>
      <div>{record.summary}</div>
      {record.feedback && <div style={{ color: "#f9e2af" }}>{record.feedback}</div>}
      {record.evidence.length > 0 && (
        <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
          {record.evidence.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ApprovalEvidence({ record }: { record: LoopApprovalRecord }) {
  return (
    <div
      data-testid={`loop-approval-${record.id}`}
      style={{ borderLeft: "2px solid #cba6f7", paddingLeft: 8, marginTop: 7 }}
    >
      <div>
        Human approval: <strong>{record.status.replace("_", " ")}</strong>
      </div>
      <div>{record.prompt}</div>
      {record.feedback && <div style={{ color: "#f9e2af" }}>{record.feedback}</div>}
    </div>
  );
}

type ParsedWorkerResult = {
  status?: string;
  summary?: string;
  evidence?: string[];
};

function parseWorkerResult(value: string | undefined): ParsedWorkerResult | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    return {
      status: typeof record.status === "string" ? record.status : undefined,
      summary: typeof record.summary === "string" ? record.summary : undefined,
      evidence: Array.isArray(record.evidence)
        ? record.evidence.filter((item): item is string => typeof item === "string")
        : undefined,
    };
  } catch {
    return null;
  }
}

function concisePreview(value: string, maxLength = 320): string {
  const line = value
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean) ?? "";
  return line.length > maxLength ? `${line.slice(0, maxLength)}…` : line;
}

function taskStatusSummary(
  task: LoopTask,
  verifications: LoopVerificationRecord[],
  evaluations: LoopEvaluationRecord[],
  approvals: LoopApprovalRecord[],
  maxTaskIterations: number,
): { label: string; message: string; warning?: string } {
  const worker = parseWorkerResult(task.workerResult);
  const latestVerification = verifications[verifications.length - 1];
  const latestEvaluation = evaluations[evaluations.length - 1];
  const pendingApproval = approvals.find((approval) => approval.status === "pending");
  if (pendingApproval) {
    return {
      label: "Approval required",
      message: pendingApproval.prompt,
    };
  }
  if (task.state === "attention" || task.state === "blocked") {
    const workerFailed = worker?.status && worker.status !== "completed";
    const verifierFailed =
      latestVerification && latestVerification.status !== "passed";
    const verifierIsNewest =
      verifierFailed &&
      (!latestEvaluation || latestVerification.attempt >= latestEvaluation.attempt);
    const verifierMessage =
      concisePreview(latestVerification?.stderr ?? "") ||
      concisePreview(latestVerification?.stdout ?? "") ||
      (latestVerification
        ? `Verifier finished with status ${latestVerification.status}.`
        : undefined);
    return {
      label: "Action required",
      message:
        (workerFailed ? worker?.summary : undefined) ??
        (verifierIsNewest ? verifierMessage : undefined) ??
        task.error ??
        latestEvaluation?.feedback ??
        latestEvaluation?.summary ??
        worker?.summary ??
        "Inspect the details and decide how to continue.",
      warning:
        task.revisionCount + 1 >= maxTaskIterations
          ? "Automatic revisions exhausted. Correct the issue manually, then start a new run."
          : undefined,
    };
  }
  switch (task.state) {
    case "queued":
      return { label: "Queued", message: "Waiting for the worker." };
    case "working":
      return { label: "Working", message: worker?.summary ?? "Worker is implementing the task." };
    case "verifying":
      return { label: "Verifying", message: "Deterministic verification is running." };
    case "evaluating":
      return { label: "Evaluating", message: "Independent evaluation is running." };
    case "awaiting_approval":
      return { label: "Approval required", message: "Review the task evidence." };
    case "accepted":
      return { label: "Accepted", message: latestEvaluation?.summary ?? worker?.summary ?? "Task accepted." };
    case "interrupted":
      return { label: "Interrupted", message: task.error ?? "The task was interrupted." };
  }
}

function CurrentTaskDetail({
  task,
  timing,
}: {
  task: LoopTask;
  timing: LoopTaskTiming;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div style={{ color: "#a6adc8" }}>{taskHeadline(task)}</div>
      {timing.totalMs > 0 && (
        <div data-testid="loop-current-task-duration" style={{ color: "#a6adc8" }}>
          Stage time: {formatDuration(timing.totalMs)}
        </div>
      )}
      <details data-testid="loop-current-task-details" open={open}>
        <summary
          onClick={(event) => {
            event.preventDefault();
            setOpen((current) => !current);
          }}
          style={{ color: "#89b4fa", cursor: "pointer", userSelect: "none" }}
        >
          Objective
        </summary>
        {open && (
          <div style={{ marginTop: 4, color: "#a6adc8" }}>
            {task.objective}
            <StageTimings timing={timing} testId="loop-current-task-stage-timings" />
          </div>
        )}
      </details>
    </>
  );
}

const STATUS_PREVIEW_LIMIT = 220;

function TaskStatusMessage({
  message,
  testId,
}: {
  message: string;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  if (message.length <= STATUS_PREVIEW_LIMIT) {
    return <div style={{ marginTop: 3 }}>{message}</div>;
  }
  return (
    <details data-testid={testId} open={open} style={{ marginTop: 3 }}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
        style={{ cursor: "pointer", userSelect: "none" }}
      >
        {open ? "Show less" : `${message.slice(0, STATUS_PREVIEW_LIMIT).trimEnd()}…`}
      </summary>
      {open && <div style={{ marginTop: 4 }}>{message}</div>}
    </details>
  );
}

function StageTimings({
  timing,
  testId,
}: {
  timing: LoopTaskTiming;
  testId: string;
}) {
  if (timing.stages.length === 0) return null;
  return (
    <div data-testid={testId} style={{ marginTop: 6 }}>
      <div style={{ color: "#a6adc8" }}>
        Stage time: {formatDuration(timing.totalMs)}
      </div>
      <ul style={{ margin: "4px 0 0", paddingLeft: 16, color: "#bac2de" }}>
        {timing.stages.map((stage) => (
          <li key={stage.id} data-testid={`loop-stage-${stage.id}`}>
            {stage.role} #{stage.attempt}: {formatDuration(stage.durationMs)}
            {stage.status !== "completed" && stage.status !== "passed"
              ? ` (${stage.status})`
              : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TaskCard({
  task,
  verifications,
  evaluations,
  approvals,
  maxTaskIterations,
  timing,
}: {
  task: LoopTask;
  verifications: LoopVerificationRecord[];
  evaluations: LoopEvaluationRecord[];
  approvals: LoopApprovalRecord[];
  maxTaskIterations: number;
  timing: LoopTaskTiming;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const worker = parseWorkerResult(task.workerResult);
  const status = taskStatusSummary(
    task,
    verifications,
    evaluations,
    approvals,
    maxTaskIterations,
  );
  const needsAction =
    task.state === "attention" ||
    task.state === "blocked" ||
    approvals.some((approval) => approval.status === "pending");

  return (
    <article
      data-testid={`loop-task-${task.id}`}
      style={{
        background: "#11111b",
        border: `1px solid ${needsAction ? "#f9e2af" : "#313244"}`,
        borderRadius: 4,
        padding: 8,
        marginBottom: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <strong>{task.title}</strong>
        <span style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          {timing.totalMs > 0 && (
            <span
              data-testid={`loop-task-duration-${task.id}`}
              style={{ color: "#a6adc8" }}
            >
              {formatDuration(timing.totalMs)}
            </span>
          )}
          <span style={{ color: needsAction ? "#f9e2af" : "#89b4fa" }}>
            {task.state.replace(/_/g, " ")}
          </span>
        </span>
      </div>
      <div
        data-testid={`loop-task-status-${task.id}`}
        style={{
          marginTop: 7,
          padding: 8,
          borderLeft: `3px solid ${needsAction ? "#f9e2af" : "#89b4fa"}`,
          background: needsAction ? "#2a2518" : "#181825",
          whiteSpace: "pre-wrap",
        }}
      >
        <strong>{status.label}</strong>
        <TaskStatusMessage
          message={status.message}
          testId={`loop-task-message-${task.id}`}
        />
        {status.warning && (
          <div style={{ color: "#f9e2af", marginTop: 5 }}>{status.warning}</div>
        )}
      </div>
      <details
        data-testid={`loop-task-details-${task.id}`}
        open={detailsOpen}
        style={{ marginTop: 8 }}
      >
        <summary
          onClick={(event) => {
            event.preventDefault();
            setDetailsOpen((open) => !open);
          }}
          style={{ color: "#89b4fa", cursor: "pointer", userSelect: "none" }}
        >
          Details
        </summary>
        {detailsOpen && (
          <div style={{ marginTop: 7 }}>
            <div style={{ color: "#a6adc8" }}>{task.objective}</div>
            <StageTimings
              timing={timing}
              testId={`loop-task-stage-timings-${task.id}`}
            />
            <div style={{ color: "#6c7086", marginTop: 3 }}>
              Revisions: {task.revisionCount}
              {task.workerSessionId ? ` / Worker session: ${task.workerSessionId}` : ""}
            </div>
            {task.workerResult && (
              <div
                data-testid={`loop-worker-result-${task.id}`}
                style={{ marginTop: 7, whiteSpace: "pre-wrap" }}
              >
                <strong>Worker result</strong>
                {worker?.summary ? (
                  <div data-testid={`loop-worker-summary-${task.id}`}>
                    {worker.summary}
                  </div>
                ) : (
                  <div>{task.workerResult}</div>
                )}
                {worker?.evidence && worker.evidence.length > 0 && (
                  <ul
                    data-testid={`loop-worker-evidence-${task.id}`}
                    style={{ margin: "4px 0", paddingLeft: 18 }}
                  >
                    {worker.evidence.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {task.error && (
              <div style={{ color: "#f38ba8", marginTop: 6 }}>{task.error}</div>
            )}
            {verifications.map((record) => (
              <VerificationEvidence key={record.id} record={record} />
            ))}
            {evaluations.map((record) => (
              <EvaluationEvidence key={record.id} record={record} />
            ))}
            {approvals.map((record) => (
              <ApprovalEvidence key={record.id} record={record} />
            ))}
          </div>
        )}
      </details>
    </article>
  );
}

const TASK_FILTER_LABELS: Record<LoopTaskFilter, string> = {
  all: "All",
  active: "Active",
  accepted: "Accepted",
  attention: "Needs attention",
};

function TaskList({
  tasks,
  verifications,
  evaluations,
  approvals,
  maxTaskIterations,
  stages,
}: {
  tasks: LoopTask[];
  verifications: LoopVerificationRecord[];
  evaluations: LoopEvaluationRecord[];
  approvals: LoopApprovalRecord[];
  maxTaskIterations: number;
  stages: LoopStageRecord[];
}) {
  const actionable = tasks.filter(
    (task) => task.state === "attention" || task.state === "blocked",
  ).length;
  const [open, setOpen] = useState(actionable > 0);
  const [sort, setSort] = useState<LoopTaskSort>("newest");
  const [filter, setFilter] = useState<LoopTaskFilter>("all");
  const visible = orderTasks(
    tasks.filter((task) => matchesTaskFilter(task, filter)),
    sort,
  );
  return (
    <details data-testid="loop-task-list" open={open} style={sectionStyle}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
        style={{ ...headingStyle, margin: 0, cursor: "pointer", userSelect: "none" }}
      >
        Tasks ({tasks.length}
        {actionable > 0 ? `, ${actionable} need attention` : ""})
      </summary>
      {open && (
        <>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              alignItems: "center",
              marginTop: 8,
            }}
          >
            <label style={{ color: "#a6adc8" }}>
              Show{" "}
              <select
                data-testid="loop-task-filter"
                aria-label="Filter tasks by state"
                value={filter}
                onChange={(event) =>
                  setFilter(event.target.value as LoopTaskFilter)
                }
                style={selectStyle}
              >
                {LOOP_TASK_FILTERS.map((option) => (
                  <option key={option} value={option}>
                    {TASK_FILTER_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>
            <button
              data-testid="loop-task-sort"
              type="button"
              onClick={() =>
                setSort((current) => (current === "newest" ? "oldest" : "newest"))
              }
              style={buttonStyle}
            >
              {sort === "newest" ? "Newest first" : "Oldest first"}
            </button>
          </div>
          {visible.length === 0 ? (
            <div data-testid="loop-task-empty" style={{ color: "#6c7086", marginTop: 8 }}>
              {tasks.length === 0
                ? "No tasks have been proposed."
                : "No tasks match this filter."}
            </div>
          ) : (
            <div style={{ marginTop: 8 }}>
              {visible.map((task) => {
                const taskVerifications = verifications.filter(
                  (record) => record.loopTaskId === task.id,
                );
                const taskEvaluations = evaluations
                  .filter((record) => record.loopTaskId === task.id)
                  .sort((left, right) => left.attempt - right.attempt);
                const taskApprovals = approvals
                  .filter((record) => record.loopTaskId === task.id)
                  .sort((left, right) => left.attempt - right.attempt);
                return (
                  <TaskCard
                    key={task.id}
                    task={task}
                    verifications={taskVerifications}
                    evaluations={taskEvaluations}
                    approvals={taskApprovals}
                    maxTaskIterations={maxTaskIterations}
                    timing={summarizeTaskTiming(stages, task.id)}
                  />
                );
              })}
            </div>
          )}
        </>
      )}
    </details>
  );
}

function EventTimeline({ events }: { events: LoopEventRecord[] }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      data-testid="loop-event-timeline"
      open={open}
      style={sectionStyle}
    >
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
        style={{ ...headingStyle, margin: 0, cursor: "pointer", userSelect: "none" }}
      >
        Event timeline ({events.length})
      </summary>
      {open && (events.length === 0 ? (
        <div style={{ color: "#6c7086", marginTop: 8 }}>No loop events yet.</div>
      ) : (
        <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {events.map((event) => {
            const payload = formatPayload(event.payload);
            return (
              <li
                key={event.id}
                data-testid={`loop-event-${event.id}`}
                style={{ borderLeft: "2px solid #45475a", padding: "3px 0 6px 8px" }}
              >
                <div>
                  <strong>{event.eventType}</strong>
                  <span style={{ color: "#6c7086", marginLeft: 6 }}>
                    {event.createdAt}
                  </span>
                </div>
                {payload && (
                  <code style={{ color: "#a6adc8", whiteSpace: "pre-wrap" }}>
                    {payload}
                  </code>
                )}
              </li>
            );
          })}
        </ol>
      ))}
    </details>
  );
}

function RunDefinition({ run, spec }: { run: LoopRun; spec: LoopSpec }) {
  const [open, setOpen] = useState(false);
  const name = spec.definitionName ?? spec.definitionId;
  const hash = run.definitionHash ?? spec.definitionHash;
  if (!name && !spec.definitionPath && !spec.objective && !hash) return null;

  return (
    <details
      data-testid="loop-run-definition"
      open={open}
      style={{ marginTop: 8, padding: 7, background: "#11111b", borderRadius: 4 }}
    >
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
        style={{ color: "#89b4fa", cursor: "pointer", userSelect: "none" }}
      >
        Definition{name ? `: ${name}` : ""}
      </summary>
      {open && (
        <div style={{ marginTop: 6 }}>
          {spec.objective && <div style={{ color: "#bac2de" }}>{spec.objective}</div>}
          {spec.definitionPath && (
            <div
              style={{ color: "#a6adc8", fontFamily: "monospace", overflowWrap: "anywhere" }}
            >
              {spec.definitionPath}
            </div>
          )}
          {hash && (
            <div
              style={{ color: "#6c7086", fontFamily: "monospace", overflowWrap: "anywhere" }}
            >
              Pinned hash: {hash}
            </div>
          )}
        </div>
      )}
    </details>
  );
}

function HumanApprovalPanel({
  approval,
  task,
  maxTaskIterations,
  busy,
  onDecision,
}: {
  approval: LoopApprovalRecord;
  task: LoopTask;
  maxTaskIterations: number;
  busy: boolean;
  onDecision: (decision: LoopApprovalDecision, feedback?: string) => void;
}) {
  const [feedback, setFeedback] = useState("");
  const trimmed = feedback.trim();
  const revisionAvailable = task.revisionCount + 1 < maxTaskIterations;

  return (
    <section data-testid="loop-human-approval" style={sectionStyle}>
      <h2 style={{ ...headingStyle, color: "#cba6f7" }}>Awaiting human approval</h2>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <HandRaisedIcon aria-hidden="true" style={iconStyle} />
        <strong>{approval.prompt}</strong>
      </div>
      <textarea
        aria-label="Human review feedback"
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
        placeholder="Feedback (required when requesting a revision)"
        rows={3}
        style={{
          width: "100%",
          boxSizing: "border-box",
          marginTop: 9,
          resize: "vertical",
          border: "1px solid #45475a",
          borderRadius: 4,
          padding: 7,
          background: "#11111b",
          color: "#cdd6f4",
          font: "inherit",
        }}
      />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
        <ActionButton
          testId="loop-approval-approve"
          label="Approve"
          icon={CheckIcon}
          disabled={busy}
          onClick={() => onDecision("approve")}
        />
        <ActionButton
          testId="loop-approval-revise"
          label="Request revision"
          icon={ArrowUturnLeftIcon}
          disabled={busy || !revisionAvailable || !trimmed}
          onClick={() => onDecision("revise", trimmed)}
        />
        <ActionButton
          testId="loop-approval-reject"
          label="Reject / stop"
          icon={XCircleIcon}
          disabled={busy}
          onClick={() => onDecision("reject", trimmed || undefined)}
        />
      </div>
      {!revisionAvailable && (
        <div style={{ color: "#f9e2af", marginTop: 6 }}>
          The configured task attempt budget is exhausted.
        </div>
      )}
    </section>
  );
}

function RunPanel({
  snapshot,
  now,
  busy,
  onControl,
  onResume,
  onApproval,
}: {
  snapshot: PersistedLoopSnapshot;
  now: number;
  busy: boolean;
  onControl: (action: "pause" | "stop" | "kill") => void;
  onResume: () => void;
  onApproval: (decision: LoopApprovalDecision, feedback?: string) => void;
}) {
  const run = snapshot.latestRun;
  const spec = snapshot.spec;
  if (!run || !spec) {
    return (
      <section data-testid="loop-no-run" style={sectionStyle}>
        <h2 style={headingStyle}>Run</h2>
        <div style={{ color: "#6c7086" }}>No runs yet.</div>
      </section>
    );
  }

  const currentTask =
    snapshot.tasks.find((candidate) => candidate.id === run.activeTaskId) ?? null;
  const timing = summarizeRunTiming({
    run,
    stages: snapshot.stages,
    now,
  });
  const elapsed = run.startedAt ? formatDuration(timing.elapsedMs) : "Not available";
  const canControl = !TERMINAL_RUN_STATES.has(run.state);
  const hasActionableTask = snapshot.tasks.some(
    (task) => task.state === "attention" || task.state === "blocked",
  );
  const pendingApproval =
    snapshot.approvals.find(
      (approval) =>
        approval.loopTaskId === run.activeTaskId && approval.status === "pending",
    ) ?? null;

  return (
    <>
      <section style={sectionStyle}>
        <div
          data-testid="loop-run-state"
          style={{ fontSize: 20, fontWeight: 700, color: "#89b4fa", marginBottom: 8 }}
        >
          {stateLabel(run.state)}
        </div>
        <div data-testid="loop-elapsed">Elapsed: {elapsed}</div>
        <div data-testid="loop-next-evidence">Next evidence: {nextEvidence(run, spec)}</div>
        {timing.roles.length > 0 && (
          <div data-testid="loop-time-breakdown" style={{ marginTop: 6 }}>
            <div style={{ color: "#a6adc8" }}>
              Agent time: {formatDuration(timing.measuredMs)}
            </div>
            <div style={{ color: "#bac2de" }}>
              {timing.roles
                .map(
                  (role) =>
                    `${role.role} ${formatDuration(role.totalMs)} (${role.count})`,
                )
                .join(" · ")}
            </div>
            {timing.slowest && (
              <div data-testid="loop-slowest-stage" style={{ color: "#6c7086" }}>
                Slowest: {timing.slowest.role} #{timing.slowest.attempt} —{" "}
                {formatDuration(timing.slowest.durationMs)}
              </div>
            )}
          </div>
        )}
        {run.error && !hasActionableTask && (
          <div style={{ color: "#f38ba8" }}>{run.error}</div>
        )}
        <RunDefinition run={run} spec={spec} />
        {(currentTask || run.state !== "attention") && (
          <div
            data-testid="loop-current-task"
            style={{ marginTop: 8, padding: 7, background: "#11111b", borderRadius: 4 }}
          >
            <strong>Current task</strong>
            <div>{currentTask ? currentTask.title : "No active task"}</div>
            {currentTask && (
              <CurrentTaskDetail
                task={currentTask}
                timing={summarizeTaskTiming(snapshot.stages, currentTask.id)}
              />
            )}
          </div>
        )}
        {run.deadlineAt && (
          <div style={{ color: "#6c7086", marginTop: 6 }}>Deadline: {run.deadlineAt}</div>
        )}

        {canControl && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
            {run.state === "paused" ? (
              <ActionButton
                testId="loop-resume"
                label="Resume"
                icon={PlayIcon}
                disabled={busy}
                onClick={onResume}
              />
            ) : (
              run.state !== "stopping" &&
              run.state !== "awaiting_approval" && (
                <ActionButton
                  testId="loop-pause"
                  label="Pause"
                  icon={PauseIcon}
                  disabled={busy}
                  onClick={() => onControl("pause")}
                />
              )
            )}
            {run.state !== "stopping" && (
              <ActionButton
                testId="loop-stop"
                label="Stop"
                icon={StopIcon}
                disabled={busy}
                onClick={() => onControl("stop")}
              />
            )}
            <ActionButton
              testId="loop-kill"
              label="Kill"
              icon={XCircleIcon}
              disabled={busy}
              onClick={() => onControl("kill")}
            />
          </div>
        )}
      </section>
      {run.state === "awaiting_approval" && currentTask && pendingApproval && (
        <HumanApprovalPanel
          approval={pendingApproval}
          task={currentTask}
          maxTaskIterations={spec.maxTaskIterations}
          busy={busy}
          onDecision={onApproval}
        />
      )}
      <TaskList
        tasks={snapshot.tasks}
        verifications={snapshot.verifications}
        evaluations={snapshot.evaluations}
        approvals={snapshot.approvals}
        maxTaskIterations={spec.maxTaskIterations}
        stages={snapshot.stages}
      />
      <EventTimeline events={snapshot.events} />
    </>
  );
}

const RUN_FILTER_LABELS: Record<LoopRunFilter, string> = {
  all: "All",
  running: "Running",
  completed: "Completed",
  attention: "Attention",
};

const RUN_STATE_COLORS: Partial<Record<LoopRunState, string>> = {
  completed: "#a6e3a1",
  attention: "#f9e2af",
  killed: "#f38ba8",
  paused: "#cba6f7",
  awaiting_approval: "#cba6f7",
};

function runStateColor(state: LoopRunState): string {
  return RUN_STATE_COLORS[state] ?? "#89b4fa";
}

function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: LoopRunSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const live = !TERMINAL_RUN_STATES.has(run.state);
  return (
    <button
      type="button"
      data-testid={`loop-run-row-${run.id}`}
      aria-pressed={selected}
      onClick={onSelect}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        border: "none",
        borderBottom: "1px solid #222",
        borderLeft: `2px solid ${selected ? "#89b4fa" : "transparent"}`,
        background: selected ? "#313244" : "transparent",
        color: "#cdd6f4",
        padding: "6px 8px",
        cursor: "pointer",
        font: "inherit",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
        {live && (
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: runStateColor(run.state),
              flexShrink: 0,
            }}
          />
        )}
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {run.definitionName ?? run.definitionId ?? "Loop run"}
        </span>
      </span>
      <span
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 6,
          marginTop: 2,
          fontSize: 11,
        }}
      >
        <span style={{ color: runStateColor(run.state) }}>
          {stateLabel(run.state)}
        </span>
        <span style={{ color: "#6c7086" }}>{describeRun(run)}</span>
      </span>
    </button>
  );
}

/**
 * Loops tab: every run on the left, the selected run's evidence on the right.
 *
 * The list is filterable rather than showing only the newest run, so a finished
 * run stays readable and several concurrent runs would each be reachable once
 * the runtime allows them.
 */
function RunsPanel({
  runs,
  selectedRunId,
  filter,
  snapshot,
  now,
  busy,
  loadingSnapshot,
  onFilter,
  onSelect,
  onControl,
  onResume,
  onApproval,
}: {
  runs: LoopRunSummary[];
  selectedRunId: string | null;
  filter: LoopRunFilter;
  snapshot: PersistedLoopSnapshot;
  now: number;
  busy: boolean;
  loadingSnapshot: boolean;
  onFilter: (filter: LoopRunFilter) => void;
  onSelect: (runId: string) => void;
  onControl: (action: "pause" | "stop" | "kill") => void;
  onResume: () => void;
  onApproval: (decision: LoopApprovalDecision, feedback?: string) => void;
}) {
  const counts = countRunsByFilter(runs);
  const visible = orderRuns(runs.filter((run) => matchesRunFilter(run, filter)));

  return (
    <div
      data-testid="loop-runs-tab"
      style={{ flex: 1, minHeight: 0, display: "flex" }}
    >
      <div style={sidePanelStyle}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 3,
            padding: "5px 6px",
            borderBottom: "1px solid #313244",
          }}
        >
          {LOOP_RUN_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              data-testid={`loop-run-filter-${option}`}
              aria-pressed={filter === option}
              onClick={() => onFilter(option)}
              style={{
                background: filter === option ? "#313244" : "transparent",
                border: "none",
                borderRadius: 3,
                color: filter === option ? "#89b4fa" : "#a6adc8",
                padding: "3px 7px",
                fontSize: 11,
                cursor: "pointer",
                font: "inherit",
              }}
            >
              {RUN_FILTER_LABELS[option]} ({counts[option]})
            </button>
          ))}
        </div>
        <div style={{ flex: 1, overflowY: "auto" }} data-testid="loop-run-list">
          {visible.length === 0 ? (
            <div
              data-testid="loop-run-list-empty"
              style={{ padding: 10, color: "#6c7086" }}
            >
              {runs.length === 0
                ? "No loops have run yet. Start one from the Definitions tab."
                : "No runs match this filter."}
            </div>
          ) : (
            visible.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                selected={run.id === selectedRunId}
                onSelect={() => onSelect(run.id)}
              />
            ))
          )}
        </div>
      </div>

      <div style={{ ...scrollStyle, minWidth: 0 }} data-testid="loop-run-detail">
        {selectedRunId === null ? (
          <div style={{ color: "#6c7086" }}>Select a run on the left.</div>
        ) : loadingSnapshot ? (
          <div data-testid="loop-run-detail-loading">Loading run evidence...</div>
        ) : (
          <RunPanel
            snapshot={snapshot}
            now={now}
            busy={busy}
            onControl={onControl}
            onResume={onResume}
            onApproval={onApproval}
          />
        )}
      </div>
    </div>
  );
}
const TABS = [
  { id: "definitions" as const, label: "Definitions", icon: DocumentTextIcon },
  { id: "loops" as const, label: "Loops", icon: ArrowPathRoundedSquareIcon },
];

type LoopTabId = (typeof TABS)[number]["id"];

export default function LoopControlTile({
  tileId,
  workstreamId,
  workstreamDir: _workstreamDir,
  isFocused = false,
}: LoopControlTileProps) {
  const backend = useBackend();
  const [snapshot, setSnapshot] = useState<PersistedLoopSnapshot>(EMPTY_SNAPSHOT);
  const [catalog, setCatalog] = useState<LoopDefinitionCatalog>(EMPTY_CATALOG);
  const catalogRef = useRef<LoopDefinitionCatalog>(EMPTY_CATALOG);
  const [activeTab, setActiveTab] = useState<LoopTabId>("definitions");
  const [runs, setRuns] = useState<LoopRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const selectedRunIdRef = useRef<string | null>(null);
  const [runFilter, setRunFilter] = useState<LoopRunFilter>("all");
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const editorPathRef = useRef<string | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);
  const [editorSnapshot, setEditorSnapshot] = useState<BufferSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const progressVersionRef = useRef("");

  const selectRun = useCallback((runId: string | null) => {
    selectedRunIdRef.current = runId;
    setSelectedRunId(runId);
  }, []);

  const applyCatalog = useCallback((loaded: LoopDefinitionCatalog) => {
    catalogRef.current = loaded;
    setCatalog(loaded);
    const paths = [
      ...loaded.definitions.map((definition) => definition.path),
      ...loaded.invalid.map((definition) => definition.path),
    ];
    const retainedPath =
      editorPathRef.current && paths.includes(editorPathRef.current)
        ? editorPathRef.current
        : paths[0] ?? null;
    editorPathRef.current = retainedPath;
    setEditorPath(retainedPath);
  }, []);

  /**
   * Loads the run list and keeps a valid selection.
   *
   * Defaults to the newest run so opening the tab shows current work, but never
   * moves a selection the operator made themselves.
   */
  const loadRuns = useCallback(async (): Promise<LoopRunSummary[]> => {
    const loaded = await backend.listWorkstreamLoopRuns(workstreamId);
    setRuns(loaded);
    const ordered = orderRuns(loaded);
    const current = selectedRunIdRef.current;
    if (!current || !loaded.some((run) => run.id === current)) {
      selectRun(ordered[0]?.id ?? null);
    }
    return loaded;
  }, [backend, selectRun, workstreamId]);

  const loadRunSnapshot = useCallback(
    async (runId: string | null) => {
      if (!runId) {
        setSnapshot(EMPTY_SNAPSHOT);
        return;
      }
      const loaded = await backend.getLoopRunSnapshot(runId);
      setSnapshot(loaded);
      setNow(Date.now());
    },
    [backend],
  );

  const loadProgress = useCallback(async () => {
    try {
      await loadRuns();
      await loadRunSnapshot(selectedRunIdRef.current);
      setError(null);
    } catch (cause) {
      setError(message(cause));
    }
  }, [loadRunSnapshot, loadRuns]);

  const refreshAll = useCallback(
    async (saveEditor = false): Promise<boolean> => {
      setRefreshing(true);
      try {
        if (saveEditor) {
          const loopPaths = new Set([
            ...catalogRef.current.definitions.map((definition) => definition.path),
            ...catalogRef.current.invalid.map((definition) => definition.path),
          ]);
          const dirtyDefinitions = fileBufferRegistry
            .listAll()
            .filter((buffer) => buffer.dirty && loopPaths.has(buffer.path));
          for (const buffer of dirtyDefinitions) {
            let current = fileBufferRegistry.getSnapshot(buffer.path);
            while (current?.dirty) {
              if (current.state !== "dirty" && current.state !== "deleted") {
                throw new Error(
                  current.lastError ?? `Save ${buffer.path} before continuing`,
                );
              }
              await fileBufferRegistry.save(buffer.path);
              current = fileBufferRegistry.getSnapshot(buffer.path);
            }
          }
        }
        const [, loadedCatalog] = await Promise.all([
          loadRuns(),
          backend.listLoopDefinitions(workstreamId),
        ]);
        applyCatalog(loadedCatalog);
        await loadRunSnapshot(selectedRunIdRef.current);
        setNow(Date.now());
        setError(null);
        return true;
      } catch (cause) {
        setError(message(cause));
        return false;
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [applyCatalog, backend, loadRunSnapshot, loadRuns, workstreamId],
  );

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void refreshAll(), 0);

    const onMemoryUpdate = (event: Event) => {
      if (
        event instanceof CustomEvent &&
        event.detail?.workstreamId === workstreamId
      ) {
        void loadProgress();
      }
    };
    window.addEventListener("memory-loop-updated", onMemoryUpdate);

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ workstreamId?: string }>("loop-updated", (event) => {
      if (!event.payload?.workstreamId || event.payload.workstreamId === workstreamId) {
        void loadProgress();
      }
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // Browser tests and the Vite host have no Tauri event bridge.
      });

    return () => {
      disposed = true;
      window.clearTimeout(initialLoad);
      window.removeEventListener("memory-loop-updated", onMemoryUpdate);
      unlisten?.();
    };
  }, [loadProgress, refreshAll, workstreamId]);

  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;
  /** Any in-flight run blocks a new one: the runtime allows one at a time. */
  const runIsActive = runs.some((run) => !TERMINAL_RUN_STATES.has(run.state));
  const selectedRunIsActive =
    selectedRun !== null && !TERMINAL_RUN_STATES.has(selectedRun.state);

  useEffect(() => {
    progressVersionRef.current = "";
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRunIsActive) return;
    const interval = window.setInterval(() => {
      setNow(Date.now());
      void backend
        .getWorkstreamLoopProgressVersion(workstreamId)
        .then((version) => {
          if (version !== progressVersionRef.current) {
            progressVersionRef.current = version;
            void loadProgress();
          }
        })
        .catch((cause) => setError(message(cause)));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [backend, loadProgress, selectedRunIsActive, workstreamId]);

  const perform = useCallback(
    async (operation: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await operation();
        await loadProgress();
      } catch (cause) {
        setError(message(cause));
      } finally {
        setBusy(false);
      }
    },
    [busy, loadProgress],
  );

  const selectedDefinition = useMemo(
    () =>
      catalog.definitions.find(
        (definition) => definition.path === editorPath,
      ) ?? null,
    [catalog.definitions, editorPath],
  );

  /**
   * Runs the definition currently open in the editor, then shows the run it
   * created. Saving and reparsing first means the run pins the YAML on screen
   * rather than the last-loaded copy.
   */
  const runSelected = async () => {
    if (!selectedDefinition) return;
    if (!(await refreshAll(true))) return;
    const refreshedDefinition = catalogRef.current.definitions.find(
      (definition) => definition.path === selectedDefinition.path,
    );
    if (!refreshedDefinition) {
      setError("The selected loop definition is no longer valid");
      return;
    }
    const before = new Set(runs.map((run) => run.id));
    void perform(async () => {
      const started = await backend.runLoopDefinitionNow(
        workstreamId,
        refreshedDefinition.path,
      );
      const startedId = started?.id ?? null;
      if (startedId) selectRun(startedId);
      else {
        const latest = orderRuns(await backend.listWorkstreamLoopRuns(workstreamId));
        const fresh = latest.find((run) => !before.has(run.id)) ?? latest[0];
        if (fresh) selectRun(fresh.id);
      }
      setActiveTab("loops");
    });
  };

  const selectEditorPath = (path: string) => {
    editorPathRef.current = path;
    setEditorPath(path);
  };

  const refreshCatalogAndEditor = async () => {
    const refreshed = await refreshAll(true);
    if (refreshed && activeTab === "definitions") {
      setEditorRevision((revision) => revision + 1);
    }
  };

  const handleEditorSnapshotChange = useCallback(
    (snapshot: BufferSnapshot | null) => {
      setEditorSnapshot(snapshot);
    },
    [],
  );

  const openRun = useCallback(
    (runId: string) => {
      selectRun(runId);
      setLoadingSnapshot(true);
      void loadRunSnapshot(runId)
        .catch((cause) => setError(message(cause)))
        .finally(() => setLoadingSnapshot(false));
    },
    [loadRunSnapshot, selectRun],
  );

  const control = (action: "pause" | "stop" | "kill") => {
    if (!selectedRunId) return;
    void perform(() => backend.controlWorkstreamLoop(selectedRunId, action));
  };

  const resume = () => {
    if (!selectedRunId) return;
    void perform(async () => {
      await backend.resumeWorkstreamLoop(selectedRunId);
    });
  };

  const decideApproval = (
    decision: LoopApprovalDecision,
    feedback?: string,
  ) => {
    if (!selectedRunId) return;
    void perform(async () => {
      await backend.decideLoopHumanApproval(selectedRunId, decision, feedback);
    });
  };

  return (
    <div
      data-testid="loop-control-tile"
      data-tile-id={tileId}
      tabIndex={isFocused ? 0 : -1}
      style={rootStyle}
    >
      <div style={tabBarStyle} data-testid="loop-tabs">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`loop-tab-${id}`}
              data-active={active ? "true" : "false"}
              onClick={() => setActiveTab(id)}
              style={{
                ...tabButtonStyle,
                color: active ? "#cdd6f4" : "#6c7086",
                borderBottom: active
                  ? "2px solid #89b4fa"
                  : "2px solid transparent",
                background: active ? "#1e1e2e" : "transparent",
              }}
            >
              <Icon style={{ width: 12, height: 12 }} />
              {label}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          aria-label="Refresh"
          data-testid="loop-refresh"
          disabled={busy || refreshing}
          onClick={() => void refreshCatalogAndEditor()}
          style={{
            ...tabButtonStyle,
            color: "#a6adc8",
            cursor: busy || refreshing ? "not-allowed" : "pointer",
            opacity: busy || refreshing ? 0.55 : 1,
          }}
        >
          <ArrowPathIcon aria-hidden="true" style={{ width: 12, height: 12 }} />
          Refresh
        </button>
      </div>

      {error && (
        <div
          role="alert"
          data-testid="loop-error"
          style={{
            background: "#45242b",
            border: "1px solid #f38ba8",
            color: "#f5c2e7",
            padding: 8,
            flexShrink: 0,
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div data-testid="loop-loading" style={{ padding: 10 }}>
          Loading loop catalog...
        </div>
      ) : activeTab === "definitions" ? (
        <DefinitionsPanel
          catalog={catalog}
          selectedPath={editorPath}
          editorSnapshot={editorSnapshot}
          editorRevision={editorRevision}
          busy={busy}
          runIsActive={runIsActive}
          onSelect={selectEditorPath}
          onSnapshotChange={handleEditorSnapshotChange}
          onRun={() => void runSelected()}
        />
      ) : (
        <RunsPanel
          runs={runs}
          selectedRunId={selectedRunId}
          filter={runFilter}
          snapshot={snapshot}
          now={now}
          busy={busy}
          loadingSnapshot={loadingSnapshot}
          onFilter={setRunFilter}
          onSelect={openRun}
          onControl={control}
          onResume={resume}
          onApproval={decideApproval}
        />
      )}
    </div>
  );
}
