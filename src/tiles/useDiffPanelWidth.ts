import { useCallback, useRef, useState } from "react";
import type React from "react";
import {
  DEFAULT_DIFF_PANEL_WIDTH,
  clampDiffPanelWidth,
  loadDiffPanelWidth,
  saveDiffPanelWidth,
} from "./diff-panel-width";

const KEY_STEP = 20;

/**
 * Drag-to-resize state for the Repo Explorer diff view's file list. The
 * divider captures the pointer, so the Monaco editor under it can't steal the
 * drag; double-click restores the default; arrow keys nudge it.
 */
export function useDiffPanelWidth() {
  const [width, setWidth] = useState(loadDiffPanelWidth);
  const widthRef = useRef(width);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const apply = useCallback((next: number, persist: boolean) => {
    const containerWidth = containerRef.current?.getBoundingClientRect().width ?? 0;
    const clamped = clampDiffPanelWidth(next, containerWidth);
    widthRef.current = clamped;
    setWidth(clamped);
    if (persist) saveDiffPanelWidth(clamped);
  }, []);

  const dividerProps: React.HTMLAttributes<HTMLDivElement> & { "data-testid": string } = {
    "data-testid": "diff-panel-divider",
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize changed files list",
    "aria-valuenow": width,
    tabIndex: 0,
    title: "Drag to resize · double-click to reset",
    onPointerDown: (e) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const left = containerRef.current?.getBoundingClientRect().left ?? 0;
      apply(e.clientX - left, false);
    },
    onPointerUp: (e) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      saveDiffPanelWidth(widthRef.current);
    },
    onDoubleClick: () => apply(DEFAULT_DIFF_PANEL_WIDTH, true),
    onKeyDown: (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      apply(widthRef.current + (e.key === "ArrowRight" ? KEY_STEP : -KEY_STEP), true);
    },
  };

  return { width, containerRef, dividerProps };
}
