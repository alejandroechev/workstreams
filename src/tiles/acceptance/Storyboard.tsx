import { useEffect, useState, type CSSProperties } from "react";
import type { AcceptanceTestBlock } from "../../domain/acceptance/parse";
import { actualsFor, type ValidationRound } from "../../domain/acceptance/view";
import { GrillVisualView } from "../grill/GrillVisualView";
import type { AcceptanceIo } from "./acceptance-io";

const STEP_LABELS = { given: "Given", when: "When", then: "Then" } as const;

/** A screenshot a validation round saved for one frame (read-only, ADR 037). */
function Screenshot({ path, io, label }: { path: string; io: AcceptanceIo; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    io.readBase64(path).then(
      (b64) => { if (!cancelled) setSrc(`data:image/png;base64,${b64}`); },
      () => { if (!cancelled) setError(`Could not load ${path.split("/").pop()}`); },
    );
    return () => { cancelled = true; };
  }, [io, path]);
  if (error) return <div role="alert" style={{ fontSize: 11, color: "#f38ba8" }}>{error}</div>;
  return src ? <img data-testid="acceptance-actual" src={src} alt={label} style={{ maxWidth: "100%", borderRadius: 4, border: "1px solid #313244" }} /> : null;
}

/**
 * A test's storyboard: its frames in file order, labelled by step, each with
 * the latest validation round's screenshot beside it when there is one.
 */
export function Storyboard({ test, featureDir, io, rounds, revision = "" }: { test: AcceptanceTestBlock; featureDir: string; io: AcceptanceIo; rounds: ValidationRound[]; revision?: string }) {
  const [large, setLarge] = useState<number | null>(null);
  const actuals = actualsFor(test, rounds);
  const visual = (index: number, height: number) => (
    <GrillVisualView
      // A new revision means a frame was redrawn under the same name: load it again.
      key={`${test.frames[index].path}@${revision}`}
      visual={{ path: test.frames[index].path, label: test.frames[index].caption, option: null }}
      grillDir={featureDir}
      io={io}
      assetRoot="acceptance-assets"
      height={height}
    />
  );
  const pair = (index: number, height: number) => {
    const actual = actuals[index];
    if (!actual) return visual(index, height);
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <div style={{ minWidth: 0 }}><div style={labelStyle}>Expected</div>{visual(index, height)}</div>
        <div style={{ minWidth: 0 }}>
          <div style={labelStyle}>{`Actual — round ${actual.round}`}</div>
          <Screenshot path={`${featureDir}/validation/r${actual.round}/${actual.file}`} io={io} label={`${test.id} frame ${index + 1}, round ${actual.round}`} />
        </div>
      </div>
    );
  };

  return (
    <section data-testid="acceptance-storyboard" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(test.frames.length, 4)}, minmax(0, 1fr))`, gap: 8 }}>
        {test.frames.map((frame, index) => (
          <figure
            key={`${frame.path}-${index}`}
            data-testid="acceptance-frame"
            data-step={frame.step ?? ""}
            style={{ margin: 0, border: `1px solid ${large === index ? "#89b4fa" : "#313244"}`, borderRadius: 6, background: "#181825", minWidth: 0 }}
          >
            <button
              type="button"
              data-testid="acceptance-frame-enlarge"
              title="Enlarge"
              onClick={() => setLarge(index)}
              style={frameHeaderStyle}
            >
              <b style={{ color: "#cdd6f4" }}>{frame.step ? STEP_LABELS[frame.step] : `Frame ${index + 1}`}</b>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{frame.caption}</span>
            </button>
            <div style={{ padding: 6 }}>{pair(index, 140)}</div>
          </figure>
        ))}
      </div>
      {large !== null && test.frames[large] && (
        <div data-testid="acceptance-frame-large" data-index={large} style={{ border: "1px solid #89b4fa", borderRadius: 6, padding: 8 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 6, fontSize: 12 }}>
            <span style={{ flex: 1 }}>
              <b>{test.frames[large].step ? STEP_LABELS[test.frames[large].step!] : `Frame ${large + 1}`}</b> {test.frames[large].caption}
            </span>
            <button type="button" data-testid="acceptance-frame-large-close" onClick={() => setLarge(null)} style={linkStyle}>Close</button>
          </div>
          {pair(large, 420)}
        </div>
      )}
    </section>
  );
}

const labelStyle: CSSProperties = { fontSize: 10, color: "#6c7086", marginBottom: 3 };
const frameHeaderStyle: CSSProperties = { display: "flex", gap: 6, width: "100%", textAlign: "left", background: "transparent", border: "none", borderBottom: "1px solid #313244", padding: "4px 8px", fontSize: 11, color: "#a6adc8", cursor: "zoom-in" };
const linkStyle: CSSProperties = { background: "transparent", color: "#89b4fa", border: "none", padding: 0, fontSize: 12, cursor: "pointer" };
