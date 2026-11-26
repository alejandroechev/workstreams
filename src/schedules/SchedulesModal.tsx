import { useEffect, useState } from "react";
import { ClockIcon, PauseIcon, PencilSquareIcon, PlayIcon, TrashIcon, XMarkIcon, BoltIcon } from "@heroicons/react/24/outline";
import {
  describeFrequency,
  describeLastResult,
  formatNextRun,
  promptFirstLine,
  type PeriodicSchedule,
} from "../domain/periodic-schedules";
import { backdropStyle, buttonStyle, headerStyle, iconButtonStyle, panelStyle } from "./styles";

export interface ScheduleControls {
  runNow(id: string): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  edit(schedule: PeriodicSchedule): void;
  remove(id: string): Promise<void>;
}

interface Props extends ScheduleControls {
  schedules: PeriodicSchedule[];
  now: number;
  workstreamName(id: string): string;
  tileTitle(tileId: string): string | undefined;
  onClose(): void;
}

/** Every periodic schedule across workstreams, with its controls (ADR 044). */
export function SchedulesModal({ schedules, now, workstreamName, tileTitle, onClose, ...controls }: Props) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = (work: Promise<void>) => {
    setError(null);
    work.catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)));
  };

  return (
    <div data-testid="schedules-backdrop" onClick={onClose} style={backdropStyle}>
      <section role="dialog" aria-modal="true" aria-label="Schedules" data-testid="schedules-panel" onClick={(e) => e.stopPropagation()} style={{ ...panelStyle, width: "min(760px, 94vw)" }}>
        <div style={headerStyle}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Schedules</div>
            <div style={{ color: "#6c7086", fontSize: 11 }}>
              {schedules.length} periodic session{schedules.length === 1 ? "" : "s"} · runs while Workstreams is open
            </div>
          </div>
          <button aria-label="Close schedules" data-testid="schedules-close" onClick={onClose} style={iconButtonStyle}>
            <XMarkIcon style={{ width: 16, height: 16 }} />
          </button>
        </div>
        {error && <div role="alert" data-testid="schedules-error" style={{ color: "#f38ba8", fontSize: 12, padding: "6px 14px" }}>{error}</div>}
        <div style={{ overflowY: "auto", padding: "6px 0" }}>
          {schedules.length === 0 && (
            <div data-testid="schedules-empty" style={{ color: "#6c7086", fontSize: 12, padding: "14px" }}>
              No schedules yet. Use Add tile → Periodic session to make one.
            </div>
          )}
          {schedules.map((schedule) => (
            <div key={schedule.id} data-testid={`schedule-row-${schedule.id}`} data-paused={schedule.paused ? "true" : "false"}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderBottom: "1px solid #313244" }}>
              <ClockIcon style={{ width: 16, height: 16, color: schedule.paused ? "#6c7086" : "#89b4fa", flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <span data-testid="schedule-row-workstream" style={{ color: "#a6adc8" }}>{workstreamName(schedule.workstream_id)}</span>
                  <span style={{ color: "#6c7086" }}> · {tileTitle(schedule.tile_id) ?? "session"} · </span>
                  <span data-testid="schedule-row-prompt">{promptFirstLine(schedule.prompt)}</span>
                </div>
                <div style={{ fontSize: 11, color: "#6c7086" }}>
                  {describeFrequency(schedule.frequency)} ·{" "}
                  <span data-testid="schedule-row-next">{schedule.paused ? "paused" : `next ${formatNextRun(schedule.next_run_at, now)}`}</span>
                  {" · "}<span data-testid="schedule-row-last">last {describeLastResult(schedule)}</span>
                  {schedule.failures > 0 && ` · ${schedule.failures} failure${schedule.failures === 1 ? "" : "s"} in a row`}
                </div>
              </div>
              <button data-testid={`schedule-run-${schedule.id}`} title="Run now" onClick={() => act(controls.runNow(schedule.id))} style={buttonStyle}>
                <BoltIcon style={{ width: 12, height: 12 }} />Run now
              </button>
              {schedule.paused ? (
                <button data-testid={`schedule-resume-${schedule.id}`} onClick={() => act(controls.resume(schedule.id))} style={buttonStyle}>
                  <PlayIcon style={{ width: 12, height: 12 }} />Resume
                </button>
              ) : (
                <button data-testid={`schedule-pause-${schedule.id}`} onClick={() => act(controls.pause(schedule.id))} style={buttonStyle}>
                  <PauseIcon style={{ width: 12, height: 12 }} />Pause
                </button>
              )}
              <button data-testid={`schedule-edit-${schedule.id}`} onClick={() => controls.edit(schedule)} style={buttonStyle}>
                <PencilSquareIcon style={{ width: 12, height: 12 }} />Edit
              </button>
              <button data-testid={`schedule-delete-${schedule.id}`} title="Delete the schedule (the tile stays)" onClick={() => act(controls.remove(schedule.id))} style={buttonStyle}>
                <TrashIcon style={{ width: 12, height: 12 }} />Delete
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
