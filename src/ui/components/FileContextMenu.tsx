import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ClipboardDocumentIcon,
  FolderOpenIcon,
  BeakerIcon,
  DocumentPlusIcon,
  FolderPlusIcon,
} from "@heroicons/react/24/outline";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
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
  /** When provided, a "New file" item is shown that invokes this callback. */
  onNewFile?: (name: string) => Promise<unknown> | unknown;
  /** When provided, a "New folder" item is shown that invokes this callback. */
  onNewFolder?: (name: string) => Promise<unknown> | unknown;
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
  onNewFile,
  onNewFolder,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y, measured: false });
  const [createKind, setCreateKind] = useState<"file" | "folder" | null>(null);
  const [createName, setCreateName] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionEpochRef = useRef(0);

  useEffect(() => {
    return () => {
      actionEpochRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const handlePointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      onClose();
    };
    // Capture phase wins over app/tile handlers (notably fullscreen Escape).
    window.addEventListener("pointerdown", handlePointer, true);
    window.addEventListener("keydown", handleEsc, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointer, true);
      window.removeEventListener("keydown", handleEsc, true);
    };
  }, [onClose]);

  const clampPosition = useCallback(() => {
    const menu = ref.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const anchorX = Number.isFinite(x) ? x : margin;
    const anchorY = Number.isFinite(y) ? y : margin;
    setPosition({
      left: Math.max(margin, Math.min(anchorX, window.innerWidth - rect.width - margin)),
      top: Math.max(margin, Math.min(anchorY, window.innerHeight - rect.height - margin)),
      measured: true,
    });
  }, [x, y]);

  useLayoutEffect(() => {
    clampPosition();
    const raf = requestAnimationFrame(clampPosition);
    window.addEventListener("resize", clampPosition);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", clampPosition);
    };
  }, [clampPosition, createKind, actionError]);

  const close = (fn: () => void) => () => { onClose(); fn(); };
  const name = path.split(/[\\/]/).filter(Boolean).pop() || path;

  const beginCreate = (kind: "file" | "folder") => {
    setActionError(null);
    setCreateName("");
    setCreateKind(kind);
  };

  const submitCreate = async () => {
    const trimmed = createName.trim();
    if (!trimmed || !createKind) return;
    const action = createKind === "file" ? onNewFile : onNewFolder;
    if (!action) return;
    setBusy(true);
    setActionError(null);
    const epoch = ++actionEpochRef.current;
    try {
      await action(trimmed);
      if (epoch !== actionEpochRef.current) return;
      onClose();
    } catch (error) {
      if (epoch !== actionEpochRef.current) return;
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (epoch === actionEpochRef.current) setBusy(false);
    }
  };

  const openInSystem = async () => {
    setBusy(true);
    setActionError(null);
    const epoch = ++actionEpochRef.current;
    try {
      await revealItemInDir(path);
      if (epoch !== actionEpochRef.current) return;
      onClose();
    } catch (error) {
      if (epoch !== actionEpochRef.current) return;
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (epoch === actionEpochRef.current) setBusy(false);
    }
  };

  return createPortal(
    <>
    <div
      data-testid="file-context-menu-backdrop"
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 1999 }}
    />
    <div
      ref={ref}
      data-testid="file-context-menu"
      data-path={path}
      role="menu"
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        visibility: position.measured ? "visible" : "hidden",
        zIndex: 2000,
        minWidth: 200,
        maxHeight: "calc(100vh - 16px)",
        overflowY: "auto",
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
      {createKind ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 6px" }}>
          <label htmlFor="context-create-name" style={{ color: "#bac2de", fontSize: 11 }}>
            New {createKind} name
          </label>
          <input
            id="context-create-name"
            data-testid="ctx-create-name"
            autoFocus
            value={createName}
            disabled={busy}
            onChange={(event) => setCreateName(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                void submitCreate();
              }
            }}
            style={{
              background: "#11111b",
              border: "1px solid #45475a",
              borderRadius: 4,
              color: "#cdd6f4",
              padding: "5px 7px",
              fontSize: 12,
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
            <button type="button" disabled={busy} onClick={() => setCreateKind(null)}>Cancel</button>
            <button
              type="button"
              data-testid="ctx-create-save"
              disabled={busy || !createName.trim()}
              onClick={() => void submitCreate()}
            >
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      ) : (
      <>
      <Item
        icon={<ClipboardDocumentIcon style={iconStyle} />}
        label="Copy full path"
        onClick={close(() => { void writeTextToClipboard(path); })}
        testid="ctx-copy-path"
      />
      {(onNewFile || onNewFolder) && (
        <>
          {onNewFile && (
            <Item
              icon={<DocumentPlusIcon style={iconStyle} />}
              label="New file…"
              onClick={() => beginCreate("file")}
              testid="ctx-new-file"
            />
          )}
          {onNewFolder && (
            <Item
              icon={<FolderPlusIcon style={iconStyle} />}
              label="New folder…"
              onClick={() => beginCreate("folder")}
              testid="ctx-new-folder"
            />
          )}
        </>
      )}
      <Item
        icon={<ClipboardDocumentIcon style={iconStyle} />}
        label={isDir ? "Copy folder name" : "Copy file name"}
        onClick={close(() => { void writeTextToClipboard(name); })}
        testid="ctx-copy-name"
      />
      <Item
        icon={<FolderOpenIcon style={iconStyle} />}
        label="Open in system"
        onClick={() => void openInSystem()}
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
      </>
      )}
      {actionError && (
        <div
          data-testid="ctx-action-error"
          role="alert"
          style={{ color: "#f38ba8", fontSize: 11, padding: "5px 8px", maxWidth: 300 }}
        >
          {actionError}
        </div>
      )}
    </div>
    </>,
    document.body,
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
