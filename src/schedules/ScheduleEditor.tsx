import { useEffect, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { DAY_NAMES, validateFrequency, type ScheduleFrequency } from "../domain/periodic-schedules";
import type { ScheduleDraft } from "./useSchedules";
import { backdropStyle, buttonStyle, headerStyle, iconButtonStyle, inputStyle, panelStyle } from "./styles";

type Preset = "hourly" | "hours" | "minutes" | "daily" | "weekly";

interface Props {
  title: string;
  initial?: ScheduleDraft;
  onSave(draft: ScheduleDraft): Promise<void>;
  onCancel(): void;
}

function presetOf(frequency: ScheduleFrequency | undefined): { preset: Preset; every: number; time: string; day: number } {
  const base = { every: 2, time: "09:00", day: 1 };
  if (!frequency) return { preset: "daily", ...base };
  if (frequency.kind === "daily") return { preset: "daily", ...base, time: frequency.time };
  if (frequency.kind === "weekly") return { preset: "weekly", ...base, time: frequency.time, day: frequency.day };
  if (frequency.minutes === 60) return { preset: "hourly", ...base };
  if (frequency.minutes % 60 === 0) return { preset: "hours", ...base, every: frequency.minutes / 60 };
  return { preset: "minutes", ...base, every: frequency.minutes };
}

function frequencyFrom(preset: Preset, every: number, time: string, day: number): ScheduleFrequency {
  switch (preset) {
    case "hourly": return { kind: "interval", minutes: 60 };
    case "hours": return { kind: "interval", minutes: every * 60 };
    case "minutes": return { kind: "interval", minutes: every };
    case "daily": return { kind: "daily", time };
    case "weekly": return { kind: "weekly", day, time };
  }
}

/**
 * "Run periodically…": the prompt sent verbatim at each run, a preset
 * frequency, and the two notify toggles (off by default) (ADR 044).
 */
export function ScheduleEditor({ title, initial, onSave, onCancel }: Props) {
  const start = presetOf(initial?.frequency);
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [preset, setPreset] = useState<Preset>(start.preset);
  const [every, setEvery] = useState(start.every);
  const [time, setTime] = useState(start.time);
  const [day, setDay] = useState(start.day);
  const [notifyInbox, setNotifyInbox] = useState(initial?.notifyInbox ?? false);
  const [notifyPhone, setNotifyPhone] = useState(initial?.notifyPhone ?? false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onCancel(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const save = async () => {
    if (!prompt.trim()) { setError("Write the prompt each run sends."); return; }
    const frequency = frequencyFrom(preset, every, time, day);
    const problem = validateFrequency(frequency);
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave({ prompt, frequency, notifyInbox, notifyPhone });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  const label = { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "#a6adc8" } as const;
  return (
    <div data-testid="schedule-editor-backdrop" onClick={onCancel} style={backdropStyle}>
      <section role="dialog" aria-modal="true" aria-label={title} data-testid="schedule-editor" onClick={(e) => e.stopPropagation()} style={panelStyle}>
        <div style={headerStyle}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{title}</div>
          <button aria-label="Cancel" onClick={onCancel} style={iconButtonStyle}><XMarkIcon style={{ width: 16, height: 16 }} /></button>
        </div>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={label}>
            Prompt — sent as written at every run, resuming this session
            <textarea data-testid="schedule-prompt" value={prompt} rows={5} onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()} style={{ ...inputStyle, resize: "vertical" }} />
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <label style={label}>
              Frequency
              <select data-testid="schedule-frequency" value={preset} onChange={(e) => setPreset(e.target.value as Preset)} style={inputStyle}>
                <option value="hourly">Hourly</option>
                <option value="hours">Every N hours</option>
                <option value="minutes">Every N minutes</option>
                <option value="daily">Daily at</option>
                <option value="weekly">Weekly on</option>
              </select>
            </label>
            {(preset === "hours" || preset === "minutes") && (
              <label style={label}>
                {preset === "hours" ? "Hours" : "Minutes"}
                <input data-testid="schedule-every" type="number" min={1} value={every} onChange={(e) => setEvery(Number(e.target.value))}
                  style={{ ...inputStyle, width: 70 }} />
              </label>
            )}
            {preset === "weekly" && (
              <label style={label}>
                Day
                <select data-testid="schedule-day" value={day} onChange={(e) => setDay(Number(e.target.value))} style={inputStyle}>
                  {DAY_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}
                </select>
              </label>
            )}
            {(preset === "daily" || preset === "weekly") && (
              <label style={label}>
                Time (laptop's local time)
                <input data-testid="schedule-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={inputStyle} />
              </label>
            )}
          </div>
          <label style={{ display: "flex", gap: 6, fontSize: 12, alignItems: "center" }}>
            <input data-testid="schedule-notify-inbox" type="checkbox" checked={notifyInbox} onChange={(e) => setNotifyInbox(e.target.checked)} />
            Notify in Inbox <span style={{ color: "#6c7086" }}>— asks the agent to report with ws-message</span>
          </label>
          <label style={{ display: "flex", gap: 6, fontSize: 12, alignItems: "center" }}>
            <input data-testid="schedule-notify-phone" type="checkbox" checked={notifyPhone} onChange={(e) => setNotifyPhone(e.target.checked)} />
            Notify my phone <span style={{ color: "#6c7086" }}>— asks the agent to report with companion-reply</span>
          </label>
          <div style={{ fontSize: 11, color: "#6c7086" }}>
            The first run is at the first scheduled time. Runs happen while Workstreams is open; a run due while the agent
            is busy, or missed while the laptop slept, is skipped.
          </div>
          {error && <div data-testid="schedule-error" role="alert" style={{ color: "#f38ba8", fontSize: 12 }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button onClick={onCancel} style={buttonStyle}>Cancel</button>
            <button data-testid="schedule-save" disabled={saving} onClick={() => void save()} style={{ ...buttonStyle, background: "#89b4fa", color: "#11111b" }}>Save</button>
          </div>
        </div>
      </section>
    </div>
  );
}
