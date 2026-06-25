/**
 * WebGL renderer controller for the xterm terminals.
 *
 * The session/terminal tiles run xterm's DOM renderer by default, which is the
 * slowest path and janks under heavy output. Loading `@xterm/addon-webgl` moves
 * glyph rendering to the GPU. But two things make naive loading unsafe in this
 * app:
 *
 *  - **persist-by-hide**: inactive workstreams keep their tiles mounted but
 *    `display:none`. A WebGL context created (or living) on a 0-size / hidden
 *    canvas can fail to initialize or get lost. So we only load when the
 *    container is actually visible and sized, and we re-try on reveal.
 *  - **context loss**: the GPU can drop a WebGL context (driver reset, memory
 *    pressure, tab backgrounding). xterm's WebglAddon exposes `onContextLoss`;
 *    on loss we dispose the addon (xterm then falls back to its DOM renderer so
 *    rendering keeps working) and allow a later `tryLoad()` to re-create it.
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
   * Load the WebGL addon if the container is visible + sized and it isn't
   * already loaded. Safe to call repeatedly (idempotent while loaded); call it
   * on first mount and again whenever the tile becomes visible.
   */
  tryLoad(): void;
  /** Dispose the addon (if any) and prevent further loads. */
  dispose(): void;
  /** True while the WebGL addon is currently loaded. */
  isLoaded(): boolean;
}

export function createWebglController(opts: {
  /** Factory for the addon (tiles pass `() => new WebglAddon()`). */
  createAddon: () => WebglAddonLike;
  /** Loads the addon into the terminal (tiles pass `(a) => term.loadAddon(a)`). */
  loadAddon: (addon: WebglAddonLike) => void;
  /** The terminal's container element (used to gate on visibility + size). */
  getContainer: () => HTMLElement | null;
}): WebglController {
  let addon: WebglAddonLike | null = null;
  let disposed = false;

  return {
    tryLoad() {
      if (disposed || addon) return;
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
          try {
            created.dispose();
          } catch {
            /* ignore */
          }
          // Let the DOM renderer take over and allow a later tryLoad() to
          // re-create the addon when the tile is shown again.
          if (addon === created) addon = null;
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
    dispose() {
      disposed = true;
      if (addon) {
        try {
          addon.dispose();
        } catch {
          /* ignore */
        }
        addon = null;
      }
    },
    isLoaded() {
      return addon !== null;
    },
  };
}
