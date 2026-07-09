/**
 * WebGL renderer controller for the xterm terminals.
 *
 * The session/terminal tiles run xterm's DOM renderer by default, which is the
 * slowest path and janks under heavy output. Loading `@xterm/addon-webgl` moves
 * glyph rendering to the GPU. But several things make naive loading unsafe in
 * this app:
 *
 *  - **persist-by-hide**: inactive workstreams keep their tiles mounted but
 *    `display:none`. A WebGL context created (or living) on a 0-size / hidden
 *    canvas can fail to initialize or get lost. So we only load when the
 *    container is actually visible and sized, and we re-try on reveal.
 *  - **context loss**: the GPU can drop a WebGL context (driver reset, memory
 *    pressure, tab backgrounding, too many live contexts). xterm's WebglAddon
 *    exposes `onContextLoss`; on loss we dispose the addon (xterm then falls
 *    back to its DOM renderer) and:
 *      1. call `onContextLoss` so the host can force a repaint immediately —
 *         without this the canvas can stay **black** until some other event
 *         triggers a redraw, which is the "black terminal that never recovers"
 *         bug;
 *      2. count the loss, and after `maxContextLosses` **give up** on WebGL for
 *         this controller and stay on the DOM renderer permanently (the DOM
 *         renderer never goes black). This stops a wedged GPU context from
 *         being re-created over and over into the same black state.
 *  - **user opt-out**: a global setting can force the DOM renderer (`isDisabled`).
 *    Used as an escape hatch / diagnostic. `unload()` drops a live addon when
 *    the user flips the setting on without tearing the controller down, so a
 *    later flip-off can `tryLoad()` again.
 *
 * The addon is injected via `createAddon` so this is unit-testable without a
 * real WebGL context (mirrors how `pty-fit.ts` is extracted and tested).
 */

export interface WebglAddonLike {
  onContextLoss(cb: () => void): void;
  dispose(): void;
}

export interface WebglController {
  /**
   * Load the WebGL addon if the container is visible + sized, WebGL isn't
   * disabled, we haven't given up after repeated context losses, and it isn't
   * already loaded. Safe to call repeatedly (idempotent while loaded); call it
   * on first mount and again whenever the tile becomes visible.
   */
  tryLoad(): void;
  /**
   * Dispose a live addon but keep the controller usable, so a later `tryLoad()`
   * can re-create it. Used when the user toggles the "disable GPU rendering"
   * setting on. No-op when nothing is loaded.
   */
  unload(): void;
  /** Dispose the addon (if any) and prevent further loads. */
  dispose(): void;
  /** True while the WebGL addon is currently loaded. */
  isLoaded(): boolean;
  /**
   * True once WebGL has been abandoned after `maxContextLosses` context losses.
   * The controller then stays on the DOM renderer for the rest of its life.
   */
  hasGivenUp(): boolean;
}

/** Default number of GPU context losses tolerated before abandoning WebGL. */
export const DEFAULT_MAX_CONTEXT_LOSSES = 3;

export function createWebglController(opts: {
  /** Factory for the addon (tiles pass `() => new WebglAddon()`). */
  createAddon: () => WebglAddonLike;
  /** Loads the addon into the terminal (tiles pass `(a) => term.loadAddon(a)`). */
  loadAddon: (addon: WebglAddonLike) => void;
  /** The terminal's container element (used to gate on visibility + size). */
  getContainer: () => HTMLElement | null;
  /**
   * Called right after a context loss (post-dispose, DOM renderer now active)
   * so the host can force a fallback repaint (e.g. `term.refresh(...)`). This
   * is what stops the terminal from staying black after a GPU context drop.
   */
  onContextLoss?: () => void;
  /**
   * When it returns true, WebGL is never loaded (the DOM renderer is forced).
   * Wired to the global "disable GPU rendering" setting. Checked on every
   * `tryLoad()`, so flipping the setting off then calling `tryLoad()` re-enables.
   */
  isDisabled?: () => boolean;
  /**
   * How many context losses to tolerate before abandoning WebGL permanently for
   * this controller. Defaults to {@link DEFAULT_MAX_CONTEXT_LOSSES}.
   */
  maxContextLosses?: number;
}): WebglController {
  const maxLosses = Math.max(1, opts.maxContextLosses ?? DEFAULT_MAX_CONTEXT_LOSSES);
  let addon: WebglAddonLike | null = null;
  let disposed = false;
  let gaveUp = false;
  let lossCount = 0;

  const unloadAddon = (): void => {
    if (addon) {
      try {
        addon.dispose();
      } catch {
        /* ignore */
      }
      addon = null;
    }
  };

  return {
    tryLoad() {
      if (disposed || gaveUp || addon) return;
      // User opt-out / permanent DOM renderer.
      if (opts.isDisabled?.()) return;
      const el = opts.getContainer();
      // Skip while hidden/unsized — a WebGL context on a 0-size canvas is
      // unreliable. The reveal path calls tryLoad again once it has size.
      if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;

      let created: WebglAddonLike;
      try {
        created = opts.createAddon();
      } catch {
        // WebGL2 unavailable — stay on the DOM renderer.
        return;
      }
      try {
        created.onContextLoss(() => {
          // Dispose so xterm falls back to the DOM renderer.
          try {
            created.dispose();
          } catch {
            /* ignore */
          }
          // Let the DOM renderer take over and allow a later tryLoad() to
          // re-create the addon when the tile is shown again.
          if (addon === created) addon = null;
          lossCount += 1;
          // After too many losses, abandon WebGL entirely — re-creating it into
          // a wedged GPU state just reproduces the black screen.
          if (lossCount >= maxLosses) gaveUp = true;
          // Force the host to repaint now that the DOM renderer is active, so
          // the terminal doesn't stay black until the next incidental redraw.
          try {
            opts.onContextLoss?.();
          } catch {
            /* ignore */
          }
        });
        opts.loadAddon(created);
        addon = created;
      } catch {
        try {
          created.dispose();
        } catch {
          /* ignore */
        }
        addon = null;
      }
    },
    unload() {
      unloadAddon();
    },
    dispose() {
      disposed = true;
      unloadAddon();
    },
    isLoaded() {
      return addon !== null;
    },
    hasGivenUp() {
      return gaveUp;
    },
  };
}
