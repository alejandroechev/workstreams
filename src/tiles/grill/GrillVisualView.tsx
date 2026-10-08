import { useEffect, useState } from "react";
import type { GrillVisual } from "../../domain/grill/parse";
import { assetPath, prototypeDocument } from "../../domain/grill/view";
import type { GrillIo } from "./grill-io";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const extension = (path: string) => path.split(".").pop()?.toLowerCase() ?? "";
const folderOf = (path: string) => path.split("/").slice(0, -1).join("/");

type Loaded =
  | { kind: "loading" }
  | { kind: "image"; src: string }
  | { kind: "prototype"; srcDoc: string }
  | { kind: "error"; message: string };

/**
 * One visual attached to a question: an image, or an HTML prototype in a
 * sandboxed frame (ADR 034). Only files inside the grill's own `grill-assets/`
 * are ever read; prototypes run with scripts but no network, no access to the
 * app and no way to navigate it.
 */
export function GrillVisualView({ visual, grillDir, io }: { visual: GrillVisual; grillDir: string; io: GrillIo }) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const done = (next: Loaded) => { if (!cancelled) setLoaded(next); };
    const path = assetPath(grillDir, visual.path);
    if (!path) {
      done({ kind: "error", message: `Not shown: ${visual.path} is outside this grill's grill-assets folder.` });
      return;
    }
    const ext = extension(visual.path);
    if (IMAGE_MIME[ext]) {
      io.readBase64(path).then(
        (b64) => done({ kind: "image", src: `data:${IMAGE_MIME[ext]};base64,${b64}` }),
        (error: unknown) => done({ kind: "error", message: `Could not load ${visual.path}: ${String(error)}` }),
      );
    } else if (ext === "html" || ext === "htm") {
      void (async () => {
        try {
          const { text } = await io.read(path);
          // Inline the images the prototype names from its own folder.
          const images: Record<string, string> = {};
          for (const match of text.matchAll(/\ssrc=["']([^"']+)["']/gi)) {
            const src = match[1];
            const mime = IMAGE_MIME[extension(src)];
            const resolved = mime ? assetPath(grillDir, `${folderOf(visual.path)}/${src}`) : null;
            if (!resolved || images[src]) continue;
            images[src] = `data:${mime};base64,${await io.readBase64(resolved)}`;
          }
          done({ kind: "prototype", srcDoc: prototypeDocument(text, images) });
        } catch (error) {
          done({ kind: "error", message: `Could not load ${visual.path}: ${error instanceof Error ? error.message : String(error)}` });
        }
      })();
    } else {
      done({ kind: "error", message: `Not shown: ${visual.path} is not an image or an HTML prototype.` });
    }
    return () => { cancelled = true; };
  }, [grillDir, io, visual.path]);

  return (
    <figure data-testid="grill-visual" data-path={visual.path} style={{ margin: 0, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      {loaded.kind === "image" && (
        <img src={loaded.src} alt={visual.label} style={{ maxWidth: "100%", borderRadius: 4, border: "1px solid #313244" }} />
      )}
      {loaded.kind === "prototype" && (
        <iframe
          title={visual.label}
          data-testid="grill-prototype"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={loaded.srcDoc}
          style={{ width: "100%", height: 320, border: "1px solid #313244", borderRadius: 4, background: "#fff" }}
        />
      )}
      {loaded.kind === "loading" && <div style={{ fontSize: 11, color: "#6c7086" }}>Loading {visual.label}…</div>}
      {loaded.kind === "error" && <div role="alert" style={{ fontSize: 11, color: "#f38ba8" }}>{loaded.message}</div>}
      <figcaption style={{ fontSize: 11, color: "#a6adc8" }}>{visual.label}</figcaption>
    </figure>
  );
}
