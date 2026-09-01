import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  CheckIcon,
  CheckBadgeIcon,
  DocumentTextIcon,
  ExclamationTriangleIcon,
  PauseIcon,
  PlayIcon,
  HandRaisedIcon,
  StopIcon,
  TagIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";

import { useBackend } from "../backend/context";
import { MAX_TASK_ITERATIONS } from "../domain/loop";
import { FileEditorView } from "../files/FileEditorView";
import {
  fileBufferRegistry,
  type BufferSnapshot,
} from "../files/FileBufferRegistry";
import type {
  LoopAction,
  LoopApprovalDecision,
  LoopApprovalRecord,
  LoopDefinition,
  LoopDefinitionCatalog,
  LoopEvaluationRecord,
  LoopEventRecord,
  LoopRun,
  LoopRunState,
  LoopSpec,
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
const tabStyle: React.CSSProperties = {
  border: "none",
  borderBottom: "2px solid transparent",
  padding: "8px 10px 6px",
  background: "transparent",
  color: "#a6adc8",
  cursor: "pointer",
  font: "inherit",
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
  definition,
  selected,
  onSelect,
}: {
  definition: LoopDefinition;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`loop-definition-${definition.id}`}
      aria-pressed={selected}
      onClick={onSelect}
      style={{
        width: "100%",
        boxSizing: "border-box",
        display: "grid",
        gap: 5,
        marginBottom: 7,
        padding: 9,
        border: `1px solid ${selected ? "#89b4fa" : "#313244"}`,
        borderRadius: 5,
        background: selected ? "#243047" : "#11111b",
        color: "#cdd6f4",
        cursor: "pointer",
        font: "inherit",
        textAlign: "left",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <DocumentTextIcon aria-hidden="true" style={iconStyle} />
        <strong>{definition.name}</strong>
      </span>
      <span style={{ color: "#bac2de" }}>{definition.objective}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
        <CheckBadgeIcon aria-hidden="true" style={iconStyle} />
        <span>{feedbackMode(definition)}</span>
        {definition.tags.map((tag) => (
          <span
            key={tag}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              border: "1px solid #45475a",
              borderRadius: 999,
              padding: "1px 6px",
              color: "#a6adc8",
            }}
          >
            <TagIcon aria-hidden="true" style={{ width: 11, height: 11 }} />
            {tag}
          </span>
        ))}
      </span>
      {!definition.portable && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            color: "#f9e2af",
          }}
        >
          <ExclamationTriangleIcon aria-hidden="true" style={iconStyle} />
          Not portable: this definition uses machine-specific configuration.
        </span>
      )}
    </button>
  );
}

