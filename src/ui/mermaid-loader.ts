// @test-skip: dynamic <script> loader for vendored libs, validated via integration
/**
 * Lazy loader for the vendored mermaid + panzoom libraries.
 *
 * Both libs are served as static assets from /libs/. They are only loaded the
 * first time a Mermaid diagram is rendered, so users that never view markdown
 * with mermaid blocks pay zero bundle cost.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    mermaid?: any;
    Panzoom?: any;
  }
}

let mermaidPromise: Promise<any> | null = null;
let panzoomPromise: Promise<any> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(
      `script[data-vendor-src="${src}"]`,
    ) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)));
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.vendorSrc = src;
    script.onload = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

export async function loadMermaid(): Promise<any> {
  if (window.mermaid) return window.mermaid;
  if (!mermaidPromise) {
    mermaidPromise = loadScript("/libs/mermaid.min.js").then(() => {
      const mermaid = window.mermaid;
      if (!mermaid) throw new Error("mermaid global not found after load");
      mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        securityLevel: "loose",
        fontFamily: "'Segoe UI', system-ui, sans-serif",
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

export async function loadPanzoom(): Promise<any> {
  if (window.Panzoom) return window.Panzoom;
  if (!panzoomPromise) {
    panzoomPromise = loadScript("/libs/panzoom.min.js").then(() => {
      const pz = window.Panzoom;
      if (!pz) throw new Error("Panzoom global not found after load");
      return pz;
    });
  }
  return panzoomPromise;
}
