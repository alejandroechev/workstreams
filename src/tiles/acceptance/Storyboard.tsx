import { useEffect, useState, type CSSProperties } from "react";
import type { AcceptanceTestBlock, FrameStep } from "../../domain/acceptance/parse";
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

/** How tall a full-width frame is drawn. */
const FRAME_HEIGHT = 360;

/**
 * One step's storyboard frames (`step`), or the frames with no step (`null`),
 * in file order. Each frame takes the card's full width, with the latest
 * validation round's screenshot under it when there is one.
 */
export function Storyboard({ test, step, featureDir, io, rounds, revision = "" }: {
  test: AcceptanceTestBlock; step: FrameStep | null; featureDir: string; io: AcceptanceIo; rounds: ValidationRound[]; revision?: string;
}) {
  const actuals = actualsFor(test, rounds);
  // Frame numbers count every frame of the test, so screenshots stay matched.
  const frames = test.frames.map((frame, index) => ({ frame, index })).filter(({ frame }) => frame.step === step);
  if (frames.length === 0) return null;
  return (
    <section data-testid="acceptance-storyboard" data-step={step ?? ""} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {frames.map(({ frame, index }) => {
        const actual = actuals[index];
        return (
          <figure
            key={`${frame.path}-${index}`}
            data-testid="acceptance-frame"
            data-step={frame.step ?? ""}
            style={{ margin: 0, border: "1px solid #313244", borderRadius: 6, background: "#181825", minWidth: 0 }}
          >
            <figcaption style={frameHeaderStyle}>
              <b style={{ color: "#cdd6f4" }}>{frame.step ? STEP_LABELS[frame.step] : `Frame ${index + 1}`}</b>
              <span data-testid="acceptance-frame-caption" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{frame.caption}</span>
            </figcaption>
            <div style={{ padding: 6, display: "flex", flexDirection: "column", gap: 6 }}>
              {actual && <div style={labelStyle}>Expected</div>}
              <GrillVisualView
                // A new revision means a frame was redrawn under the same name: load it again.
                key={`${frame.path}@${revision}`}
                visual={{ path: frame.path, label: frame.caption, option: null }}
                grillDir={featureDir}
                io={io}
                assetRoot="acceptance-assets"
                height={FRAME_HEIGHT}
              />
              {actual && (
                <>
                  <div style={labelStyle}>{`Actual — round ${actual.round}`}</div>
                  <Screenshot path={`${featureDir}/validation/r${actual.round}/${actual.file}`} io={io} label={`${test.id} frame ${index + 1}, round ${actual.round}`} />
                </>
              )}
            </div>
          </figure>
        );
      })}
    </section>
  );
}

const labelStyle: CSSProperties = { fontSize: 10, color: "#6c7086" };
const frameHeaderStyle: CSSProperties = { display: "flex", gap: 6, borderBottom: "1px solid #313244", padding: "4px 8px", fontSize: 11, color: "#a6adc8" };
