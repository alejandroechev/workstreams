import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  MagnifyingGlassPlusIcon,
  MagnifyingGlassMinusIcon,
  ArrowsPointingOutIcon,
} from "@heroicons/react/24/outline";

interface Props {
  src: string;
  alt?: string;
  /** Optional testid forwarded to the scroll container. */
  testid?: string;
  /** Background of the viewport. Defaults to the catppuccin crust. */
  background?: string;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 12;
const ZOOM_STEP = 0.0015; // per wheel deltaY unit

/**
 * Zoom + pan image viewer used by Repo Explorer, Session Meta, and
 * Workbench tiles.
 *
 * - Wheel scrolls to zoom, centred on the cursor.
 * - Drag (mouse down + move) pans when zoomed in.
 * - Double-click resets to fit.
 * - A small floating control cluster offers +/−/reset and shows the
 *   current zoom percentage.
 *
 * State is purely local; the image is laid out via a CSS transform so we
 * never re-decode on zoom.
 */
export function ZoomableImage({ src, alt, testid, background = "#11111b" }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const dragState = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Reset transform whenever the source changes (new file opened).
  useEffect(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, [src]);

  const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

  // Wheel-zoom centred on the cursor. Attached natively so we can call
  // preventDefault (React's onWheel is passive in some setups).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // Cursor position relative to the viewport centre.
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      setScale((prevScale) => {
        const next = clampScale(prevScale * (1 - e.deltaY * ZOOM_STEP));
        const ratio = next / prevScale;
        // Keep the point under the cursor fixed: adjust translation.
        setTx((prevTx) => cx - (cx - prevTx) * ratio);
        setTy((prevTy) => cy - (cy - prevTy) * ratio);
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const reset = () => {
    setScale(1);
    setTx(0);
    setTy(0);
  };

  const zoomBy = (factor: number) => {
    setScale((prev) => clampScale(prev * factor));
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragState.current = { x: e.clientX, y: e.clientY, tx, ty };
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const s = dragState.current;
      if (!s) return;
      setTx(s.tx + (e.clientX - s.x));
      setTy(s.ty + (e.clientY - s.y));
    };
    const onUp = () => {
      dragState.current = null;
      setDragging(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  const viewportStyle: CSSProperties = {
    position: "relative",
    flex: 1,
    height: "100%",
    overflow: "hidden",
    background,
    cursor: dragging ? "grabbing" : scale > 1 ? "grab" : "default",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  return (
    <div ref={viewportRef} data-testid={testid} style={viewportStyle} onMouseDown={onMouseDown} onDoubleClick={reset}>
      <img
        src={src}
        alt={alt}
        draggable={false}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transformOrigin: "center center",
          // No transition while dragging/zooming — keeps it snappy.
          userSelect: "none",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: 8,
          right: 8,
          display: "flex",
          alignItems: "center",
          gap: 4,
          background: "rgba(24,24,37,0.85)",
          border: "1px solid #313244",
          borderRadius: 4,
          padding: "2px 4px",
          fontSize: 11,
          color: "#cdd6f4",
          fontFamily: "monospace",
        }}
        // Don't start a pan when interacting with the controls.
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <button data-testid="zoom-out" onClick={() => zoomBy(1 / 1.25)} style={ctrlBtn} title="Zoom out">
          <MagnifyingGlassMinusIcon style={{ width: 14, height: 14 }} />
        </button>
        <span data-testid="zoom-level" style={{ minWidth: 38, textAlign: "center" }}>
          {Math.round(scale * 100)}%
        </span>
        <button data-testid="zoom-in" onClick={() => zoomBy(1.25)} style={ctrlBtn} title="Zoom in">
          <MagnifyingGlassPlusIcon style={{ width: 14, height: 14 }} />
        </button>
        <button data-testid="zoom-reset" onClick={reset} style={ctrlBtn} title="Reset (or double-click)">
          <ArrowsPointingOutIcon style={{ width: 14, height: 14 }} />
        </button>
      </div>
    </div>
  );
}

const ctrlBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#89b4fa",
  cursor: "pointer",
  fontSize: 13,
  padding: "0 4px",
  lineHeight: 1.2,
  display: "flex",
  alignItems: "center",
};
