// @test-skip: thin wrapper around vendored mermaid+panzoom (DOM heavy, validated via CDP)
import { useEffect, useRef, useState } from "react";
import {
  ArrowsPointingOutIcon,
  ArrowPathIcon,
  ClipboardDocumentIcon,
  XMarkIcon,
  MinusIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import { loadMermaid, loadPanzoom } from "./mermaid-loader";
import { preprocessMermaidCode } from "./preprocessMermaid";
import {
  getAppSettings,
  setAppSettings,
  subscribeAppSettings,
  MERMAID_FONT_SIZE_MAX,
  MERMAID_FONT_SIZE_MIN,
} from "../domain/app-settings";

interface Props {
  source: string;
}

let diagramCounter = 0;

export function MermaidDiagram({ source }: Props) {
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
  const [fontSize, setFontSize] = useState<number>(() => getAppSettings().mermaidFontSize);
  const idRef = useRef(`mermaid-${++diagramCounter}`);

  useEffect(
    () => subscribeAppSettings((s) => setFontSize(s.mermaidFontSize)),
    [],
  );

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
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "loose",
          fontFamily: "'Segoe UI', system-ui, sans-serif",
          themeVariables: { fontSize: `${fontSize}px` },
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
              const scale = Math.min(cw / svgBox.width, ch / svgBox.height) * 0.9;
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
  }, [source, fullscreen, fontSize]);

  const handleReset = () => {
    panzoomInstanceRef.current?.reset?.();
  };

  const bumpFont = (delta: number) => {
    const next = Math.max(
      MERMAID_FONT_SIZE_MIN,
      Math.min(MERMAID_FONT_SIZE_MAX, fontSize + delta),
    );
    setAppSettings({ mermaidFontSize: next });
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
        <button
          title={`Smaller font (${fontSize}px)`}
          onClick={() => bumpFont(-1)}
          style={toolbarBtnStyle}
          data-testid="mermaid-font-smaller"
          disabled={fontSize <= MERMAID_FONT_SIZE_MIN}
        >
          <MinusIcon style={iconStyle} />
        </button>
        <span
          style={{ fontSize: 10, color: "#cdd6f4", padding: "0 4px", alignSelf: "center" }}
          data-testid="mermaid-font-size"
        >
          {fontSize}
        </span>
        <button
          title={`Larger font (${fontSize}px)`}
          onClick={() => bumpFont(1)}
          style={toolbarBtnStyle}
          data-testid="mermaid-font-larger"
          disabled={fontSize >= MERMAID_FONT_SIZE_MAX}
        >
          <PlusIcon style={iconStyle} />
        </button>
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
};

const canvasStyleFs: React.CSSProperties = {
  flex: 1,
  overflow: "hidden",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "grab",
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
