import { useEffect, useRef } from "react";
import {
  ClipboardDocumentIcon,
  FolderOpenIcon,
  BeakerIcon,
} from "@heroicons/react/24/outline";
import { openPath } from "@tauri-apps/plugin-opener";
import { writeTextToClipboard } from "../../domain/clipboard";
import { dispatchAddToWorkbench } from "../../domain/workbench-events";

interface Props {
  x: number;
  y: number;
  /** Absolute file or directory path the menu acts on. */
  path: string;
  /** True for directories; affects label wording + hides "Add to Workbench". */
  isDir?: boolean;
  workstreamId: string | null;
  onClose: () => void;
  /** Hide "Add to Workbench" even for files (e.g. when invoked from the
   * Workbench tile itself, where it's a no-op). */
  hideAddToWorkbench?: boolean;
}

/**
 * Shared right-click menu for files / directories. Used by Repo Explorer,
 * Session Meta (State tab + Config items), and Workbench tiles. Single
 * source of truth so a new entry (e.g. "Reveal in File Explorer") shows
 * up consistently everywhere.
 */
export function FileContextMenu({
  x,
  y,
  path,
  isDir = false,
  workstreamId,
  onClose,
  hideAddToWorkbench = false,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // Defer install so the right-click event that opened the menu doesn't
    // immediately close it via the mousedown listener.
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
  const name = path.split(/[\\/]/).filter(Boolean).pop() || path;

  return (
    <div
      ref={ref}
      data-testid="file-context-menu"
      data-path={path}
      role="menu"
      style={{
        position: "fixed",
        top: y,
        left: x,
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
      }}
    >
      <div
        style={{
          padding: "6px 10px 8px",
          borderBottom: "1px solid #313244",
          marginBottom: 4,
          color: "#bac2de",
          fontWeight: 500,
          fontSize: 11,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: 320,
        }}
      >
        {name}
      </div>
      <Item
        icon={<ClipboardDocumentIcon style={iconStyle} />}
        label="Copy full path"
        onClick={close(() => { void writeTextToClipboard(path); })}
        testid="ctx-copy-path"
      />
      <Item
        icon={<ClipboardDocumentIcon style={iconStyle} />}
        label={isDir ? "Copy folder name" : "Copy file name"}
        onClick={close(() => { void writeTextToClipboard(name); })}
        testid="ctx-copy-name"
      />
      <Item
        icon={<FolderOpenIcon style={iconStyle} />}
        label="Open in system"
        onClick={close(() => { openPath(path).catch(() => {}); })}
        testid="ctx-open-system"
      />
      {!isDir && !hideAddToWorkbench && (
        <Item
          icon={<BeakerIcon style={iconStyle} />}
          label="Add to Workbench"
          onClick={close(() => { dispatchAddToWorkbench({ path, workstreamId }); })}
          testid="ctx-add-to-workbench"
        />
      )}
    </div>
  );
}

const iconStyle: React.CSSProperties = { width: 14, height: 14, color: "#a6adc8", flexShrink: 0 };

function Item({ icon, label, onClick, testid }: { icon: React.ReactNode; label: string; onClick: () => void; testid: string }) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      style={{
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
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
