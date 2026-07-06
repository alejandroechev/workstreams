import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  GITHUB_DARK_DIFF_THEME,
  defineGithubDiffTheme,
  _resetGithubDiffThemeForTests,
} from "../monaco-diff-theme";

function fakeMonaco() {
  return { editor: { defineTheme: vi.fn() } } as unknown as typeof import("monaco-editor");
}

describe("monaco-diff-theme", () => {
  beforeEach(() => _resetGithubDiffThemeForTests());

  it("registers a vs-dark-derived theme with GitHub diff colors", () => {
    const monaco = fakeMonaco();
    defineGithubDiffTheme(monaco);

    expect(monaco.editor.defineTheme).toHaveBeenCalledTimes(1);
    const [name, data] = (monaco.editor.defineTheme as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(name).toBe(GITHUB_DARK_DIFF_THEME);
    expect(data.base).toBe("vs-dark");
    expect(data.inherit).toBe(true);

    // Subtle line tints, stronger word emphasis, distinct gutter — no olive.
    expect(data.colors["diffEditor.insertedLineBackground"]).toBe("#2ea04326");
    expect(data.colors["diffEditor.insertedTextBackground"]).toBe("#2ea04366");
    expect(data.colors["diffEditor.removedLineBackground"]).toBe("#f8514926");
    expect(data.colors["diffEditor.removedTextBackground"]).toBe("#f8514966");
    expect(data.colors["diffEditorGutter.insertedLineBackground"]).toBe("#2ea0434d");
    expect(data.colors["diffEditorGutter.removedLineBackground"]).toBe("#f851494d");
    // Borders are transparent (fill, not outline).
    expect(data.colors["diffEditor.insertedTextBorder"]).toBe("#00000000");
    expect(data.colors["diffEditor.removedTextBorder"]).toBe("#00000000");
  });

  it("is idempotent — only registers once across repeated calls", () => {
    const monaco = fakeMonaco();
    defineGithubDiffTheme(monaco);
    defineGithubDiffTheme(monaco);
    defineGithubDiffTheme(monaco);
    expect(monaco.editor.defineTheme).toHaveBeenCalledTimes(1);
  });
});
