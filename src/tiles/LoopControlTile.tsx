import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  PauseIcon,
  PlayIcon,
  PowerIcon,
  StopIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";

import { useBackend } from "../backend/context";
import {
  MAX_TASK_ITERATIONS,
  type LoopAction,
  type LoopEvaluationRecord,
  type LoopEventRecord,
  type LoopRun,
  type LoopRunState,
  type LoopSpec,
  type LoopSpecDraft,
  type LoopTask,
  type LoopVerificationRecord,
  type PersistedLoopSnapshot,
} from "../domain/loop";

export interface LoopControlTileProps {
  tileId: string;
  workstreamId: string;
  workstreamDir: string;
  isFocused?: boolean;
}

interface DraftForm {
  orchestratorPrompt: string;
  orchestratorModel: string;
  workerPrompt: string;
  workerModel: string;
  evaluatorPrompt: string;
  evaluatorModel: string;
  timeoutMinutes: string;
  verifierProgram: string;
  verifierArgs: string;
  verifierCwd: string;
}

const EMPTY_SNAPSHOT: PersistedLoopSnapshot = {
  spec: null,
  latestRun: null,
  tasks: [],
  verifications: [],
  evaluations: [],
  events: [],
};

const EMPTY_DRAFT: DraftForm = {
  orchestratorPrompt: "",
  orchestratorModel: "",
  workerPrompt: "",
  workerModel: "",
  evaluatorPrompt: "",
  evaluatorModel: "",
  timeoutMinutes: "30",
  verifierProgram: "",
  verifierArgs: "",
  verifierCwd: "",
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

const fieldStyle: React.CSSProperties = {
  display: "grid",
  gap: 4,
  marginBottom: 8,
  color: "#bac2de",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid #45475a",
  borderRadius: 4,
  padding: "5px 7px",
  background: "#11111b",
  color: "#cdd6f4",
  font: "inherit",
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

const iconStyle: React.CSSProperties = { width: 14, height: 14 };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function draftFromSpec(spec: LoopSpec): DraftForm {
  return {
    orchestratorPrompt: spec.orchestrator.prompt,
    orchestratorModel: spec.orchestrator.model,
    workerPrompt: spec.worker.prompt,
    workerModel: spec.worker.model,
    evaluatorPrompt: spec.evaluator.prompt,
    evaluatorModel: spec.evaluator.model,
    timeoutMinutes: String(spec.runTimeoutMs / 60_000),
    verifierProgram: spec.verifier?.program ?? "",
    verifierArgs: spec.verifier?.args.join("\n") ?? "",
    verifierCwd: spec.verifier?.cwd ?? "",
  };
}

function specDraft(form: DraftForm): LoopSpecDraft | string {
  const orchestratorPrompt = form.orchestratorPrompt.trim();
  const workerPrompt = form.workerPrompt.trim();
  const evaluatorPrompt = form.evaluatorPrompt.trim();
  if (!orchestratorPrompt || !workerPrompt || !evaluatorPrompt) {
    return "All three prompts are required";
  }

  const timeoutMinutes = Number(form.timeoutMinutes);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    return "Run timeout must be greater than zero";
  }

  const verifierProgram = form.verifierProgram.trim();
  const verifierArgs = form.verifierArgs.trim();
  const verifierCwd = form.verifierCwd.trim();
  if (!verifierProgram && (verifierArgs || verifierCwd)) {
    return "Verifier arguments and working directory require a verifier program";
  }

  return {
    orchestrator: {
      prompt: orchestratorPrompt,
      model: form.orchestratorModel.trim(),
    },
    worker: {
      prompt: workerPrompt,
      model: form.workerModel.trim(),
    },
    evaluator: {
      prompt: evaluatorPrompt,
      model: form.evaluatorModel.trim(),
    },
    verifier: verifierProgram
      ? {
          program: verifierProgram,
          args: verifierArgs
            ? verifierArgs
                .split(/\r?\n/)
                .map((argument) => argument.trim())
                .filter(Boolean)
            : [],
          cwd: verifierCwd || undefined,
        }
      : undefined,
    runTimeoutMs: timeoutMinutes * 60_000,
    maxTaskIterations: MAX_TASK_ITERATIONS,
  };
}

function stateLabel(state: LoopRunState): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
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
    case "orchestrating":
      return "Orchestrator task evidence pending";
    case "working":
      return spec.verifier ? "Verifier is next" : "Evaluator is next";
    case "verifying":
      return "Verifier evidence in progress";
    case "evaluating":
      return "Evaluator verdict in progress";
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
      style={{ ...buttonStyle, opacity: disabled ? 0.55 : 1 }}
    >
      <Icon aria-hidden="true" style={iconStyle} />
      {label}
    </button>
  );
}

