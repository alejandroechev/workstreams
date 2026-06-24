// @test-skip: thin wrapper around vendored mermaid+panzoom (DOM heavy, validated via CDP)
import { useEffect, useRef, useState } from "react";
import {
  ArrowsPointingOutIcon,
  ArrowPathIcon,
  ClipboardDocumentIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { loadMermaid, loadPanzoom } from "./mermaid-loader";
import { preprocessMermaidCode } from "./preprocessMermaid";

interface Props {
  source: string;
  /** Markdown body font size (px) used to size mermaid labels. Mermaid is
   * container-independent, so this is passed explicitly (NOT the large
   * present-mode scaled size) and clamped, so preview and slides match. */
  baseFontSize?: number;
}

let diagramCounter = 0;

export function MermaidDiagram({ source, baseFontSize }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panzoomInstanceRef = useRef<{
    dispose?: () => void;
    reset?: () => void;
    zoom?: (s: number, o?: object) => void;
    zoomIn?: (s: number, o?: object) => void;
    zoomOut?: (s: number, o?: object) => void;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const idRef = useRef(`mermaid-${++diagramCounter}`);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      setError(null);
      try {
        const mermaid = await loadMermaid();
        if (cancelled || !containerRef.current) return;
        // Re-initialize with current font size before each render. Mermaid
        // bakes the font-size into every <text> element it emits, so changing
        // it requires a fresh render.
        // Mermaid is independent of the host/container font: it pins label
        // sizes via an injected `.nodeLabel { font-size: … }` rule and lays out
        // node boxes to match. The diagram is then zoom-fitted to the container
        // by panzoom, so the *absolute* font size is cosmetic — what matters is
        // that the value is a valid CSS length WITH a unit. A bare number (e.g.
        // "14") is invalid CSS: the box is laid out for that size but the label
        // text falls back to *inheriting* the container font (30px in present
        // mode), producing the "text wider than box" overflow. Always include
        // "px". We render at the markdown body font (clamped) so preview and
        // slides look identical regardless of the large present-mode scaling.
        const fontPx = Math.min(Math.max(Math.round(baseFontSize ?? 16), 11), 18);

        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "loose",
          fontFamily: "'Segoe UI', system-ui, sans-serif",
          themeVariables: {
            fontSize: `${fontPx}px`,
          },
        });
        const code = preprocessMermaidCode(source);
        const { svg } = await mermaid.render(`${idRef.current}-svg`, code);
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = svg;

        const svgEl = containerRef.current.querySelector("svg") as SVGSVGElement | null;
        if (svgEl) {
          svgEl.style.maxWidth = "none";
          svgEl.style.height = "auto";
        }

        const panzoom = await loadPanzoom();
        if (cancelled || !containerRef.current || !svgEl) return;
        const instance = panzoom(svgEl as unknown as HTMLElement, {
          canvas: true,
          step: 0.06,
          minZoom: 0.1,
          maxZoom: 8,
        });
        panzoomInstanceRef.current = instance;

        // Fit-to-container: mermaid's default SVG often renders much larger
        // than the available area, especially for long graphs. Measure the
        // natural SVG bbox vs the container and apply an initial zoom that
        // makes the entire diagram visible with a small padding.
        requestAnimationFrame(() => {
          if (cancelled || !containerRef.current || !svgEl) return;
          const container = containerRef.current;
          try {
            const svgBox = svgEl.getBBox();
            const cw = container.clientWidth;
            const ch = container.clientHeight;
            if (svgBox.width > 0 && svgBox.height > 0 && cw > 0 && ch > 0) {
              // Use a slightly larger padding factor than before so wrapped
              // multiline text has a bit more room and doesn't clip by a
              // hair. 0.95 gives a comfortable margin without wasting space.
              const paddingFactor = 0.95;
              const scale = Math.min(cw / svgBox.width, ch / svgBox.height) * paddingFactor;
              if (scale > 0 && scale < 1) {
                instance.zoom?.(scale, { animate: false });
              }
            }
          } catch {
            /* getBBox throws if not laid out yet; ignore */
          }
        });

        const onWheel = (e: WheelEvent) => {
          e.preventDefault();
          if (e.deltaY < 0) instance.zoomIn(0.005, { animate: false });
          else instance.zoomOut(0.005, { animate: false });
        };
        const onDblClick = () => instance.reset?.();
        containerRef.current.addEventListener("wheel", onWheel, { passive: false });
        containerRef.current.addEventListener("dblclick", onDblClick);

        // Store cleanup
        (panzoomInstanceRef.current as { _cleanup?: () => void })._cleanup = () => {
          containerRef.current?.removeEventListener("wheel", onWheel);
          containerRef.current?.removeEventListener("dblclick", onDblClick);
          instance.dispose?.();
        };
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void render();

    return () => {
      cancelled = true;
      const cleanup = (panzoomInstanceRef.current as { _cleanup?: () => void } | null)?._cleanup;
      cleanup?.();
      panzoomInstanceRef.current = null;
    };
  }, [source, fullscreen, baseFontSize]);

  const handleReset = () => {
    panzoomInstanceRef.current?.reset?.();
  };

  const handleCopySvg = async () => {
    const svg = containerRef.current?.querySelector("svg");
    if (svg) {
      const xml = new XMLSerializer().serializeToString(svg);
      try {
        await navigator.clipboard.writeText(xml);
      } catch {
        // ignore
      }
    }
  };

  if (error) {
    return (
      <div style={errorBoxStyle}>
        <div style={{ color: "#f38ba8", fontSize: 12, marginBottom: 6 }}>
          Mermaid render error: {error}
        </div>
        <pre style={errorPreStyle}>{source}</pre>
      </div>
    );
  }

  const body = (
    <div style={fullscreen ? fullscreenWrapperStyle : wrapperStyle} data-testid="mermaid-diagram">
      <div style={toolbarStyle}>
        <button title="Reset view" onClick={handleReset} style={toolbarBtnStyle}>
          <ArrowPathIcon style={iconStyle} />
        </button>
        <button title="Copy SVG" onClick={handleCopySvg} style={toolbarBtnStyle}>
          <ClipboardDocumentIcon style={iconStyle} />
        </button>
        <button
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          onClick={() => setFullscreen((v) => !v)}
          style={toolbarBtnStyle}
        >
          {fullscreen ? <XMarkIcon style={iconStyle} /> : <ArrowsPointingOutIcon style={iconStyle} />}
        </button>
      </div>
      <div
        ref={containerRef}
        style={fullscreen ? canvasStyleFs : canvasStyle}
        aria-label="Mermaid diagram"
      />
      <div style={hintStyle}>scroll: zoom &nbsp;·&nbsp; drag: pan &nbsp;·&nbsp; dbl-click: reset</div>
    </div>
  );

  return body;
}

