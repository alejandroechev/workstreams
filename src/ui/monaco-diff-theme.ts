import type * as MonacoNs from "monaco-editor";

/**
 * A Monaco theme that reproduces GitHub's dark-mode PR diff coloring.
 *
 * Monaco's default `vs-dark` diff colors use a saturated olive-green for
 * inserted text (`diffEditor.insertedTextBackground` ≈ `#9bb955`) plus a bright
 * red for deletions, both at fairly high opacity. Over a dark editor that reads
 * as a heavy wash that fights the syntax colors and hurts legibility.
 *
 * GitHub instead uses a very subtle line tint (~15% green/red) with a slightly
 * stronger word-level emphasis (~40%) and a distinct gutter/line-number block
 * (~30%), and fills rather than outlines changed tokens. These values are
 * GitHub Primer's dark diff overlay colors (success `#2ea043` / danger
 * `#f85149`), verified against real GitHub PR screenshots.
 */
export const GITHUB_DARK_DIFF_THEME = "github-dark-diff";

// GitHub Primer dark diff overlay colors, as #RRGGBBAA. The alpha byte lets
// Monaco blend them over whatever editor background is active.
const COLORS: Record<string, string> = {
  // Full changed-line backgrounds (subtle, ~15%).
  "diffEditor.insertedLineBackground": "#2ea04326",
  "diffEditor.removedLineBackground": "#f8514926",
  // Word/character-level emphasis for the exact changed tokens (~40%).
  "diffEditor.insertedTextBackground": "#2ea04366",
  "diffEditor.removedTextBackground": "#f8514966",
  // Gutter / line-number column blocks (~30%), like GitHub's colored numbers.
  "diffEditorGutter.insertedLineBackground": "#2ea0434d",
  "diffEditorGutter.removedLineBackground": "#f851494d",
  // Fill instead of outline: drop the boxy borders Monaco draws around tokens.
  "diffEditor.insertedTextBorder": "#00000000",
  "diffEditor.removedTextBorder": "#00000000",
  // Overview ruler / minimap markers.
  "diffEditorOverview.insertedForeground": "#2ea04399",
  "diffEditorOverview.removedForeground": "#f8514999",
};

/**
 * Register the `github-dark-diff` theme on the given Monaco instance. The theme
 * inherits `vs-dark` (so all syntax highlighting is unchanged) and only
 * overrides the diff-specific colors. Idempotent per Monaco instance: safe to
 * call from every editor's `beforeMount`. Monaco themes are global *within an
 * instance*, so once registered the theme is available to every editor on that
 * instance.
 *
 * The app has two distinct Monaco instances — `@monaco-editor/react` (CDN) and
 * the bundled `loadMonaco()` — so the guard is keyed per instance rather than
 * module-global; otherwise the second instance would never get the theme.
 */
const registered = new WeakSet<object>();

export function defineGithubDiffTheme(monaco: typeof MonacoNs): void {
  if (registered.has(monaco)) return;
  monaco.editor.defineTheme(GITHUB_DARK_DIFF_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: COLORS,
  });
  registered.add(monaco);
}
