import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseCopilotSessionConfig, buildCopilotCommand } from "../domain/tile-config";
import type { CopilotSessionStats } from "../domain/types";

interface Props {
  tileId: string;
  configJson: string;
  isFocused: boolean;
  isResuming: boolean;
  onStatusChange?: (status: string) => void;
  onStatsUpdate?: (stats: CopilotSessionStats) => void;
}

export default function CopilotSessionTile({
  tileId,
  configJson,
  isFocused,
  isResuming,
  onStatusChange,
  onStatsUpdate,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const [status, setStatus] = useState<string>(isResuming ? "resuming" : "starting");

  const config = parseCopilotSessionConfig(configJson);

  const updateStatus = useCallback((s: string) => {
    setStatus(s);
    onStatusChange?.(s);
  }, [onStatusChange]);

  const saveScrollback = useCallback(async () => {
    if (!serializeRef.current) return;
    try {
      const data = serializeRef.current.serialize();
      if (data.length > 1_000_000) return;
      await invoke("save_scrollback", { tileId, scrollback: data });
    } catch { /* best effort */ }
  }, [tileId]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Consolas', monospace",
      scrollback: 10000,
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

    // Register with the session stats poller
    invoke("watch_session", { tileId, sessionName: config.session_name }).catch(() => {});

    // Restore scrollback if resuming
    invoke<string | null>("load_scrollback", { tileId }).then((data) => {
      if (data) {
        term.write(data);
        term.write("\r\n\x1b[90m--- restored scrollback ---\x1b[0m\r\n");
      }
    }).catch(() => {});

    // Build the copilot command
    const command = buildCopilotCommand(config, isResuming);
    term.write(`\x1b[36m$ ${command}\x1b[0m\r\n`);
    updateStatus(isResuming ? "resuming" : "starting");

    // The PTY spawns pwsh.exe, then we send the copilot command to it
    // We need to wait for the shell prompt before sending
    let commandSent = false;
    const sendCommand = () => {
      if (commandSent) return;
      commandSent = true;
      // Small delay to let the shell initialize
      setTimeout(() => {
        invoke("write_to_pty", { tileId, data: command + "\r" }).catch(() => {});
        updateStatus("running");
      }, 2000);
    };

    // Forward keystrokes to PTY
    term.onData((data) => {
      invoke("write_to_pty", { tileId, data }).catch(() => {});
    });

    // Listen for PTY output — send command after first output (shell ready)
    const unlistenOutput = listen<string>(`pty-output-${tileId}`, (event) => {
      term.write(event.payload);
      if (!commandSent) sendCommand();
    });

    const unlistenExit = listen(`pty-exit-${tileId}`, () => {
      term.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
      updateStatus("exited");
    });

    // Listen for session stats updates
    const unlistenStats = listen<CopilotSessionStats>(`copilot-stats-${tileId}`, (event) => {
      onStatsUpdate?.(event.payload);
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        invoke("resize_pty", { tileId, rows: dims.rows, cols: dims.cols }).catch(() => {});
      }
    });
    resizeObserver.observe(containerRef.current);

    const saveInterval = setInterval(saveScrollback, 30_000);

    return () => {
      clearInterval(saveInterval);
      saveScrollback();
      invoke("unwatch_session", { tileId }).catch(() => {});
      resizeObserver.disconnect();
      unlistenOutput.then((u) => u());
      unlistenExit.then((u) => u());
      unlistenStats.then((u) => u());
      term.dispose();
    };
  }, [tileId]);

  useEffect(() => {
    if (isFocused && fitRef.current) {
      setTimeout(() => fitRef.current?.fit(), 50);
    }
  }, [isFocused]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}>
      {status === "resuming" && (
        <div style={{
          position: "absolute", top: 4, right: 4, zIndex: 10,
          background: "#313244", borderRadius: 4, padding: "4px 10px",
          fontSize: 11, color: "#f9e2af",
        }}>
          ⟳ Resuming session...
        </div>
      )}
      {status === "starting" && (
        <div style={{
          position: "absolute", top: 4, right: 4, zIndex: 10,
          background: "#313244", borderRadius: 4, padding: "4px 10px",
          fontSize: 11, color: "#a6e3a1",
        }}>
          ◉ Starting session...
        </div>
      )}
      <div ref={containerRef} style={{ width: "100%", height: "100%", overflow: "hidden" }} />
    </div>
  );
}