const wrapperStyle: React.CSSProperties = {
  position: "relative",
  background: "#181825",
  border: "1px solid #313244",
  borderRadius: 6,
  margin: "12px 0",
  overflow: "hidden",
};

const fullscreenWrapperStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 9999,
  background: "#1e1e2e",
  display: "flex",
  flexDirection: "column",
};

const toolbarStyle: React.CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  display: "flex",
  gap: 4,
  background: "rgba(30, 30, 46, 0.85)",
  border: "1px solid #313244",
  borderRadius: 4,
  padding: 4,
  zIndex: 2,
};

const toolbarBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#cdd6f4",
  cursor: "pointer",
  padding: 4,
  borderRadius: 3,
  display: "flex",
  alignItems: "center",
};

const iconStyle: React.CSSProperties = { width: 14, height: 14 };

const canvasStyle: React.CSSProperties = {
  width: "100%",
  height: 400,
  overflow: "hidden",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "grab",
  // Reset typography inherited from the host (MarkdownView sets line-height
  // 1.6). Mermaid measures multiline foreignObject label height with a tight
  // line-height and sizes boxes to match; if the labels inherit 1.6 they grow
  // past the box bottom, clipping the last line of multiline nodes.
  lineHeight: "normal",
};

const canvasStyleFs: React.CSSProperties = {
  flex: 1,
  overflow: "hidden",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "grab",
  lineHeight: "normal",
};

const hintStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 6,
  left: 8,
  fontSize: 10,
  color: "#6c7086",
  pointerEvents: "none",
};

const errorBoxStyle: React.CSSProperties = {
  background: "#181825",
  border: "1px solid #f38ba8",
  borderRadius: 6,
  padding: 12,
  margin: "12px 0",
};

const errorPreStyle: React.CSSProperties = {
  background: "#11111b",
  padding: 8,
  borderRadius: 4,
  fontSize: 12,
  fontFamily: "'Cascadia Code', 'Consolas', monospace",
  overflow: "auto",
  color: "#cdd6f4",
};
