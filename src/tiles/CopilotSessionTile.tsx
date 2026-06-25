// @test-skip: xterm.js + copilot session wrapper, validated end-to-end via CDP
import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseCopilotSessionConfig } from "../domain/tile-config";
import { createPtyFitController } from "./pty-fit";
import { createWebglController } from "./webgl-renderer";
import { getAppSettings, subscribeAppSettings, createWheelLineAccumulator } from "../domain/app-settings";
import { writeTextToClipboard, readTextFromClipboard } from "../domain/clipboard";
import { handleOsc52 } from "../domain/osc52";
import { playBell, notifySessionIdle } from "../domain/notifications";
import type { CopilotSessionStats } from "../domain/types";

interface Props {
  tileId: string;
  configJson: string;
  isFocused: boolean;
  /** Bumped on workstream switch so we re-focus even when isFocused didn't change. */
  focusToken?: number;
  isResuming: boolean;
  alreadyRunning?: boolean;
  workstreamId?: string;
  onStatusChange?: (status: string) => void;
  onStatsUpdate?: (stats: CopilotSessionStats) => void;
  onLinkSession?: () => void;
  /** When true the workstream already has another linked session, so this
   * tile must not allow linking (workstream → at most one linked session). */
  workstreamHasOtherLinkedSession?: boolean;
  /** True when this tile is the fullscreen tile in its grid. Triggers a
   * forced char-size remeasure + buffer repaint when it changes, so the
   * canvas renderer doesn't end up showing ghost/duplicate rows after the
   * geometry jumps (the ResizeObserver fires fit + resize_pty, but the
   * texture atlas can hold stale glyph metrics across a large size change,
   * especially in the alternate buffer that Copilot CLI uses). */
  isFullscreen?: boolean;
  onAutoLink?: (sessionId: string, summary?: string) => void;
  onRestart?: () => void;
}

