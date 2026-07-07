/**
 * Helpers for putting **interactive** DOM (buttons, links) inside a Monaco
 * **view zone** and having it actually receive clicks.
 *
 * Why this is needed: inside Monaco's `.lines-content`, layers paint in DOM
 * order (all `position:absolute`, `z-index:auto`), and `.view-lines` comes
 * *after* `.view-zones` — so the text layer paints on top of a zone's DOM and
 * swallows clicks aimed at buttons in it (you see the editor's I-beam cursor
 * over them). `pointer-events:auto` and `suppressMouseDown` don't fix it because
 * it's a paint/z-order problem.
 *
 * The fix has two parts:
 *  1. add {@link INTERACTIVE_ZONES_CLASS} to the editor **host** element — the
 *     CSS rule in `theme.css` lifts that editor's `.view-zones` above
 *     `.view-lines`; and
 *  2. call {@link markInteractiveZoneNode} on each zone's DOM node so it opts
 *     into pointer events.
 *
 * Use this for any future inline-in-editor UI (comment threads, inline actions).
 */

/**
 * CSS class (defined in `src/styles/theme.css`) that lifts an editor's Monaco
 * `.view-zones` layer above `.view-lines`. Add it to the **host element** you
 * pass to `monaco.editor.create(...)` or the `<div>` wrapping `<DiffEditor>`.
 * Zones only occupy their reserved vertical gaps (transparent elsewhere), so no
 * code text is covered and text editing/selection is unaffected.
 */
export const INTERACTIVE_ZONES_CLASS = "interactive-zones";

/**
 * Prepare a Monaco view-zone DOM node to host interactive content: enables
 * pointer events so its buttons are clickable (paired with an editor host that
 * carries {@link INTERACTIVE_ZONES_CLASS}).
 */
export function markInteractiveZoneNode(node: HTMLElement): void {
  node.style.pointerEvents = "auto";
}
