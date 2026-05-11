import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Props {
  tileId: string;
  isFocused: boolean;
  onStatusChange?: (status: string) => void;
}

export default function TerminalTile({ tileId, isFocused, onStatusChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const [status, setStatus] = useState<"spawning" | "running" | "exited" | "failed">("spawning");

  const updateStatus = useCallback((s: typeof status) => {
    setStatus(s);
    onStatusChange?.(s);
  }, [onStatusChange]);

  // Save scrollback periodically and on unmount
  const saveScrollback = useCallback(async () => {
    if (!serializeRef.current || !termRef.current) return;
    try {
      const data = serializeRef.current.serialize();
      if (data.length > 1_000_000) return;
      await invoke("save_scrollback", { tileId, scrollback: data });
    } catch {
      // best effort
    }
  }, [tileId]);

  // Restart terminal (kill existing + respawn)
  const restart = useCallback(async () => {
    try {
      await invoke("close_terminal", { tileId }).catch(() => {});
      updateStatus("spawning");
      // Re-read tile config to get cwd/command
      const tiles = await invoke<Array<{id: string; config_json: string}>>("list_tiles", { workstreamId: "" }).catch(() => []);
      // Default respawn with pwsh
      await invoke("spawn_terminal", {
        tileId,
        cwd: "C:\\",
        rows: 30,
        cols: 120,
      });
      updateStatus("running");
    } catch {
      updateStatus("failed");
    }
  }, [tileId, updateStatus]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      altClickMovesCursor: true,
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Consolas', monospace",
      scrollback: 999999,
      scrollOnUserInput: true,
      theme: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
        cursor: "#f5e0dc",
        selectionBackground: "#585b70",
        black: "#45475a",
        red: "#f38ba8",
        green: "#a6e3a1",
        yellow: "#f9e2af",
        blue: "#89b4fa",
        magenta: "#f5c2e7",
        cyan: "#94e2d5",
        white: "#bac2de",
      },
    });

    const fitAddon = new FitAddon();
    const serializeAddon = new SerializeAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(serializeAddon);

    termRef.current = term;
    fitRef.current = fitAddon;
    serializeRef.current = serializeAddon;

    term.open(containerRef.current);
    fitAddon.fit();

    // Only restore scrollback on first mount (not when re-mounting due to workstream switch)
    if (!onStatusChange) {
      // Regular terminal — try restore
      invoke<string | null>("load_scrollback", { tileId }).then((data) => {
        if (data) {
          term.write(data);
        }
        updateStatus("running");
      }).catch(() => {
        updateStatus("running");
      });
    } else {
      updateStatus("running");
    }

    // Forward keystrokes to PTY
    term.onData((data) => {
      invoke("write_to_pty", { tileId, data }).catch(() => {});
    });

    // Handle special key combos that xterm.js doesn't handle natively
    term.attachCustomKeyEventHandler((ev) => {
      // Block keyup for combos we handle on keydown (prevents double-fire)
      if (ev.type === "keyup") {
        if (ev.key === "Enter" && (ev.shiftKey || ev.ctrlKey)) return false;
        if (ev.key === "v" && ev.ctrlKey) return false;
        return true;
      }
      if (ev.type !== "keydown") return true;

      // Shift+Enter / Ctrl+Enter: send newline
      if (ev.key === "Enter" && (ev.shiftKey || ev.ctrlKey)) {
        ev.preventDefault();
        invoke("write_to_pty", { tileId, data: "\n" }).catch(() => {});
        return false;
      }

      // Ctrl+V: paste from clipboard
      if (ev.key === "v" && ev.ctrlKey && !ev.shiftKey) {
        ev.preventDefault();
        navigator.clipboard.readText().then((text) => {
          if (text) invoke("write_to_pty", { tileId, data: text }).catch(() => {});
        }).catch(() => {});
        return false;
      }

      // Alt+ combos: let them bubble to the app-level handler
      if (ev.altKey) return false;

      return true;
    });

    // Listen for PTY output
    const unlistenOutput = listen<string>(`pty-output-${tileId}`, (event) => {
      term.write(event.payload);
    });

    // Listen for PTY exit
    const unlistenExit = listen(`pty-exit-${tileId}`, () => {
      term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
      updateStatus("exited");
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        invoke("resize_pty", {
          tileId,
          rows: dims.rows,
          cols: dims.cols,
        }).catch(() => {});
      }
    });
    resizeObserver.observe(containerRef.current);

    // Mouse wheel: when in alternate screen (TUI apps), send as arrow keys
    const wheelHandler = (e: WheelEvent) => {
      const buf = (term as unknown as { buffer: { active: { type: string } } }).buffer?.active;
      if (buf && buf.type === "alternate") {
        e.preventDefault();
        const lines = Math.max(1, Math.round(Math.abs(e.deltaY) / 40));
        const arrow = e.deltaY < 0 ? "\x1b[A" : "\x1b[B";
        invoke("write_to_pty", { tileId, data: arrow.repeat(lines) }).catch(() => {});
      }
    };
    containerRef.current.addEventListener("wheel", wheelHandler, { passive: false });

    // Periodic scrollback save (every 30s)
    const saveInterval = setInterval(saveScrollback, 30_000);

    return () => {
      clearInterval(saveInterval);
      saveScrollback();
      containerRef.current?.removeEventListener("wheel", wheelHandler);
      resizeObserver.disconnect();
      unlistenOutput.then((u) => u());
      unlistenExit.then((u) => u());
      term.dispose();
    };
  }, [tileId, saveScrollback, updateStatus]);

  // Refit on focus change
  useEffect(() => {
    if (isFocused && fitRef.current) {
      setTimeout(() => {
        fitRef.current?.fit();
        termRef.current?.focus();
      }, 50);
    }
  }, [isFocused]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}>
      {status === "exited" && (
        <div
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            zIndex: 10,
            background: "#313244",
            borderRadius: 4,
            padding: "4px 10px",
            fontSize: 11,
            color: "#f9e2af",
            cursor: "pointer",
          }}
          onClick={restart}
        >
          ↻ Restart
        </div>
      )}
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", overflow: "hidden" }}
      />
    </div>
  );
}
