// @test-skip: dynamic <script> loader for vendored libs, validated via integration
/**
 * Lazy loader for the vendored mermaid + panzoom libraries.
 *
 * Both libs are served as static assets from /libs/. They are only loaded the
 * first time a Mermaid diagram is rendered, so users that never view markdown
 * with mermaid blocks pay zero bundle cost.
 *
 * IMPORTANT — UMD/AMD trap: both libs use a UMD wrapper that checks for
 * `define.amd` BEFORE falling back to a global. In some Tauri/WebView2 setups
 * an AMD `define` shim is present in the page (sometimes injected by Vite or
 * other tooling). When that happens the UMD wrapper registers as an AMD
 * module and NEVER sets `window.mermaid` / `window.Panzoom`. We work around
 * this by temporarily nulling out `define.amd` while the script loads, then
 * restoring it afterwards. This is a common pattern when consuming UMD libs
 * in environments that erroneously claim AMD support.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    mermaid?: any;
    Panzoom?: any;
    define?: { amd?: unknown };
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

/**
 * Load a UMD script with AMD detection disabled, so it falls through to the
 * `window.X = ...` branch instead of registering as an anonymous AMD module.
 */
async function loadUmdScript(src: string): Promise<void> {
  const define = window.define;
  const savedAmd = define?.amd;
  if (define) define.amd = undefined;
  try {
    await loadScript(src);
  } finally {
    if (define && savedAmd !== undefined) define.amd = savedAmd;
  }
}

export async function loadMermaid(): Promise<any> {
  if (window.mermaid) return window.mermaid;
  if (!mermaidPromise) {
    mermaidPromise = loadUmdScript("/libs/mermaid.min.js").then(() => {
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
    panzoomPromise = loadUmdScript("/libs/panzoom.min.js").then(() => {
      const pz = window.Panzoom;
      if (!pz) throw new Error("Panzoom global not found after load");
      return pz;
    });
  }
  return panzoomPromise;
}
