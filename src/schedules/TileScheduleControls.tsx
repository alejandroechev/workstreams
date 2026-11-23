import { useEffect, useRef, useState } from "react";
import { ClockIcon, EllipsisVerticalIcon } from "@heroicons/react/24/outline";
import { describeFrequency, describeLastResult, formatNextRun } from "../domain/periodic-schedules";
import { useTileSchedules } from "./context";

/**
 * A Copilot session tile's periodic badge (next run, last result) and its
 * menu with "Run periodically…" (ADR 044). Renders nothing outside the app's
 * schedules context.
 */
export function TileScheduleControls({ tileId, workstreamId }: { tileId: string; workstreamId?: string }) {
  const context = useTileSchedules();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (!context || !workstreamId) return null;
  const schedule = context.byTile.get(tileId);
  const badge = schedule
    ? `${schedule.paused ? "paused" : `next: ${formatNextRun(schedule.next_run_at, context.now)}`} · last: ${describeLastResult(schedule)}`
    : null;
  return (
    <div ref={root} style={{ display: "flex", alignItems: "center", gap: 4, position: "relative" }} onDoubleClick={(e) => e.stopPropagation()}>
      {schedule && badge && (
        <span
          data-testid={`tile-schedule-badge-${tileId}`}
          title={`Runs periodically: ${describeFrequency(schedule.frequency)}`}
          onClick={(e) => { e.stopPropagation(); context.openEditor(tileId, workstreamId); }}
          style={{
            display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, cursor: "pointer",
            color: schedule.paused ? "#6c7086" : "#89b4fa", border: "1px solid #313244", borderRadius: 999, padding: "0 6px",
            whiteSpace: "nowrap",
          }}
        >
          <ClockIcon style={{ width: 11, height: 11 }} />
          {badge}
        </span>
      )}
      <button
        data-testid={`tile-menu-${tileId}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Tile menu"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        style={{ background: "none", border: "none", color: "#585b70", cursor: "pointer", padding: "0 2px", display: "inline-flex" }}
      >
        <EllipsisVerticalIcon style={{ width: 14, height: 14 }} />
      </button>
      {open && (
        <div role="menu" style={{
          position: "absolute", top: "calc(100% + 4px)", right: 0, background: "#1e1e2e", border: "1px solid #45475a",
          borderRadius: 6, boxShadow: "0 6px 16px rgba(0,0,0,0.5)", padding: 4, zIndex: 100, minWidth: 170,
        }}>
          <button
            role="menuitem"
            data-testid="tile-menu-run-periodically"
            onClick={(e) => { e.stopPropagation(); setOpen(false); context.openEditor(tileId, workstreamId); }}
            style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "5px 8px", background: "transparent",
              border: "none", borderRadius: 4, color: "#cdd6f4", fontSize: 12, textAlign: "left", cursor: "pointer" }}
          >
            <ClockIcon style={{ width: 13, height: 13, color: "#89b4fa" }} />
            {schedule ? "Edit schedule…" : "Run periodically…"}
          </button>
        </div>
      )}
    </div>
  );
}
