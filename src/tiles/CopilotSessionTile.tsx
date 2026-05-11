import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseCopilotSessionConfig } from "../domain/tile-config";
import { playBell, notifySessionIdle } from "../domain/notifications";
import type { CopilotSessionStats } from "../domain/types";

interface Props {
  tileId: string;
  configJson: string;
  isFocused: boolean;
  isResuming: boolean;
  alreadyRunning?: boolean;
  workstreamId?: string;
  onStatusChange?: (status: string) => void;
  onStatsUpdate?: (stats: CopilotSessionStats) => void;
  onLinkSession?: () => void;
  onAutoLink?: (sessionId: string, summary?: string) => void;
  onRestart?: () => void;
}

export default function CopilotSessionTile({
  tileId,
  configJson,
  isFocused,
  isResuming,
  alreadyRunning,
  workstreamId,
  onStatusChange,
  onStatsUpdate,
  onLinkSession,
  onAutoLink,
  onRestart,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const prevActivityRef = useRef<string>("idle");
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

    // Register with the session stats poller — pass session_id if available
    const sessionId = config.copilot_session_id || null;
    invoke("watch_session", {
      tileId,
      sessionName: config.session_name,
      sessionId,
      workstreamId: workstreamId || null,
    }).catch(() => {});

    // Only restore scrollback if not already running (avoid duplicate restore messages)
    if (!alreadyRunning) {
      invoke<string | null>("load_scrollback", { tileId }).then((data) => {
        if (data) {
          term.write(data);
        }
      }).catch(() => {});
    }

    // Agency.exe is spawned directly by App.tsx — no need to send commands to shell
    updateStatus("running");

    // Forward keystrokes to PTY
    term.onData((data) => {
      invoke("write_to_pty", { tileId, data }).catch(() => {});
    });

    // Handle special key combos
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === "keyup") {
        if (ev.key === "Enter" && (ev.shiftKey || ev.ctrlKey)) return false;
        if (ev.key === "v" && ev.ctrlKey) return false;
        if (ev.key === "c" && ev.ctrlKey) return false;
        return true;
      }
      if (ev.type !== "keydown") return true;

      if (ev.key === "Enter" && (ev.shiftKey || ev.ctrlKey)) {
        ev.preventDefault();
        invoke("write_to_pty", { tileId, data: "\n" }).catch(() => {});
        return false;
      }

      // Ctrl+C: copy selection if text selected, otherwise send to PTY
      if (ev.key === "c" && ev.ctrlKey && !ev.shiftKey) {
        const selection = term.getSelection();
        if (selection) {
          ev.preventDefault();
          navigator.clipboard.writeText(selection).catch(() => {});
          return false;
        }
        // No selection — let xterm send \x03 to PTY
        return true;
      }

      if (ev.key === "v" && ev.ctrlKey && !ev.shiftKey) {
        ev.preventDefault();
        navigator.clipboard.readText().then((text) => {
          if (text) invoke("write_to_pty", { tileId, data: text }).catch(() => {});
        }).catch(() => {});
        return false;
      }

      if (ev.altKey) return false;

      return true;
    });

    // Handle BEL character — play notification sound + flash window
    term.onBell(() => {
      playBell();
    });

    // Listen for PTY output
    const unlistenOutput = listen<string>(`pty-output-${tileId}`, (event) => {
      term.write(event.payload);
    });

    const unlistenExit = listen(`pty-exit-${tileId}`, () => {
      term.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
      updateStatus("exited");
    });

    // Listen for session stats updates — auto-link if we detect a session
    const autoLinked = { done: false };
    const unlistenStats = listen<CopilotSessionStats>(`copilot-stats-${tileId}`, (event) => {
      onStatsUpdate?.(event.payload);

      // Detect active→idle transition → notify user
      const newActivity = event.payload.activity_status || "idle";
      const wasActive = ["thinking", "tool_use", "responding"].includes(prevActivityRef.current);
      const nowIdle = newActivity === "idle";
      if (wasActive && nowIdle) {
        const cfg = parseCopilotSessionConfig(configJson);
        notifySessionIdle(cfg.session_name || "Session");
      }
      prevActivityRef.current = newActivity;

      // Auto-link: if tile has no linked session and poller found one, link it
      if (!autoLinked.done && event.payload.session_id && onAutoLink) {
        const currentConfig = parseCopilotSessionConfig(configJson);
        if (!currentConfig.copilot_session_id) {
          autoLinked.done = true;
          onAutoLink(event.payload.session_id, event.payload.summary || undefined);
        }
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        invoke("resize_pty", { tileId, rows: dims.rows, cols: dims.cols }).catch(() => {});
      }
    });
    resizeObserver.observe(containerRef.current);

    // Mouse wheel handler: when alternate screen buffer is active (copilot TUI),
    // send scroll as arrow up/down to the PTY for smoother scrolling
    const wheelHandler = (e: WheelEvent) => {
      const buf = (term as unknown as { buffer: { active: { type: string } } }).buffer?.active;
      if (buf && buf.type === "alternate") {
        e.preventDefault();
        e.stopPropagation();
        const lines = Math.max(1, Math.round(Math.abs(e.deltaY) / 40));
        const arrow = e.deltaY < 0 ? "\x1b[A" : "\x1b[B"; // up : down
        invoke("write_to_pty", { tileId, data: arrow.repeat(lines) }).catch(() => {});
      }
    };
    const xtermScreen = containerRef.current.querySelector(".xterm-screen") as HTMLElement;
    const wheelTarget = xtermScreen || containerRef.current;
    wheelTarget.addEventListener("wheel", wheelHandler, { passive: false });

    const saveInterval = setInterval(saveScrollback, 30_000);

    return () => {
      clearInterval(saveInterval);
      containerRef.current?.removeEventListener("wheel", wheelHandler);
      xtermScreen?.removeEventListener("wheel", wheelHandler);
      saveScrollback();
      invoke("unwatch_session", { tileId }).catch(() => {});
      resizeObserver.disconnect();
      unlistenOutput.then((u) => u());
      unlistenExit.then((u) => u());
      unlistenStats.then((u) => u());
      term.dispose();
    };
  }, [tileId]);

  // Re-register with poller when config changes (e.g., after auto-link sets copilot_session_id)
  useEffect(() => {
    const cfg = parseCopilotSessionConfig(configJson);
    const sessionId = cfg.copilot_session_id || null;
    invoke("watch_session", {
      tileId,
      sessionName: cfg.session_name,
      sessionId,
      workstreamId: workstreamId || null,
    }).catch(() => {});
  }, [tileId, configJson, workstreamId]);

  useEffect(() => {
    if (isFocused && fitRef.current) {
      setTimeout(() => {
        fitRef.current?.fit();
        termRef.current?.focus();
      }, 50);
    }
  }, [isFocused]);

  const hasLinkedSession = !!(config.copilot_session_id || (config as unknown as Record<string, unknown>).resume_by_id);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}>
      {/* Session controls — top-right overlay */}
      <div style={{
        position: "absolute", top: 4, right: 4, zIndex: 10,
        display: "flex", gap: 4, alignItems: "center",
      }}>
        {status === "resuming" && (
          <span style={{
            background: "#313244", borderRadius: 4, padding: "4px 10px",
            fontSize: 11, color: "#f9e2af",
          }}>
            ⟳ Resuming...
          </span>
        )}
        {status === "starting" && (
          <span style={{
            background: "#313244", borderRadius: 4, padding: "4px 10px",
            fontSize: 11, color: "#a6e3a1",
          }}>
            ◉ Starting...
          </span>
        )}
        {/* Restart button — only when session has exited */}
        {status === "exited" && onRestart && (
          <button
            onClick={(e) => { e.stopPropagation(); onRestart(); }}
            style={{
              background: "#a6e3a1",
              color: "#1e1e2e",
              border: "none",
              borderRadius: 4,
              padding: "4px 10px",
              fontSize: 11,
              cursor: "pointer",
              fontWeight: 600,
            }}
            title="Restart the copilot session"
          >
            ▶ Restart
          </button>
        )}
        {/* Link session button — manual override for auto-link */}
        {onLinkSession && (
          <button
            onClick={(e) => { e.stopPropagation(); onLinkSession(); }}
            style={{
              background: "#313244",
              color: hasLinkedSession ? "#a6e3a1" : "#585b70",
              border: "none",
              borderRadius: 4,
              padding: "4px 10px",
              fontSize: 11,
              cursor: "pointer",
            }}
            title={hasLinkedSession ? `Linked: ${config.copilot_session_id || ""}` : "Link an existing Copilot session"}
          >
            {hasLinkedSession ? "🔗 Linked" : "🔗 Link"}
          </button>
        )}
      </div>
      <div ref={containerRef} onMouseEnter={() => termRef.current?.focus()} style={{ width: "100%", height: "100%", overflow: "hidden" }} />
    </div>
  );
}
