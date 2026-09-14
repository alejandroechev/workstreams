/**
 * Guards browser APIs the packaged app does not actually have.
 *
 * The app runs in a Tauri webview — WKWebView on macOS — which does not
 * implement `window.prompt`. Both test environments do: jsdom provides it, and
 * Playwright drives real Chromium. So a `prompt` call passes every gate and
 * then silently does nothing for the user, which is exactly how the "New lane"
 * button shipped broken.
 *
 * A source-level check is the only layer that can see this, because the failure
 * is the *absence* of an API in a host neither test layer runs in.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

/** Every source file, excluding tests. */
function sourceFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === "__tests__" ? [] : sourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

describe("APIs the Tauri webview does not provide", () => {
  it("never calls window.prompt", () => {
    const offenders = sourceFiles(SRC).filter((path) => {
      const body = readFileSync(path, "utf8");
      // Matches `window.prompt(` and a bare `prompt(` call, but not the many
      // identifiers in this codebase that merely contain "prompt".
      return (
        /\bwindow\s*\.\s*prompt\s*\(/.test(body) || /(?<![\w.])prompt\s*\(/.test(body)
      );
    });

    expect(
      offenders.map((path) => path.replace(`${process.cwd()}/`, "")),
      "window.prompt is not implemented in WKWebView — it returns nothing and the " +
        "control appears dead in the packaged app. Use an inline input instead; the " +
        "sidebar's rename field is the pattern.",
    ).toEqual([]);
  });

  /**
   * `confirm` and `alert` *are* supported, and carry the dirty-buffer and
   * unarchive dialogs. Pinned so this guard is not mistaken for a blanket ban
   * on native dialogs.
   */
  it("finds the confirm dialogs it expects to keep working", () => {
    const users = sourceFiles(SRC).filter((path) =>
      /\bwindow\s*\.\s*confirm\s*\(/.test(readFileSync(path, "utf8")),
    );
    expect(users.length).toBeGreaterThan(0);
  });
});
