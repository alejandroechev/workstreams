import { useEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Workstream } from "../domain/types";
import {
  PencilSquareIcon,
  ArrowsRightLeftIcon,
  ArrowTopRightOnSquareIcon,
  ArchiveBoxIcon,
  MoonIcon,
  ClipboardDocumentListIcon,
} from "@heroicons/react/20/solid";

type WorkstreamStatus = Workstream["status"];

export interface WorkstreamActionMenuProps {
  workstream: Workstream;
  onClose: () => void;
  onRename: () => void;
  /** @deprecated kept for prop compatibility; UI no longer surfaces this. */
  onChangeStatus?: (status: WorkstreamStatus) => void;
  onChangeWorktree?: () => void;
  onFork?: () => void;
  onArchive: () => void;
  /**
   * Create a task for this workstream and open it on the board. Optional so
   * the menu stays renderable without a backend.
   */
  onCreateTask?: () => void;
  /**
   * Open this workstream's task on the board. Supplied only when one exists;
   * its presence is what replaces "Create task…", since the task↔workstream
   * relation is 1:1 and a second one could never be created anyway.
   */
  onGoToTask?: () => void;
  /**
   * Stop a loaded workstream's inner tiles/processes without archiving it. The
   * workstream stays in the active list and reverts to the "stopped" (moon)
   * indicator. Only surfaced when the workstream is currently loaded.
   */
  onCloseWorkstream?: () => void;
  /** Whether the workstream is currently loaded (has running tiles/PTYs). */
  isLoaded?: boolean;
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
  onChangeStatus: _onChangeStatus,
  onChangeWorktree,
  onFork,
  onArchive,
  onCreateTask,
  onGoToTask,
  onCloseWorkstream,
  isLoaded,
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
      // The menu renders as a DOM descendant of its sidebar row (which selects
      // the workstream on click). Stop clicks here so invoking an action
      // (rename, change worktree, archive, …) on a NON-loaded workstream does
      // not bubble up and open/load it.
      onClick={(e) => e.stopPropagation()}
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

      {onGoToTask ? (
        <MenuItem
          icon={<ClipboardDocumentListIcon style={iconStyle} />}
          label="Go to task"
          onClick={close(onGoToTask)}
          testid="action-go-to-task"
        />
      ) : (
        onCreateTask && (
          <MenuItem
            icon={<ClipboardDocumentListIcon style={iconStyle} />}
            label="Create task…"
            onClick={close(onCreateTask)}
            testid="action-create-task"
          />
        )
      )}

      <Divider />

      {isLoaded && onCloseWorkstream && (
        <MenuItem
          icon={<MoonIcon style={iconStyle} />}
          label="Close (stop processes)"
          onClick={close(onCloseWorkstream)}
          testid="action-close"
        />
      )}

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

const dividerStyle: CSSProperties = {
  height: 1,
  background: "#313244",
  margin: "4px 0",
};
