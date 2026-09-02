import { Fragment, type CSSProperties } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { splitLinks } from "../domain/linkify";

interface Props {
  /** Raw plain text. Rendered verbatim; never interpreted as HTML. */
  text: string;
  /** Optional testid forwarded to the wrapper span. */
  testid?: string;
  /** Extra styles merged onto the wrapper span. */
  style?: CSSProperties;
}

const linkStyle: CSSProperties = {
  color: "#89b4fa",
  textDecoration: "underline",
  wordBreak: "break-all",
  cursor: "pointer",
};

/**
 * Render plain text with http(s) URLs as clickable anchors.
 *
 * Segments come from the pure `splitLinks` helper and are emitted as React
 * nodes, so stored text can never inject markup. Clicks are routed to the
 * system browser through tauri-plugin-opener rather than navigating the
 * webview away from the app — same pattern as MarkdownView.
 */
export function LinkifiedText({ text, testid, style }: Props) {
  return (
    <span data-testid={testid} style={style}>
      {splitLinks(text).map((segment, i) =>
        segment.kind === "link" ? (
          <a
            key={i}
            href={segment.value}
            style={linkStyle}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => {
              e.preventDefault();
              openUrl(segment.value).catch(() => {
                /* swallow; opener may not be configured */
              });
            }}
          >
            {segment.value}
          </a>
        ) : (
          <Fragment key={i}>{segment.value}</Fragment>
        ),
      )}
    </span>
  );
}
