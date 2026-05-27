import { readText as pluginReadText, writeText as pluginWriteText } from "@tauri-apps/plugin-clipboard-manager";

export async function writeTextToClipboard(text: string): Promise<void> {
  try {
    await pluginWriteText(text);
    return;
  } catch {
    // Fall through to browser API for non-Tauri contexts (vitest, E2E browser).
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  }
}

export async function readTextFromClipboard(): Promise<string> {
  try {
    return await pluginReadText();
  } catch {
    // Fall through to browser API for non-Tauri contexts.
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
    return await navigator.clipboard.readText();
  }
  return "";
}
