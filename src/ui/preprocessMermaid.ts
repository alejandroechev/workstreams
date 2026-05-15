/**
 * Preprocesses mermaid diagram code to escape angle brackets that would
 * confuse the parser (e.g., generic types like Channel<AudioFrame>),
 * while preserving valid HTML tags (<br/>, <b>, <i>, etc.) and arrow syntax.
 *
 * Uses mermaid's own escape sequences: #lt; for < and #gt; for >.
 *
 * Ported from C:\Local\Code\ai-tools\mermaid-renderer\src\preprocessMermaid.js.
 */
export function preprocessMermaidCode(code: string): string {
  if (!code) return code;

  const VALID_HTML_TAG = /^\/?\s*(br\s*\/?|[bius]|sub|sup|em|strong)\s*$/i;

  const result = code
    .replace(/&lt;/g, "#lt;")
    .replace(/&gt;/g, "#gt;")
    .replace(/&#60;/g, "#lt;")
    .replace(/&#62;/g, "#gt;");

  return result.replace(/<([^>]+)>/g, (match, inner: string) => {
    const trimmed = inner.trim();

    if (VALID_HTML_TAG.test(trimmed)) return match;
    if (/^[-=.]+$/.test(trimmed)) return match;
    if (trimmed.startsWith("!--")) return match;

    return `#lt;${inner}#gt;`;
  });
}