function CatalogPanel({
  catalog,
  selected,
  busy,
  runIsActive,
  onSelect,
  onRun,
}: {
  catalog: LoopDefinitionCatalog;
  selected: LoopDefinition | null;
  busy: boolean;
  runIsActive: boolean;
  onSelect: (definitionId: string) => void;
  onRun: () => void;
}) {
  return (
    <>
      <section style={sectionStyle}>
        <h2 style={headingStyle}>Definitions</h2>
        {catalog.definitions.length === 0 ? (
          <div
            data-testid="loop-definition-empty"
            style={{ color: "#a6adc8", lineHeight: 1.5 }}
          >
            Create <code>.workstreams/loops/&lt;id&gt;.loop.yaml</code> in this
            workstream, or use the <code>create-loop</code> skill to author one.
            YAML files are the only loop authoring surface.
          </div>
        ) : (
          catalog.definitions.map((definition) => (
            <DefinitionRow
              key={definition.id}
              definition={definition}
              selected={definition.id === selected?.id}
              onSelect={() => onSelect(definition.id)}
            />
          ))
        )}
      </section>

      {selected && (
        <section data-testid="loop-definition-selected" style={sectionStyle}>
          <h2 style={headingStyle}>Selected definition</h2>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{selected.name}</div>
          <div style={{ color: "#bac2de", marginTop: 5 }}>{selected.objective}</div>
          <div style={{ color: "#a6adc8", marginTop: 7, whiteSpace: "pre-wrap" }}>
            {selected.description ?? "No description provided."}
          </div>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "55px minmax(0, 1fr)",
              gap: "5px 8px",
              margin: "9px 0 0",
            }}
          >
            <dt style={{ color: "#6c7086" }}>Path</dt>
            <dd style={{ margin: 0, fontFamily: "monospace", overflowWrap: "anywhere" }}>
              {selected.path}
            </dd>
            <dt style={{ color: "#6c7086" }}>Hash</dt>
            <dd style={{ margin: 0, fontFamily: "monospace", overflowWrap: "anywhere" }}>
              {selected.hash}
            </dd>
          </dl>
          <div style={{ marginTop: 10 }}>
            <ActionButton
              testId="loop-run-selected"
              label="Run"
              icon={PlayIcon}
              disabled={busy || runIsActive}
              onClick={onRun}
            />
          </div>
        </section>
      )}

      {catalog.invalid.length > 0 && (
        <section data-testid="loop-invalid-definitions" style={sectionStyle}>
          <h2 style={{ ...headingStyle, color: "#f38ba8" }}>Invalid definitions</h2>
          {catalog.invalid.map((invalid) => (
            <div
              key={`${invalid.path}:${invalid.error}`}
              style={{
                marginTop: 7,
                padding: 8,
                borderLeft: "2px solid #f38ba8",
                background: "#24171d",
              }}
            >
              <div style={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>
                {invalid.path}
              </div>
              <div style={{ color: "#f5c2e7", marginTop: 3 }}>{invalid.error}</div>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function DefinitionsEditorPanel({
  catalog,
  selectedPath,
  editorSnapshot,
  editorRevision,
  onSelect,
  onSnapshotChange,
}: {
  catalog: LoopDefinitionCatalog;
  selectedPath: string | null;
  editorSnapshot: BufferSnapshot | null;
  editorRevision: number;
  onSelect: (path: string) => void;
  onSnapshotChange: (snapshot: BufferSnapshot | null) => void;
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

  return (
    <div
      data-testid="loop-definitions-tab"
      style={{
        height: "100%",
        minHeight: 0,
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
      }}
    >
      <div
        style={{
          padding: 8,
          borderBottom: "1px solid #313244",
          display: "flex",
          gap: 6,
          overflowX: "auto",
        }}
      >
        {catalog.definitions.map((definition) => (
          <button
            key={definition.path}
            type="button"
            data-testid={`loop-edit-definition-${definition.id}`}
            aria-pressed={definition.path === selectedPath}
            onClick={() => onSelect(definition.path)}
            style={{
              ...buttonStyle,
              flexShrink: 0,
              borderColor:
                definition.path === selectedPath ? "#89b4fa" : "#45475a",
            }}
          >
            <DocumentTextIcon aria-hidden="true" style={iconStyle} />
            {definition.name}
          </button>
        ))}
        {catalog.invalid.map((definition, index) => (
          <button
            key={definition.path}
            type="button"
            data-testid={`loop-edit-invalid-${index}`}
            aria-pressed={definition.path === selectedPath}
            onClick={() => onSelect(definition.path)}
            style={{
              ...buttonStyle,
              flexShrink: 0,
              color: "#f5c2e7",
              borderColor:
                definition.path === selectedPath ? "#f38ba8" : "#45475a",
            }}
          >
            <ExclamationTriangleIcon aria-hidden="true" style={iconStyle} />
            {definition.path.split(/[\\/]/).pop()}
          </button>
        ))}
        {catalog.definitions.length === 0 && catalog.invalid.length === 0 && (
          <span style={{ color: "#a6adc8", padding: "5px 2px" }}>
            No loop definitions found in <code>.workstreams/loops</code>.
          </span>
        )}
      </div>

      {selectedPath ? (
        <div
          style={{
            minHeight: 0,
            display: "grid",
            gridTemplateRows: "auto minmax(0, 1fr)",
          }}
        >
          <div
            data-testid="loop-definition-editor-header"
            style={{
              padding: "6px 10px",
              borderBottom: "1px solid #313244",
              background: "#181825",
            }}
          >
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <strong>
                {selectedName}
                {editorSnapshot?.dirty ? "*" : ""}
              </strong>
              {editorSnapshot?.dirty && (
                <span style={{ color: "#f9e2af" }}>Unsaved</span>
              )}
            </div>
            <div
              style={{
                color: "#6c7086",
                fontFamily: "monospace",
                overflowWrap: "anywhere",
              }}
            >
              {selectedPath}
            </div>
            {selectedInvalid && (
              <div style={{ color: "#f38ba8", marginTop: 3 }}>
                {selectedInvalid.error}
              </div>
            )}
          </div>
          <div style={{ minHeight: 0 }}>
            <FileEditorView
              key={`${selectedPath}:${editorRevision}`}
              path={selectedPath}
              onBack={() => {}}
              showHeader={false}
              onSnapshotChange={onSnapshotChange}
            />
          </div>
        </div>
      ) : (
        <div style={{ padding: 12, color: "#6c7086" }}>
          Create a YAML definition with the <code>create-loop</code> skill,
          then refresh the catalog.
        </div>
      )}
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

function TaskList({
  tasks,
  verifications,
  evaluations,
  approvals,
}: {
  tasks: LoopTask[];
  verifications: LoopVerificationRecord[];
  evaluations: LoopEvaluationRecord[];
  approvals: LoopApprovalRecord[];
}) {
  return (
    <section data-testid="loop-task-list" style={sectionStyle}>
      <h2 style={headingStyle}>Tasks</h2>
      {tasks.length === 0 ? (
        <div style={{ color: "#6c7086" }}>No tasks have been proposed.</div>
      ) : (
        tasks.map((task) => (
          <article
            key={task.id}
            data-testid={`loop-task-${task.id}`}
            style={{
              background: "#11111b",
              borderRadius: 4,
              padding: 8,
              marginBottom: 8,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <strong>{task.title}</strong>
              <span style={{ color: "#89b4fa" }}>{task.state}</span>
            </div>
            <div style={{ color: "#a6adc8", marginTop: 3 }}>{task.objective}</div>
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
                <div>{task.workerResult}</div>
              </div>
            )}
            {task.error && <div style={{ color: "#f38ba8", marginTop: 6 }}>{task.error}</div>}
            {verifications
              .filter((record) => record.loopTaskId === task.id)
              .map((record) => (
                <VerificationEvidence key={record.id} record={record} />
              ))}
            {evaluations
              .filter((record) => record.loopTaskId === task.id)
              .map((record) => (
                <EvaluationEvidence key={record.id} record={record} />
              ))}
            {approvals
              .filter((record) => record.loopTaskId === task.id)
              .map((record) => (
                <ApprovalEvidence key={record.id} record={record} />
              ))}
          </article>
        ))
      )}
    </section>
  );
}

function EventTimeline({ events }: { events: LoopEventRecord[] }) {
  return (
    <section data-testid="loop-event-timeline" style={sectionStyle}>
      <h2 style={headingStyle}>Event timeline</h2>
      {events.length === 0 ? (
        <div style={{ color: "#6c7086" }}>No loop events yet.</div>
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
      )}
    </section>
  );
}

function RunDefinition({ run, spec }: { run: LoopRun; spec: LoopSpec }) {
  const name = spec.definitionName ?? spec.definitionId;
  const hash = run.definitionHash ?? spec.definitionHash;
  if (!name && !spec.definitionPath && !spec.objective && !hash) return null;

  return (
    <div
      data-testid="loop-run-definition"
      style={{ marginTop: 8, padding: 7, background: "#11111b", borderRadius: 4 }}
    >
      <strong>Latest run definition</strong>
      {name && <div>{name}</div>}
      {spec.objective && <div style={{ color: "#bac2de" }}>{spec.objective}</div>}
      {spec.definitionPath && (
        <div style={{ color: "#a6adc8", fontFamily: "monospace", overflowWrap: "anywhere" }}>
          {spec.definitionPath}
        </div>
      )}
      {hash && (
        <div style={{ color: "#6c7086", fontFamily: "monospace", overflowWrap: "anywhere" }}>
          Pinned hash: {hash}
        </div>
      )}
    </div>
  );
}

function HumanApprovalPanel({
  approval,
  task,
  busy,
  onDecision,
}: {
  approval: LoopApprovalRecord;
  task: LoopTask;
  busy: boolean;
  onDecision: (decision: LoopApprovalDecision, feedback?: string) => void;
}) {
  const [feedback, setFeedback] = useState("");
  const trimmed = feedback.trim();
  const revisionAvailable = task.revisionCount + 1 < MAX_TASK_ITERATIONS;

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
          The single revision has already been used.
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
  const elapsed = run.startedAt
    ? formatDuration(
        (run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.startedAt),
      )
    : "Not available";
  const canControl = !TERMINAL_RUN_STATES.has(run.state);
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
        {run.deadlineAt && <div style={{ color: "#6c7086" }}>Deadline: {run.deadlineAt}</div>}
        {run.error && <div style={{ color: "#f38ba8" }}>{run.error}</div>}
        <RunDefinition run={run} spec={spec} />
        <div
          data-testid="loop-current-task"
          style={{ marginTop: 8, padding: 7, background: "#11111b", borderRadius: 4 }}
        >
          <strong>Current task</strong>
          <div>{currentTask ? currentTask.title : "No active task"}</div>
          {currentTask && <div style={{ color: "#a6adc8" }}>{currentTask.objective}</div>}
        </div>

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
          busy={busy}
          onDecision={onApproval}
        />
      )}
      <TaskList
        tasks={snapshot.tasks}
        verifications={snapshot.verifications}
        evaluations={snapshot.evaluations}
        approvals={snapshot.approvals}
      />
      <EventTimeline events={snapshot.events} />
    </>
  );
}

export default function LoopControlTile({
  tileId,
  workstreamId,
  workstreamDir,
  isFocused = false,
}: LoopControlTileProps) {
  const backend = useBackend();
  const [snapshot, setSnapshot] = useState<PersistedLoopSnapshot>(EMPTY_SNAPSHOT);
  const [catalog, setCatalog] = useState<LoopDefinitionCatalog>(EMPTY_CATALOG);
  const catalogRef = useRef<LoopDefinitionCatalog>(EMPTY_CATALOG);
  const [activeTab, setActiveTab] = useState<"run" | "definitions">("run");
  const [selectedDefinitionId, setSelectedDefinitionId] = useState<string | null>(
    null,
  );
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
    setSelectedDefinitionId((current) => {
      const selectedByPath = loaded.definitions.find(
        (definition) => definition.path === retainedPath,
      );
      if (selectedByPath) return selectedByPath.id;
      if (current && loaded.definitions.some((definition) => definition.id === current)) {
        return current;
      }
      return loaded.definitions[0]?.id ?? null;
    });
  }, []);

  const loadSnapshot = useCallback(async () => {
    try {
      const loaded = await backend.getWorkstreamLoopSnapshot(workstreamId);
      setSnapshot(loaded);
      setNow(Date.now());
      setError(null);
    } catch (cause) {
      setError(message(cause));
    }
  }, [backend, workstreamId]);

  const refreshAll = useCallback(async (saveEditor = false): Promise<boolean> => {
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
      const [loadedSnapshot, loadedCatalog] = await Promise.all([
        backend.getWorkstreamLoopSnapshot(workstreamId),
        backend.listLoopDefinitions(workstreamDir),
      ]);
      setSnapshot(loadedSnapshot);
      applyCatalog(loadedCatalog);
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
  }, [applyCatalog, backend, workstreamDir, workstreamId]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void refreshAll(), 0);

    const onMemoryUpdate = (event: Event) => {
      if (
        event instanceof CustomEvent &&
        event.detail?.workstreamId === workstreamId
      ) {
        void loadSnapshot();
      }
    };
    window.addEventListener("memory-loop-updated", onMemoryUpdate);

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ workstreamId?: string }>("loop-updated", (event) => {
      if (!event.payload?.workstreamId || event.payload.workstreamId === workstreamId) {
        void loadSnapshot();
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
  }, [loadSnapshot, refreshAll, workstreamId]);

  const runIsActive =
    snapshot.latestRun !== null &&
    !TERMINAL_RUN_STATES.has(snapshot.latestRun.state);
  const activeRunId = runIsActive ? snapshot.latestRun?.id ?? null : null;

  useEffect(() => {
    progressVersionRef.current = "";
  }, [activeRunId]);

  useEffect(() => {
    if (!runIsActive) return;
    const interval = window.setInterval(() => {
      setNow(Date.now());
      void backend
        .getWorkstreamLoopProgressVersion(workstreamId)
        .then((version) => {
          if (version !== progressVersionRef.current) {
            progressVersionRef.current = version;
            void loadSnapshot();
          }
        })
        .catch((cause) => setError(message(cause)));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [backend, loadSnapshot, runIsActive, workstreamId]);

  const perform = useCallback(
    async (operation: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await operation();
        await loadSnapshot();
      } catch (cause) {
        setError(message(cause));
      } finally {
        setBusy(false);
      }
    },
    [busy, loadSnapshot],
  );

  const selectedDefinition = useMemo(
    () =>
      catalog.definitions.find(
        (definition) => definition.id === selectedDefinitionId,
      ) ??
      catalog.definitions[0] ??
      null,
    [catalog.definitions, selectedDefinitionId],
  );

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
    void perform(async () => {
      await backend.runLoopDefinitionNow(workstreamId, refreshedDefinition.path);
    });
  };

  const selectRunDefinition = (definitionId: string) => {
    setSelectedDefinitionId(definitionId);
    const definition = catalog.definitions.find(
      (candidate) => candidate.id === definitionId,
    );
    if (definition) {
      editorPathRef.current = definition.path;
      setEditorPath(definition.path);
    }
  };

  const selectEditorPath = (path: string) => {
    editorPathRef.current = path;
    setEditorPath(path);
    const definition = catalog.definitions.find(
      (candidate) => candidate.path === path,
    );
    if (definition) setSelectedDefinitionId(definition.id);
  };

  const refreshCatalogAndEditor = async () => {
    const refreshed = await refreshAll(true);
    if (refreshed && activeTab === "definitions") {
      setEditorRevision((revision) => revision + 1);
    }
  };

  const showRunTab = async () => {
    if (activeTab === "run") return;
    if (await refreshAll(true)) {
      setActiveTab("run");
    }
  };

  const handleEditorSnapshotChange = useCallback(
    (snapshot: BufferSnapshot | null) => {
      setEditorSnapshot(snapshot);
    },
    [],
  );

  const control = (action: "pause" | "stop" | "kill") => {
    const currentRun = snapshot.latestRun;
    if (!currentRun) return;
    void perform(() => backend.controlWorkstreamLoop(currentRun.id, action));
  };

  const resume = () => {
    const currentRun = snapshot.latestRun;
    if (!currentRun) return;
    void perform(async () => {
      await backend.resumeWorkstreamLoop(currentRun.id);
    });
  };

  const decideApproval = (
    decision: LoopApprovalDecision,
    feedback?: string,
  ) => {
    const currentRun = snapshot.latestRun;
    if (!currentRun) return;
    void perform(async () => {
      await backend.decideLoopHumanApproval(currentRun.id, decision, feedback);
    });
  };

  const stateAction: LoopAction | null = snapshot.latestRun?.pendingAction ?? null;
  const statusHint = useMemo(
    () => (stateAction ? `Pending action: ${stateAction.type}` : null),
    [stateAction],
  );

  return (
    <div
      data-testid="loop-control-tile"
      data-tile-id={tileId}
      tabIndex={isFocused ? 0 : -1}
      style={rootStyle}
    >
      <header
        data-testid="loop-catalog"
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 10px",
          borderBottom: "1px solid #313244",
          flexShrink: 0,
        }}
      >
        <strong style={{ marginRight: 10 }}>Goal Loop</strong>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "run"}
          data-testid="loop-tab-run"
          onClick={() => void showRunTab()}
          style={{
            ...tabStyle,
            color: activeTab === "run" ? "#cdd6f4" : "#a6adc8",
            borderBottomColor: activeTab === "run" ? "#89b4fa" : "transparent",
          }}
        >
          Run
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "definitions"}
          data-testid="loop-tab-definitions"
          onClick={() => setActiveTab("definitions")}
          style={{
            ...tabStyle,
            color: activeTab === "definitions" ? "#cdd6f4" : "#a6adc8",
            borderBottomColor:
              activeTab === "definitions" ? "#89b4fa" : "transparent",
          }}
        >
          Definitions
        </button>
        <button
          type="button"
          aria-label="Refresh"
          data-testid="loop-refresh"
          disabled={busy || refreshing}
          onClick={() => void refreshCatalogAndEditor()}
          style={{
            ...buttonStyle,
            marginLeft: "auto",
            cursor: busy || refreshing ? "not-allowed" : "pointer",
            opacity: busy || refreshing ? 0.55 : 1,
          }}
        >
          <ArrowPathIcon aria-hidden="true" style={iconStyle} />
          Refresh
        </button>
      </header>

      <div
        style={
          activeTab === "run"
            ? scrollStyle
            : { flex: 1, minHeight: 0, overflow: "hidden" }
        }
      >
        {error && (
          <div
            role="alert"
            data-testid="loop-error"
            style={{
              background: "#45242b",
              border: "1px solid #f38ba8",
              color: "#f5c2e7",
              borderRadius: 4,
              padding: 8,
              marginBottom: 10,
            }}
          >
            {error}
          </div>
        )}

        {loading ? (
          <div data-testid="loop-loading">Loading loop catalog...</div>
        ) : activeTab === "definitions" ? (
          <DefinitionsEditorPanel
            catalog={catalog}
            selectedPath={editorPath}
            editorSnapshot={editorSnapshot}
            editorRevision={editorRevision}
            onSelect={selectEditorPath}
            onSnapshotChange={handleEditorSnapshotChange}
          />
        ) : (
          <>
            {snapshot.latestRun && (
              <RunPanel
                snapshot={snapshot}
                now={now}
                busy={busy}
                onControl={control}
                onResume={resume}
                onApproval={decideApproval}
              />
            )}
            <CatalogPanel
              catalog={catalog}
              selected={selectedDefinition}
              busy={busy}
              runIsActive={runIsActive}
              onSelect={selectRunDefinition}
              onRun={() => void runSelected()}
            />
            {statusHint && (
              <div style={{ color: "#6c7086", marginBottom: 8 }}>{statusHint}</div>
            )}
            {!snapshot.latestRun && (
              <RunPanel
                snapshot={snapshot}
                now={now}
                busy={busy}
                onControl={control}
                onResume={resume}
                onApproval={decideApproval}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
