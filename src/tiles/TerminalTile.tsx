// @test-skip: xterm.js wrapper, validated end-to-end via CDP focus-scroll-repro
import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { playBell, flashWindow } from "../domain/notifications";
import { createPtyFitController } from "./pty-fit";
import { getAppSettings, subscribeAppSettings, createWheelLineAccumulator } from "../domain/app-settings";
import { writeTextToClipboard, readTextFromClipboard } from "../domain/clipboard";
import { handleOsc52 } from "../domain/osc52";

interface Props {
  tileId: string;
  isFocused: boolean;
  /** Bumped on workstream switch so we re-focus even when isFocused didn't change. */
  focusToken?: number;
  onStatusChange?: (status: string) => void;
}

export default function TerminalTile({ tileId, isFocused, focusToken, onStatusChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyFitRef = useRef<ReturnType<typeof createPtyFitController> | null>(null);
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
      fontSize: getAppSettings().terminalFontSize,
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

    // Expose terminal instance on container for dev/E2E probes.
    (containerRef.current as unknown as { __wsTerm?: unknown }).__wsTerm = term;

    // Focus terminal after initialization
    setTimeout(() => term.focus(), 150);

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
        if (ev.key === "c" && ev.ctrlKey) return false;
        return true;
      }
      if (ev.type !== "keydown") return true;

      // Shift+Enter / Ctrl+Enter: send newline
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
          writeTextToClipboard(selection).catch(() => {});
          return false;
        }
        return true;
      }

      // Ctrl+V: paste from clipboard
      if (ev.key === "v" && ev.ctrlKey && !ev.shiftKey) {
        ev.preventDefault();
        readTextFromClipboard().then((text) => {
          if (text) invoke("write_to_pty", { tileId, data: text }).catch(() => {});
        }).catch(() => {});
        return false;
      }

      // Alt+ combos: let them bubble to the app-level handler
      if (ev.altKey) return false;

      return true;
    });

    // Handle BEL character — play sound + flash taskbar
    term.onBell(() => {
      playBell();
      flashWindow();
    });

    // OSC 52 — host clipboard set requests from TUI apps.
    const oscDisposable = term.parser.registerOscHandler(52, (data) => {
      void handleOsc52(data);
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

    // Handle resize. Coalesced + dedup'd via the shared PTY-fit controller:
    // skips invoke when cols/rows haven't changed (a same-size SIGWINCH on
    // visibility flips causes Copilot CLI to misplace its TUI spinner output).
    const ptyFit = createPtyFitController({
      tileId,
      fitAddon,
      getContainer: () => containerRef.current,
    });
    ptyFitRef.current = ptyFit;
    const resizeObserver = new ResizeObserver(() => {
      ptyFit.request();
    });
    resizeObserver.observe(containerRef.current);

    // ResizeObserver doesn't always fire when display flips none→flex on the
    // parent wrapper, so observe visibility explicitly and re-fit then.
    // After the fit, force a full buffer repaint — xterm's canvas renderer
    // caches glyphs in a texture atlas that can go stale when the element
    // was display:none. Without this, the user sees a blank or partially-
    // drawn terminal until something else triggers a redraw (e.g. Enter).
    const visibilityObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          try {
            const core = (term as unknown as {
              _core?: { _charSizeService?: { measure?: () => void } };
            })._core;
            core?._charSizeService?.measure?.();
          } catch { /* best effort */ }
          ptyFit.invalidate();
          ptyFit.request();
          setTimeout(() => {
            try {
              const core = (term as unknown as {
                _core?: { _charSizeService?: { measure?: () => void } };
              })._core;
              core?._charSizeService?.measure?.();
            } catch { /* best effort */ }
            ptyFit.invalidate();
            ptyFit.request();
            if (term.rows > 0) {
              try { (term as unknown as { _core?: { _renderService?: { handleResize(c: number, r: number): void } } })._core?._renderService?.handleResize(term.cols, term.rows); } catch { /* best effort */ }
              term.refresh(0, term.rows - 1);
            }
          }, 150);
        }
      }
    }, { threshold: 0.01 });
    visibilityObserver.observe(containerRef.current);

    // Mouse wheel handler.
    // In normal-buffer mode: xterm v6 no longer scrolls natively because it
    //   switched to a Monaco-style virtual scroll model on .xterm-scrollable-element
    //   (overflow: visible). We must drive the scroll ourselves via term.scrollLines.
    // In alternate-buffer mode (TUI apps): translate to arrow keys for the PTY.
    // Scroll speed is controlled by app setting `terminalScrollSpeed`.
    const wheelAcc = createWheelLineAccumulator(() => getAppSettings().terminalScrollSpeed);
    const wheelHandler = (e: WheelEvent) => {
      const buf = (term as unknown as { buffer: { active: { type: string } } }).buffer?.active;
      const lines = wheelAcc(e.deltaY);
      e.preventDefault();
      if (lines === 0) return;
      if (buf && buf.type === "alternate") {
        const arrow = lines < 0 ? "\x1b[A" : "\x1b[B";
        invoke("write_to_pty", { tileId, data: arrow.repeat(Math.abs(lines)) }).catch(() => {});
        return;
      }
      term.scrollLines(lines);
    };
    // Attach to the new .xterm-scrollable-element (xterm v6) so the event is
    // captured before any internal listener gets it. Fall back to legacy
    // selectors so the code still works if xterm changes structure again.
    const wheelTarget =
      (containerRef.current.querySelector(".xterm-scrollable-element") as HTMLElement | null) ??
      (containerRef.current.querySelector(".xterm-screen") as HTMLElement | null) ??
      containerRef.current;
    wheelTarget.addEventListener("wheel", wheelHandler, { passive: false });

    // Periodic scrollback save (every 30s)
    const saveInterval = setInterval(saveScrollback, 30_000);

    return () => {
      clearInterval(saveInterval);
      saveScrollback();
      wheelTarget.removeEventListener("wheel", wheelHandler);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      ptyFit.dispose();
      ptyFitRef.current = null;
      unlistenOutput.then((u) => u());
      unlistenExit.then((u) => u());
      oscDisposable?.dispose?.();
      term.dispose();
    };
  }, [tileId, saveScrollback, updateStatus]);

  // Refit + focus when focused, OR when the focus token bumps (workstream
  // switched back to this tile's workstream without isFocused changing).
  useEffect(() => {
    if (!isFocused) return;
    const focusNow = () => {
      fitRef.current?.fit();
      const term = termRef.current;
      if (term) {
        term.focus();
        if (term.rows > 0) term.refresh(0, term.rows - 1);
      }
      const textarea = containerRef.current?.querySelector(
        ".xterm-helper-textarea",
      ) as HTMLTextAreaElement | null;
      textarea?.focus();
    };
    // Single deferred focus — was previously 4 staggered timers (50, 150,
    // 300, 600 ms) which under rapid ws-switches stacked redundant full-
    // buffer term.refresh() calls. One frame is enough; the effect re-runs
    // on the next focusToken bump if it didn't stick.
    const timer = window.setTimeout(focusNow, 50);
    return () => clearTimeout(timer);
  }, [isFocused, focusToken]);

  // Apply font-size changes to xterm + re-fit + tell the PTY about the
  // new cell grid. Idempotent: if the term hasn't been initialised yet
  // Live font-size updates from the global terminal font setting.
  useEffect(() => {
    return subscribeAppSettings((s) => {
      const term = termRef.current;
      if (!term) return;
      if (term.options.fontSize !== s.terminalFontSize) {
        term.options.fontSize = s.terminalFontSize;
        ptyFitRef.current?.invalidate();
        ptyFitRef.current?.request();
      }
    });
  }, []);

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
        onMouseDown={() => {
          // Focus the xterm textarea on intentional click so typing goes
          // to the terminal. Hover does NOT focus (that was the cause of
          // accidental focus stealing between session+terminal tiles).
          termRef.current?.focus();
        }}
        style={{ width: "100%", height: "100%", overflow: "hidden" }}
      />
    </div>
  );
}
