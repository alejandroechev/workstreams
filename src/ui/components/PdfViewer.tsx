import type { CSSProperties } from "react";

interface Props {
  /** Blob (or data) URL of the PDF. When null/empty an empty-state is shown. */
  src: string | null;
  /** Human-readable title (used as the iframe title / a11y label). */
  title?: string;
  /** Optional testid forwarded to the iframe. */
  testid?: string;
  /** Background of the viewport. Defaults to the catppuccin crust. */
  background?: string;
}

const containerStyle = (background: string): CSSProperties => ({
  flex: 1,
  minHeight: 0,
  width: "100%",
  height: "100%",
  background,
  display: "flex",
});

/**
 * PdfViewer — embeds a PDF via an `<iframe>` pointed at a blob URL. WebView2
 * (Edge/Chromium) ships a built-in PDF renderer, so no pdf.js dependency is
 * needed. Used by the Repo Explorer, Session Meta, and Workbench tiles.
 *
 * The caller owns the blob URL lifecycle (create via `makePdfBlobUrl`, revoke
 * on unmount / next swap).
 */
export function PdfViewer({ src, title, testid, background = "#11111b" }: Props) {
  if (!src) {
    return (
      <div
        style={{
          ...containerStyle(background),
          alignItems: "center",
          justifyContent: "center",
          color: "#585b70",
          fontFamily: "monospace",
          fontSize: 12,
        }}
      >
        No PDF loaded
      </div>
    );
  }
  return (
    <div style={containerStyle(background)}>
      <iframe
        data-testid={testid}
        title={title || "PDF preview"}
        src={src}
        style={{ flex: 1, width: "100%", height: "100%", border: "none" }}
      />
    </div>
  );
}
