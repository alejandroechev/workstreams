import type { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";

export interface PtyFitController {
  /** Request a fit + resize_pty. Coalesces rapid calls and skips when dims are unchanged. */
  request(): void;
  /** Last cols/rows sent to the PTY, or null if nothing sent yet. */
  lastDims(): { cols: number; rows: number } | null;
  /** Force-send next dims regardless of cache (e.g. after font-size change). */
  invalidate(): void;
  dispose(): void;
}

/**
 * Builds a debounced fit controller that:
 *   - Only fits when the container is laid out (offsetWidth > 0).
 *   - Coalesces rapid resize bursts with a small debounce window.
 *   - Skips the resize_pty invoke when (cols, rows) haven't changed since the
 *     last successful call. This is critical for TUIs like Copilot CLI that
 *     redraw spinners on every SIGWINCH using cursor-up sequences: a spurious
 *     same-size resize during a visibility flip causes the previous frame's
 *     cursor moves to land on a re-flowed buffer and leaves stale glyphs.
 *
 * @param debounceMs idle window before flushing a resize (default 80ms).
 */
export function createPtyFitController(opts: {
  tileId: string;
  fitAddon: FitAddon;
  getContainer: () => HTMLElement | null;
  debounceMs?: number;
}): PtyFitController {
  const { tileId, fitAddon, getContainer, debounceMs = 80 } = opts;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rafId: number | null = null;
  let last: { cols: number; rows: number } | null = null;
  let disposed = false;

  const flush = () => {
    timer = null;
    if (disposed) return;
    const el = getContainer();
    if (!el || el.offsetWidth === 0) return;
    // Use rAF so the layout is settled (visibility flips often fire ResizeObserver
    // before the parent flexbox has reflowed).
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (disposed) return;
      const el2 = getContainer();
      if (!el2 || el2.offsetWidth === 0) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      const dims = fitAddon.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
      if (dims.cols <= 0 || dims.rows <= 0) return;
      if (last && last.cols === dims.cols && last.rows === dims.rows) {
        return;
      }
      last = { cols: dims.cols, rows: dims.rows };
      invoke("resize_pty", { tileId, rows: dims.rows, cols: dims.cols }).catch(() => {});
    });
  };

  return {
    request() {
      if (disposed) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    },
    lastDims() {
      return last;
    },
    invalidate() {
      last = null;
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      if (rafId !== null) cancelAnimationFrame(rafId);
      timer = null;
      rafId = null;
    },
  };
}
