// @test-skip: thin lazy-loading glue around Excalidraw and Mermaid; exercised by the Diagram E2E specs.
/**
 * Loads Excalidraw (and, on demand, Mermaid) only when a diagram is shown, so
 * app start-up never pays for them (ADR 043).
 */
import type { DiagramScene, SceneElement } from "./scene";
import { PALETTE, type PaletteItem, type Skeleton } from "./palette";

type ExcalidrawModule = typeof import("@excalidraw/excalidraw");

let excalidraw: Promise<ExcalidrawModule> | null = null;

export function loadExcalidraw(): Promise<ExcalidrawModule> {
  if (!excalidraw) {
    // Fonts ship with the app (public/excalidraw-assets) instead of a CDN.
    const w = window as unknown as { EXCALIDRAW_ASSET_PATH?: string };
    w.EXCALIDRAW_ASSET_PATH ??= "/excalidraw-assets/";
    excalidraw = Promise.all([import("@excalidraw/excalidraw"), import("@excalidraw/excalidraw/index.css")]).then(([m]) => m);
  }
  return excalidraw;
}

/**
 * Mermaid text as editable Excalidraw elements. Throws Mermaid's parse error
 * for invalid text, and refuses diagrams that would only become a picture.
 */
export async function mermaidToScene(text: string): Promise<DiagramScene> {
  const [{ parseMermaidToExcalidraw }, ex] = await Promise.all([import("@excalidraw/mermaid-to-excalidraw"), loadExcalidraw()]);
  const { elements, files } = await parseMermaidToExcalidraw(text.trim(), { themeVariables: { fontSize: "16px" } });
  const converted = ex.convertToExcalidrawElements(elements, { regenerateIds: true }) as unknown as SceneElement[];
  if (converted.length === 0) throw new Error("The Mermaid diagram has nothing to draw");
  if (converted.some((e) => e.type === "image")) {
    throw new Error("This Mermaid diagram can only become a picture, not editable shapes. Use a flowchart, sequence, class or state diagram.");
  }
  return { elements: converted, files: (files ?? {}) as Record<string, unknown> };
}

/**
 * A palette item as new elements. Items drawn from several shapes are grouped
 * so they move together; a single shape stays ungrouped, so double-clicking
 * edits its text straight away.
 */
export async function paletteElements(item: PaletteItem): Promise<SceneElement[]> {
  const ex = await loadExcalidraw();
  const elements = ex.convertToExcalidrawElements(item.skeletons as unknown as Parameters<ExcalidrawModule["convertToExcalidrawElements"]>[0], { regenerateIds: true }) as unknown as SceneElement[];
  if (item.skeletons.length < 2) return elements;
  const group = `ws-palette-${Math.random().toString(36).slice(2, 10)}`;
  return elements.map((e) => ({ ...e, groupIds: [...(e.groupIds ?? []), group] }));
}

export { PALETTE };
export type { Skeleton };
