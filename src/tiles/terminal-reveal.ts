export interface RevealTerminalLike {
  cols: number;
  rows: number;
  refresh(start: number, end: number): void;
  _core?: {
    _charSizeService?: { measure?: () => void };
    _renderService?: { handleResize?: (cols: number, rows: number) => void };
  };
}

export interface RevealPtyFitLike {
  invalidate(): void;
  request(): void;
}

export interface RevealWebglLike {
  tryLoad(): void;
}

/**
 * Recover an xterm after an ancestor changes from display:none to visible.
 *
 * React's explicit workstream visibility is authoritative; browser observers
 * are only a fallback because WKWebView may coalesce display:none transitions.
 * The first pass runs after layout, and the second after FitAddon's debounce
 * has settled. The returned cleanup cancels both passes on a rapid switch.
 */
export function scheduleTerminalRevealRecovery(opts: {
  terminal: RevealTerminalLike;
  ptyFit: RevealPtyFitLike;
  webgl: RevealWebglLike;
  getContainer: () => Pick<HTMLElement, "offsetWidth" | "offsetHeight"> | null;
  settleMs?: number;
  retryMs?: number;
  maxUnsizedRetries?: number;
}): () => void {
  const settleMs = opts.settleMs ?? 200;
  const retryMs = opts.retryMs ?? 150;
  const maxUnsizedRetries = opts.maxUnsizedRetries ?? 4;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsizedRetries = 0;

  let recover: () => boolean;
  const recoverThenSettle = () => {
    if (recover()) timer = setTimeout(recover, settleMs);
  };

  recover = () => {
    if (disposed) return false;
    const container = opts.getContainer();
    if (!container || container.offsetWidth <= 0 || container.offsetHeight <= 0) {
      if (unsizedRetries < maxUnsizedRetries) {
        unsizedRetries += 1;
        timer = setTimeout(recoverThenSettle, retryMs);
      }
      return false;
    }
    unsizedRetries = 0;
    opts.webgl.tryLoad();
    try {
      opts.terminal._core?._charSizeService?.measure?.();
    } catch {
      // Best effort: public fit/refresh below still recover most renderers.
    }
    opts.ptyFit.invalidate();
    opts.ptyFit.request();
    if (opts.terminal.rows > 0) {
      try {
        opts.terminal._core?._renderService?.handleResize?.(
          opts.terminal.cols,
          opts.terminal.rows,
        );
      } catch {
        // Best effort: refresh remains useful if the private hook changes.
      }
      opts.terminal.refresh(0, opts.terminal.rows - 1);
    }
    return true;
  };

  const raf = requestAnimationFrame(() => {
    if (disposed) return;
    recoverThenSettle();
  });

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    if (timer !== null) clearTimeout(timer);
  };
}
