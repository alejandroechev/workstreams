import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ArrowsPointingOutIcon,
} from "@heroicons/react/24/outline";
import { MarkdownView } from "../MarkdownView";
import { splitSlides } from "../../domain/slides";

interface Props {
  /** Deck markdown source (split on `---`). */
  source: string;
  /** Absolute dir of the source file, for resolving relative images. */
  basePath?: string;
  /** Controlled current slide index. */
  slideIndex: number;
  /** Called with a clamped index when navigation changes the slide. */
  onIndexChange: (index: number) => void;
  /** Base present-mode font size in px before deck fontScale is applied. */
  baseFontSize?: number;
  /** Toggle host fullscreen (wired to the tile's fullscreen). */
  onToggleFullscreen?: () => void;
  /** Forwarded testid for the viewport container. */
  testid?: string;
}

const DEFAULT_PRESENT_FONT = 30;
const FADE_KEYFRAMES = "@keyframes slidedeck-fade{from{opacity:0}to{opacity:1}}";

/**
 * Slide deck renderer for markdown "Present" mode. Splits the source into
 * slides and renders one at a time via the shared MarkdownView at a large,
 * centered, dark canvas with a fade transition between slides.
 *
 * Controlled: the host owns `slideIndex` (persisted in tile view-state);
 * SlideDeck clamps it into range and reports navigation via onIndexChange.
 */
export function SlideDeck({
  source,
  basePath,
  slideIndex,
  onIndexChange,
  baseFontSize,
  onToggleFullscreen,
  testid = "slide-deck",
}: Props) {
  const { config, slides } = useMemo(() => splitSlides(source), [source]);
  const count = slides.length;
  const clamped = Math.min(Math.max(slideIndex, 0), count - 1);

  // Controls auto-dim when idle and brighten on pointer activity.
  const [controlsVisible, setControlsVisible] = useState(true);
  const dimTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeControls = () => {
    setControlsVisible(true);
    if (dimTimer.current) clearTimeout(dimTimer.current);
    dimTimer.current = setTimeout(() => setControlsVisible(false), 2200);
  };
  useEffect(() => () => { if (dimTimer.current) clearTimeout(dimTimer.current); }, []);

  // If the persisted index is out of range (e.g. the deck shrank after an
  // edit), report the clamped value back so it gets re-persisted in range.
  const reportedRef = useRef<number | null>(null);
  useEffect(() => {
    if (clamped !== slideIndex && reportedRef.current !== clamped) {
      reportedRef.current = clamped;
      onIndexChange(clamped);
    } else if (clamped === slideIndex) {
      reportedRef.current = null;
    }
  }, [clamped, slideIndex, onIndexChange]);

  const goTo = (next: number) => {
    const target = Math.min(Math.max(next, 0), count - 1);
    if (target !== clamped) onIndexChange(target);
  };

  const containerRef = useRef<HTMLDivElement>(null);
  // Focus the surface on mount so keyboard nav works immediately.
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowRight":
      case " ":
      case "PageDown":
        e.preventDefault();
        goTo(clamped + 1);
        break;
      case "ArrowLeft":
      case "PageUp":
        e.preventDefault();
        goTo(clamped - 1);
        break;
      case "Home":
        e.preventDefault();
        goTo(0);
        break;
      case "End":
        e.preventDefault();
        goTo(count - 1);
        break;
      // Escape intentionally not handled — the host exits present/fullscreen.
      default:
        break;
    }
  };

  const onClickNav = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const isLeft = e.clientX - rect.left < rect.width / 2;
    goTo(clamped + (isLeft ? -1 : 1));
  };

  const fontSize = Math.round((baseFontSize ?? DEFAULT_PRESENT_FONT) * (config.fontScale ?? 1));
  const progressPct = (((clamped + 1) / count) * 100).toFixed(1);

  return (
    <div
      ref={containerRef}
      data-testid={testid}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseMove={wakeControls}
      style={viewportStyle}
    >
      <style>{FADE_KEYFRAMES}</style>
      <div style={canvasStyle}>
        <div
          key={clamped}
          data-testid="slide-content"
          style={{ animation: "slidedeck-fade 250ms ease", width: "100%" }}
        >
          <MarkdownView basePath={basePath} baseFontSize={fontSize} style={slideMarkdownStyle}>
            {slides[clamped] ?? ""}
          </MarkdownView>
        </div>
      </div>
      {/* Transparent click layer: right half = next, left half = prev. */}
      <div
        data-testid="slide-click-layer"
        onClick={onClickNav}
        style={clickLayerStyle}
      />

      {/* Progress bar across the bottom edge. */}
      <div style={progressTrackStyle}>
        <div data-testid="slide-progress" style={{ ...progressFillStyle, width: `${progressPct}%` }} />
      </div>

      {/* Auto-dimming control cluster. */}
      <div
        style={{ ...controlClusterStyle, opacity: controlsVisible ? 1 : 0 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          data-testid="slide-prev"
          onClick={(e) => { e.stopPropagation(); goTo(clamped - 1); }}
          style={ctrlBtn}
          title="Previous slide"
          disabled={clamped === 0}
        >
          <ChevronLeftIcon style={iconStyle} />
        </button>
        <span data-testid="slide-counter" style={counterStyle}>
          {clamped + 1} / {count}
        </span>
        <button
          data-testid="slide-next"
          onClick={(e) => { e.stopPropagation(); goTo(clamped + 1); }}
          style={ctrlBtn}
          title="Next slide"
          disabled={clamped === count - 1}
        >
          <ChevronRightIcon style={iconStyle} />
        </button>
        {onToggleFullscreen && (
          <button
            data-testid="slide-fullscreen"
            onClick={(e) => { e.stopPropagation(); onToggleFullscreen(); }}
            style={ctrlBtn}
            title="Toggle fullscreen"
          >
            <ArrowsPointingOutIcon style={iconStyle} />
          </button>
        )}
      </div>
    </div>
  );
}

const viewportStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  overflow: "hidden",
  background: "#11111b",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const canvasStyle: CSSProperties = {
  width: "100%",
  maxWidth: 1100,
  maxHeight: "100%",
  overflow: "auto",
  padding: "48px 64px",
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const slideMarkdownStyle: CSSProperties = {
  background: "transparent",
  padding: 0,
};

const clickLayerStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  cursor: "pointer",
  background: "transparent",
};

const progressTrackStyle: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  height: 3,
  background: "rgba(255,255,255,0.06)",
};

const progressFillStyle: CSSProperties = {
  height: "100%",
  background: "#89b4fa",
  transition: "width 0.2s ease",
};

const controlClusterStyle: CSSProperties = {
  position: "absolute",
  bottom: 12,
  right: 12,
  display: "flex",
  alignItems: "center",
  gap: 4,
  background: "rgba(24,24,37,0.85)",
  border: "1px solid #313244",
  borderRadius: 6,
  padding: "3px 6px",
  color: "#cdd6f4",
  fontFamily: "monospace",
  fontSize: 12,
  transition: "opacity 0.25s ease",
};

const counterStyle: CSSProperties = {
  minWidth: 52,
  textAlign: "center",
  userSelect: "none",
};

const ctrlBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#89b4fa",
  cursor: "pointer",
  padding: "2px 4px",
  display: "flex",
  alignItems: "center",
};

const iconStyle: CSSProperties = { width: 16, height: 16 };