export default function CopilotSessionTile({
  tileId,
  configJson,
  isFocused,
  focusToken,
  isResuming,
  alreadyRunning,
  workstreamId,
  onStatusChange,
  onStatsUpdate,
  onLinkSession,
  workstreamHasOtherLinkedSession,
  isFullscreen = false,
  onAutoLink,
  onRestart,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyFitRef = useRef<ReturnType<typeof createPtyFitController> | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const webglRef = useRef<ReturnType<typeof createWebglController> | null>(null);
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

    // GPU-accelerated rendering via the WebGL addon. Loaded through a
    // controller that only initialises when the container is visible+sized
    // (persist-by-hide leaves inactive tiles at 0×0) and that gracefully falls
    // back to the DOM renderer on WebGL context loss, re-creating on reveal.
    const webgl = createWebglController({
      createAddon: () => new WebglAddon(),
      loadAddon: (addon) => term.loadAddon(addon as unknown as Parameters<typeof term.loadAddon>[0]),
      getContainer: () => containerRef.current,
    });
    webglRef.current = webgl;
    webgl.tryLoad();

    // Expose terminal instance on container for dev/E2E probes.
    (containerRef.current as unknown as { __wsTerm?: unknown }).__wsTerm = term;

    // Focus terminal after initialization (with delay for DOM readiness)
    setTimeout(() => term.focus(), 150);

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
          writeTextToClipboard(selection).catch(() => {});
          return false;
        }
        // No selection — let xterm send \x03 to PTY
        return true;
      }

      if (ev.key === "v" && ev.ctrlKey && !ev.shiftKey) {
        ev.preventDefault();
        readTextFromClipboard().then((text) => {
          if (text) invoke("write_to_pty", { tileId, data: text }).catch(() => {});
        }).catch(() => {});
        return false;
      }

      if (ev.altKey) return false;

      return true;
    });

    // Handle BEL character — play notification sound + raise the sidebar
    // bell on the workstream row (only for Copilot session tiles; the
    // sidebar listener ignores the event when the workstream is focused).
    term.onBell(() => {
      playBell();
      if (workstreamId) {
        window.dispatchEvent(new CustomEvent("workstream-bell", { detail: { workstreamId } }));
      }
    });

    // Handle OSC 52 — TUI apps (copilot CLI, vim, tmux) emit this to put
    // text on the host clipboard. Without a handler, xterm.js silently
    // drops it and the user's "Copying to clipboard" never lands.
    const oscDisposable = term.parser.registerOscHandler(52, (data) => {
      void handleOsc52(data);
      return true;
    });

    // Listen for PTY output
    const unlistenOutput = listen<string>(`pty-output-${tileId}`, (event) => {
      term.write(event.payload);
    });

    const unlistenExit = listen(`pty-exit-${tileId}`, () => {
      const intentional = (window as unknown as { __wsIntentionalRestartIds?: Set<string> })
        .__wsIntentionalRestartIds?.has(tileId) ?? false;
      if (intentional) {
        term.write("\r\n\x1b[90m[Restarting…]\x1b[0m\r\n");
        (window as unknown as { __wsIntentionalRestartIds?: Set<string> })
          .__wsIntentionalRestartIds?.delete(tileId);
      } else {
        term.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
      }
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

      // Auto-link: if tile has no linked session and poller found one, link it.
      // Skip when the workstream already has another linked session (enforced
      // one-session-per-workstream policy).
      if (!autoLinked.done && event.payload.session_id && onAutoLink && !workstreamHasOtherLinkedSession) {
        const currentConfig = parseCopilotSessionConfig(configJson);
        if (!currentConfig.copilot_session_id) {
          autoLinked.done = true;
          onAutoLink(event.payload.session_id, event.payload.summary || undefined);
        }
      }
    });

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

    // Persist-by-hide (display: none on inactive workstreams) leaves this
    // container at 0 dimensions while hidden. ResizeObserver doesn't always
    // fire when display flips none → flex. Watch visibility explicitly and
    // re-fit when the tile becomes visible.
    // After the fit, force a full buffer repaint — xterm's canvas renderer
    // caches glyphs in a texture atlas that can go stale when the element
    // was display:none. Without this, the user sees a blank or partially-
    // drawn terminal until something else triggers a redraw (e.g. Enter).
    const visibilityObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          // Now that the tile is visible+sized, (re)load WebGL if it never
          // initialised while hidden or its context was lost.
          webgl.tryLoad();
          // Force xterm to remeasure cell metrics — when this element was
          // display:none, CharSizeService cached zero/stale cell dimensions
          // and the next fit would propose a tiny cols/rows pair (cols≈11)
          // which then gets shipped to the PTY and sticks.
          try {
            const core = (term as unknown as {
              _core?: { _charSizeService?: { measure?: () => void } };
            })._core;
            core?._charSizeService?.measure?.();
          } catch { /* best effort */ }
          ptyFit.invalidate();
          ptyFit.request();
          // Schedule a second fit + repaint after the fit controller's debounce
          // + rAF settles, in case the first fit still ran with stale metrics.
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
    // In normal-buffer mode: xterm v6 uses a Monaco-style virtual scroll element
    //   (overflow: visible), so native wheel doesn't scroll the buffer. We must
    //   call term.scrollLines() ourselves.
    // In alternate-buffer mode (copilot TUI): translate to PgUp/PgDn for the PTY.
    //   Arrow keys move the cursor in agency's input box (not what we want);
    //   PgUp/PgDn are what agency uses to scroll conversation history.
    // Scroll speed is controlled by app setting `terminalScrollSpeed`.
    const wheelAcc = createWheelLineAccumulator(() => getAppSettings().terminalScrollSpeed);
    const wheelHandler = (e: WheelEvent) => {
      const buf = (term as unknown as { buffer: { active: { type: string } } }).buffer?.active;
      const lines = wheelAcc(e.deltaY);
      e.preventDefault();
      if (lines === 0) return;
      if (buf && buf.type === "alternate") {
        // \x1b[5~ = PgUp, \x1b[6~ = PgDn
        const seq = lines < 0 ? "\x1b[5~" : "\x1b[6~";
        invoke("write_to_pty", { tileId, data: seq.repeat(Math.abs(lines)) }).catch(() => {});
        return;
      }
      term.scrollLines(lines);
    };
    const wheelTarget =
      (containerRef.current.querySelector(".xterm-scrollable-element") as HTMLElement | null) ??
      (containerRef.current.querySelector(".xterm-screen") as HTMLElement | null) ??
      containerRef.current;
    wheelTarget.addEventListener("wheel", wheelHandler, { passive: false });

    const saveInterval = setInterval(saveScrollback, 30_000);

    return () => {
      clearInterval(saveInterval);
      wheelTarget.removeEventListener("wheel", wheelHandler);
      saveScrollback();
      invoke("unwatch_session", { tileId }).catch(() => {});
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      ptyFit.dispose();
      ptyFitRef.current = null;
      webgl.dispose();
      webglRef.current = null;
      unlistenOutput.then((u) => u());
      unlistenExit.then((u) => u());
      unlistenStats.then((u) => u());
      oscDisposable?.dispose?.();
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
    if (!isFocused) return;
    const focusNow = () => {
      fitRef.current?.fit();
      const term = termRef.current;
      if (term) {
        term.focus();
        // Force full buffer repaint on re-focus (covers app-switch / ws-switch
        // where the canvas texture atlas may have gone stale).
        if (term.rows > 0) term.refresh(0, term.rows - 1);
      }
      const textarea = containerRef.current?.querySelector(
        ".xterm-helper-textarea",
      ) as HTMLTextAreaElement | null;
      textarea?.focus();
    };
    // Single deferred focus — was previously 4 staggered timers (50, 150, 300,
    // 600 ms), which under rapid ws-switches piled up redundant term.refresh()
    // full-buffer repaints. One frame is enough in practice; if layout has
    // not settled by then the next render's effect re-runs with a fresh token.
    const timer = window.setTimeout(focusNow, 50);
    return () => clearTimeout(timer);
  }, [isFocused, focusToken]);

  // Force xterm to remeasure cell metrics + repaint the buffer whenever the
  // fullscreen state of this tile changes. The geometry jump from a small
  // grid cell to the full window (or back) leaves the canvas renderer's
  // texture atlas pointing at stale cell offsets, which manifests as
  // selection picking the wrong characters and ghost/duplicate rows
  // appearing on text selection. ResizeObserver already triggers a fit +
  // resize_pty, but that path doesn't invalidate the atlas; we do it here.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    // Two-pass: immediate + after a settle delay so the deferred fit lands
    // with the correct cell metrics before the second refresh.
    const remeasureAndRepaint = () => {
      try {
        const core = (term as unknown as {
          _core?: { _charSizeService?: { measure?: () => void } };
        })._core;
        core?._charSizeService?.measure?.();
      } catch { /* best effort */ }
      ptyFitRef.current?.invalidate();
      ptyFitRef.current?.request();
      if (term.rows > 0) {
        try {
          (term as unknown as {
            _core?: { _renderService?: { handleResize(c: number, r: number): void } };
          })._core?._renderService?.handleResize(term.cols, term.rows);
        } catch { /* best effort */ }
        term.refresh(0, term.rows - 1);
      }
    };
    remeasureAndRepaint();
    const t = window.setTimeout(remeasureAndRepaint, 200);
    return () => window.clearTimeout(t);
  }, [isFullscreen]);

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
        {/* Link session button — manual override for auto-link.
            States:
              - linked        : "🔗 Linked"
              - spawned, not linked yet (auto-link pending): "🔗 New"
              - not spawned   : "🔗 Link" */}
        {onLinkSession && !(workstreamHasOtherLinkedSession && !hasLinkedSession) && (
          <button
            onClick={(e) => { e.stopPropagation(); onLinkSession(); }}
            style={{
              background: "#313244",
              color: hasLinkedSession ? "#a6e3a1" : alreadyRunning ? "#f9e2af" : "#585b70",
              border: "none",
              borderRadius: 4,
              padding: "4px 10px",
              fontSize: 11,
              cursor: "pointer",
            }}
            title={
              hasLinkedSession
                ? `Linked: ${config.copilot_session_id || ""}`
                : alreadyRunning
                  ? "New session — type a prompt to identify it. Link will attach automatically."
                  : "Link an existing Copilot session"
            }
          >
            {hasLinkedSession ? "🔗 Linked" : alreadyRunning ? "🔗 New" : "🔗 Link"}
          </button>
        )}
      </div>
      <div ref={containerRef} onMouseDown={() => termRef.current?.focus()} style={{ width: "100%", height: "100%", overflow: "hidden" }} />
    </div>
  );
}
