import { useEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Workstream } from "../domain/types";
import {
  PencilSquareIcon,
  ArrowsRightLeftIcon,
  ArrowsUpDownIcon,
  ArrowTopRightOnSquareIcon,
  ArchiveBoxIcon,
} from "@heroicons/react/20/solid";

type WorkstreamStatus = Workstream["status"];

const STATUS_OPTIONS: Array<{ value: WorkstreamStatus; label: string; color: string }> = [
  { value: "active", label: "Active", color: "#a6e3a1" },
  { value: "working", label: "Working", color: "#89b4fa" },
  { value: "in_review", label: "In Review", color: "#f9e2af" },
  { value: "blocked", label: "Blocked", color: "#f38ba8" },
];

export interface WorkstreamActionMenuProps {
  workstream: Workstream;
  onClose: () => void;
  onRename: () => void;
  onChangeStatus: (status: WorkstreamStatus) => void;
  onChangeWorktree?: () => void;
  onFork?: () => void;
  onArchive: () => void;
  /** Absolute coordinates for the popover (top-left of the trigger button). */
  anchor: { top: number; left: number };
}

/**
 * Single popover that surfaces every per-workstream action so the sidebar
 * row stays uncluttered. Triggered by the "⋯" button on each row.
 */
export function WorkstreamActionMenu({
  workstream,
  onClose,
  onRename,
  onChangeStatus,
  onChangeWorktree,
  onFork,
  onArchive,
  anchor,
}: WorkstreamActionMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // Defer the listener install so the click that opened the menu doesn't
    // immediately close it.
    const t = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleEsc);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [onClose]);

  const close = (fn: () => void) => () => { onClose(); fn(); };

  return (
    <div
      ref={ref}
      data-testid="workstream-action-menu"
      data-workstream-id={workstream.id}
      style={{
        ...menuStyle,
        top: anchor.top,
        left: anchor.left,
      }}
      role="menu"
    >
      <div style={headerStyle}>{workstream.name}</div>

      <MenuItem
        icon={<PencilSquareIcon style={iconStyle} />}
        label="Rename"
        onClick={close(onRename)}
        testid="action-rename"
      />

      {onChangeWorktree && (
        <MenuItem
          icon={<ArrowsRightLeftIcon style={iconStyle} />}
          label="Change worktree…"
          onClick={close(onChangeWorktree)}
          testid="action-change-worktree"
        />
      )}

      {onFork && (
        <MenuItem
          icon={<ArrowTopRightOnSquareIcon style={iconStyle} />}
          label="Fork to new worktree"
          onClick={close(onFork)}
          testid="action-fork"
        />
      )}

      <Divider />

      <div style={sectionLabelStyle}>
        <ArrowsUpDownIcon style={{ width: 12, height: 12, color: "#6c7086" }} />
        Status
      </div>
      {STATUS_OPTIONS.map((opt) => {
        const isCurrent = workstream.status === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            data-testid={`action-status-${opt.value}`}
            onClick={close(() => onChangeStatus(opt.value))}
            style={{
              ...itemStyle,
              background: isCurrent ? "#313244" : "transparent",
              fontWeight: isCurrent ? 500 : 400,
            }}
          >
            <span style={{ ...statusDotStyle, background: opt.color }} />
            <span>{opt.label}</span>
            {isCurrent && <span style={{ marginLeft: "auto", color: "#6c7086", fontSize: 10 }}>current</span>}
          </button>
        );
      })}

      <Divider />

      <MenuItem
        icon={<ArchiveBoxIcon style={{ ...iconStyle, color: "#f38ba8" }} />}
        label="Archive"
        onClick={close(onArchive)}
        testid="action-archive"
        danger
      />
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  testid,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  testid: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      style={{ ...itemStyle, color: danger ? "#f38ba8" : "#cdd6f4" }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Divider() {
  return <div style={dividerStyle} />;
}

const menuStyle: CSSProperties = {
  position: "fixed",
  zIndex: 2000,
  minWidth: 200,
  background: "#181825",
  border: "1px solid #45475a",
  borderRadius: 6,
  padding: 4,
  boxShadow: "0 6px 16px rgba(0,0,0,0.45)",
  color: "#cdd6f4",
  fontSize: 12,
  fontFamily: "inherit",
};

const headerStyle: CSSProperties = {
  padding: "6px 10px 8px",
  borderBottom: "1px solid #313244",
  marginBottom: 4,
  color: "#bac2de",
  fontWeight: 500,
  fontSize: 11,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const itemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 10px",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: "#cdd6f4",
  fontSize: 12,
  textAlign: "left",
  borderRadius: 4,
};

const iconStyle: CSSProperties = { width: 14, height: 14, color: "#a6adc8", flexShrink: 0 };

const sectionLabelStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 10px 4px",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "#6c7086",
};

const statusDotStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  flexShrink: 0,
};

const dividerStyle: CSSProperties = {
  height: 1,
  background: "#313244",
  margin: "4px 0",
};
