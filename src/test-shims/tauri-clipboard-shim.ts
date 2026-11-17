// @test-skip: Browser shim; no-ops only.
let memory = "";
export async function readText(): Promise<string> { return memory; }
export async function writeText(text: string): Promise<void> {
  memory = text;
  // E2E seam: what the app last copied as text.
  if (typeof window !== "undefined") (window as unknown as { __WS_CLIPBOARD_TEXT__?: string }).__WS_CLIPBOARD_TEXT__ = text;
}
export async function writeImage(_image: unknown): Promise<void> {
  throw new Error("No image clipboard in the browser build");
}
