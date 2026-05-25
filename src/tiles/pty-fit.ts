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
 *   - Rejects implausibly tiny `cols` for a wide container (the signature of
 *     stale CharSizeService measurement right after display:none → visible)
 *     and schedules a delayed retry so the next fit can pick up the correct
 *     cell metrics.
 *
 * @param debounceMs idle window before flushing a resize (default 80ms).
 */
export function createPtyFitController(opts: {
  tileId: string;
  fitAddon: FitAddon;
  getContainer: () => HTMLElement | null;
  debounceMs?: number;
  /** Container px width below which "tiny cols" are accepted as genuine. */
  narrowContainerPx?: number;
  /** Cols threshold under which dims are treated as suspicious when container is wide. */
  minPlausibleCols?: number;
  /** Delay before retrying after a rejected fit (gives CharSizeService time to remeasure). */
  retryMs?: number;
}): PtyFitController {
  const {
    tileId,
    fitAddon,
    getContainer,
    debounceMs = 80,
    narrowContainerPx = 400,
    minPlausibleCols = 20,
    retryMs = 350,
  } = opts;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let rafId: number | null = null;
  let last: { cols: number; rows: number } | null = null;
  let disposed = false;

  const scheduleRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (disposed) return;
      // Use the public request path so the same debounce/rAF settling applies.
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, 0);
    }, retryMs);
  };

  const flush = () => {
    timer = null;
    if (disposed) return;
    const el = getContainer();
    if (!el || el.offsetWidth === 0) return;
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
      // Stale-measurement guard: a wide container that proposes a tiny cols
      // count is almost certainly a stale CharSizeService measurement from a
      // just-revealed display:none element. Reject and retry shortly so the
      // next fit can pick up the real cell metrics.
      if (el2.offsetWidth >= narrowContainerPx && dims.cols < minPlausibleCols) {
        scheduleRetry();
        return;
      }
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
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (rafId !== null) cancelAnimationFrame(rafId);
      timer = null;
      retryTimer = null;
      rafId = null;
    },
  };
}