function SetupForm({
  form,
  setForm,
  existing,
  busy,
  workstreamDir,
  onSave,
  onEnable,
}: {
  form: DraftForm;
  setForm: React.Dispatch<React.SetStateAction<DraftForm>>;
  existing: LoopSpec | null;
  busy: boolean;
  workstreamDir: string;
  onSave: (enableAfterSave: boolean) => void;
  onEnable: () => void;
}) {
  const update = (field: keyof DraftForm, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  return (
    <form
      data-testid="loop-setup-form"
      style={sectionStyle}
      onSubmit={(event) => event.preventDefault()}
    >
      <h2 style={headingStyle}>{existing ? "Loop configuration" : "Set up loop"}</h2>
      {(["Orchestrator", "Worker", "Evaluator"] as const).map((role) => {
        const key = role.toLowerCase() as "orchestrator" | "worker" | "evaluator";
        const promptField = `${key}Prompt` as keyof DraftForm;
        const modelField = `${key}Model` as keyof DraftForm;
        return (
          <div key={role} style={{ marginBottom: 10 }}>
            <label style={fieldStyle}>
              <span>{role} prompt</span>
              <textarea
                aria-label={`${role} prompt`}
                data-testid={`loop-${key}-prompt`}
                rows={3}
                value={form[promptField]}
                onChange={(event) => update(promptField, event.target.value)}
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </label>
            <label style={fieldStyle}>
              <span>{role} model</span>
              <input
                aria-label={`${role} model`}
                data-testid={`loop-${key}-model`}
                value={form[modelField]}
                onChange={(event) => update(modelField, event.target.value)}
                placeholder="Optional"
                style={inputStyle}
              />
            </label>
          </div>
        );
      })}

      <label style={fieldStyle}>
        <span>Run timeout minutes</span>
        <input
          type="number"
          min="1"
          step="1"
          aria-label="Run timeout minutes"
          data-testid="loop-timeout-minutes"
          value={form.timeoutMinutes}
          onChange={(event) => update("timeoutMinutes", event.target.value)}
          style={inputStyle}
        />
      </label>

      <fieldset
        style={{
          border: "1px solid #313244",
          borderRadius: 4,
          padding: 8,
          margin: "10px 0",
        }}
      >
        <legend style={{ color: "#a6adc8" }}>Optional deterministic verifier</legend>
        <label style={fieldStyle}>
          <span>Verifier program</span>
          <input
            aria-label="Verifier program"
            data-testid="loop-verifier-program"
            value={form.verifierProgram}
            onChange={(event) => update("verifierProgram", event.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={fieldStyle}>
          <span>Verifier arguments</span>
          <textarea
            aria-label="Verifier arguments"
            data-testid="loop-verifier-args"
            value={form.verifierArgs}
            onChange={(event) => update("verifierArgs", event.target.value)}
            placeholder="One argument per line"
            rows={3}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </label>
        <label style={fieldStyle}>
          <span>Verifier working directory</span>
          <input
            aria-label="Verifier working directory"
            data-testid="loop-verifier-cwd"
            value={form.verifierCwd}
            onChange={(event) => update("verifierCwd", event.target.value)}
            placeholder={workstreamDir}
            style={inputStyle}
          />
        </label>
      </fieldset>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {existing ? (
          <>
            <ActionButton
              testId="loop-save"
              label="Save"
              icon={ArrowDownTrayIcon}
              disabled={busy}
              onClick={() => onSave(false)}
            />
            <ActionButton
              testId="loop-enable"
              label="Enable"
              icon={PowerIcon}
              disabled={busy}
              onClick={onEnable}
            />
          </>
        ) : (
          <ActionButton
            testId="loop-save-enable"
            label="Save and enable"
            icon={PowerIcon}
            disabled={busy}
            onClick={() => onSave(true)}
          />
        )}
      </div>
    </form>
  );
}

function ReadonlyConfig({
  spec,
  busy,
  hasActiveRun,
  onDisable,
  onRun,
}: {
  spec: LoopSpec;
  busy: boolean;
  hasActiveRun: boolean;
  onDisable: () => void;
  onRun: () => void;
}) {
  const verifier = spec.verifier
    ? [spec.verifier.program, ...spec.verifier.args].join(" ")
    : "Not configured";
  return (
    <section data-testid="loop-config-readonly" style={sectionStyle}>
      <h2 style={headingStyle}>Enabled configuration</h2>
      <dl style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: "5px 8px" }}>
        <dt style={{ color: "#6c7086" }}>Orchestrator</dt>
        <dd style={{ margin: 0, whiteSpace: "pre-wrap" }}>{spec.orchestrator.prompt}</dd>
        <dt style={{ color: "#6c7086" }}>Worker</dt>
        <dd style={{ margin: 0, whiteSpace: "pre-wrap" }}>{spec.worker.prompt}</dd>
        <dt style={{ color: "#6c7086" }}>Evaluator</dt>
        <dd style={{ margin: 0, whiteSpace: "pre-wrap" }}>{spec.evaluator.prompt}</dd>
        <dt style={{ color: "#6c7086" }}>Timeout</dt>
        <dd style={{ margin: 0 }}>{spec.runTimeoutMs / 60_000} minutes</dd>
        <dt style={{ color: "#6c7086" }}>Verifier</dt>
        <dd style={{ margin: 0, fontFamily: "monospace" }}>{verifier}</dd>
      </dl>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
        <ActionButton
          testId="loop-run-now"
          label="Run now"
          icon={PlayIcon}
          disabled={busy || hasActiveRun}
          onClick={onRun}
        />
        <ActionButton
          testId="loop-disable"
          label="Disable"
          icon={PowerIcon}
          disabled={busy || hasActiveRun}
          onClick={onDisable}
        />
      </div>
    </section>
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

function TaskList({
  tasks,
  verifications,
  evaluations,
}: {
  tasks: LoopTask[];
  verifications: LoopVerificationRecord[];
  evaluations: LoopEvaluationRecord[];
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
              {task.workerSessionId ? ` · Worker session: ${task.workerSessionId}` : ""}
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
          {events.map((event) => (
            <li
              key={event.id}
              data-testid={`loop-event-${event.id}`}
              style={{ borderLeft: "2px solid #45475a", padding: "3px 0 6px 8px" }}
            >
              <div>
                <strong>{event.eventType}</strong>
                <span style={{ color: "#6c7086", marginLeft: 6 }}>{event.createdAt}</span>
              </div>
              {formatPayload(event.payload) && (
                <code style={{ color: "#a6adc8", whiteSpace: "pre-wrap" }}>
                  {formatPayload(event.payload)}
                </code>
              )}
            </li>
          ))}
        </ol>
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
}: {
  snapshot: PersistedLoopSnapshot;
  now: number;
  busy: boolean;
  onControl: (action: "pause" | "stop" | "kill") => void;
  onResume: () => void;
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
    snapshot.tasks.find((task) => task.id === run.activeTaskId) ?? null;
  const elapsed = run.startedAt
    ? formatDuration((run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.startedAt))
    : "Not available";
  const canControl = !TERMINAL_RUN_STATES.has(run.state);

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
        {run.deadlineAt && (
          <div style={{ color: "#6c7086" }}>Deadline: {run.deadlineAt}</div>
        )}
        {run.error && <div style={{ color: "#f38ba8" }}>{run.error}</div>}
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
              run.state !== "stopping" && (
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
      <TaskList
        tasks={snapshot.tasks}
        verifications={snapshot.verifications}
        evaluations={snapshot.evaluations}
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
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const draftVersionRef = useRef("");

  const load = useCallback(async () => {
    try {
      const loaded = await backend.getWorkstreamLoopSnapshot(workstreamId);
      setSnapshot(loaded);
      setNow(Date.now());
      const draftVersion = loaded.spec
        ? `${loaded.spec.id}:${loaded.spec.updatedAt ?? ""}`
        : `${workstreamId}:new`;
      if (
        draftVersionRef.current !== draftVersion &&
        (!loaded.spec || !loaded.spec.enabled)
      ) {
        draftVersionRef.current = draftVersion;
        setDraft(loaded.spec ? draftFromSpec(loaded.spec) : EMPTY_DRAFT);
      }
      setError(null);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, [backend, workstreamId]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);

    const onMemoryUpdate = (event: Event) => {
      if (
        event instanceof CustomEvent &&
        event.detail?.workstreamId === workstreamId
      ) {
        void load();
      }
    };
    window.addEventListener("memory-loop-updated", onMemoryUpdate);

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ workstreamId?: string }>("loop-updated", (event) => {
      if (!event.payload?.workstreamId || event.payload.workstreamId === workstreamId) {
        void load();
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
  }, [load, workstreamId]);

  const runIsActive =
    snapshot.latestRun !== null &&
    !TERMINAL_RUN_STATES.has(snapshot.latestRun.state);

  useEffect(() => {
    if (!runIsActive) return;
    const interval = window.setInterval(() => {
      setNow(Date.now());
      void load();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [load, runIsActive]);

  const perform = useCallback(
    async (operation: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await operation();
        await load();
      } catch (cause) {
        setError(message(cause));
      } finally {
        setBusy(false);
      }
    },
    [busy, load],
  );

  const save = (enableAfterSave: boolean) => {
    const parsed = specDraft(draft);
    if (typeof parsed === "string") {
      setError(parsed);
      return;
    }
    void perform(async () => {
      const saved = await backend.saveWorkstreamLoop(workstreamId, parsed);
      if (enableAfterSave) {
        await backend.setWorkstreamLoopEnabled(saved.id, true);
      }
    });
  };

  const enable = () => {
    const spec = snapshot.spec;
    if (!spec) return;
    void perform(() => backend.setWorkstreamLoopEnabled(spec.id, true));
  };

  const disable = () => {
    const spec = snapshot.spec;
    if (!spec) return;
    void perform(() => backend.setWorkstreamLoopEnabled(spec.id, false));
  };

  const runNow = () => {
    void perform(async () => {
      await backend.runWorkstreamLoopNow(workstreamId);
    });
  };

  const control = (action: "pause" | "stop" | "kill") => {
    const run = snapshot.latestRun;
    if (!run) return;
    void perform(() => backend.controlWorkstreamLoop(run.id, action));
  };

  const resume = () => {
    const run = snapshot.latestRun;
    if (!run) return;
    void perform(async () => {
      await backend.resumeWorkstreamLoop(run.id);
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
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "7px 10px",
          borderBottom: "1px solid #313244",
          flexShrink: 0,
        }}
      >
        <strong>Autonomous loop</strong>
        <button
          type="button"
          aria-label="Refresh loop"
          data-testid="loop-refresh"
          disabled={busy}
          onClick={() => void load()}
          style={buttonStyle}
        >
          <ArrowPathIcon aria-hidden="true" style={iconStyle} />
          Refresh
        </button>
      </header>

      <div style={scrollStyle}>
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
          <div data-testid="loop-loading">Loading loop configuration...</div>
        ) : (
          <>
            {snapshot.latestRun && (
              <RunPanel
                snapshot={snapshot}
                now={now}
                busy={busy}
                onControl={control}
                onResume={resume}
              />
            )}
            {snapshot.spec?.enabled ? (
              <ReadonlyConfig
                spec={snapshot.spec}
                busy={busy}
                hasActiveRun={runIsActive}
                onDisable={disable}
                onRun={runNow}
              />
            ) : (
              <SetupForm
                form={draft}
                setForm={setDraft}
                existing={snapshot.spec}
                busy={busy}
                workstreamDir={workstreamDir}
                onSave={save}
                onEnable={enable}
              />
            )}
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
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
