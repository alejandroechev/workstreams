import { type CSSProperties, type ReactNode, useEffect, useRef, useState, useCallback, useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MermaidDiagram } from "./MermaidDiagram";
import { classifyLinkTarget, isImageFile, makeImageBlobUrl, resolveRelativePath, type LinkTargetKind } from "../domain/file-types";
import { extractFrontmatter } from "./frontmatter";
import { getAppSettings, subscribeAppSettings } from "../domain/app-settings";

// Register only the languages we actually use. PrismLight does NOT
// auto-load grammars at scroll time (that's what made the colors "go
// dizzy" mid-scroll with the default async Prism build — Prism would
// re-tokenize when grammar chunks arrived after the initial render).
// Unknown languages fall back to plaintext via the conditional below.
import jsLang from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import tsLang from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import tsxLang from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import jsxLang from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import jsonLang from "react-syntax-highlighter/dist/esm/languages/prism/json";
import yamlLang from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import bashLang from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import pwshLang from "react-syntax-highlighter/dist/esm/languages/prism/powershell";
import rustLang from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import goLang from "react-syntax-highlighter/dist/esm/languages/prism/go";
import pyLang from "react-syntax-highlighter/dist/esm/languages/prism/python";
import csLang from "react-syntax-highlighter/dist/esm/languages/prism/csharp";
import javaLang from "react-syntax-highlighter/dist/esm/languages/prism/java";
import sqlLang from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import markdownLang from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import diffLang from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import protobufLang from "react-syntax-highlighter/dist/esm/languages/prism/protobuf";
import cssLang from "react-syntax-highlighter/dist/esm/languages/prism/css";
import dockerLang from "react-syntax-highlighter/dist/esm/languages/prism/docker";
import tomlLang from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import iniLang from "react-syntax-highlighter/dist/esm/languages/prism/ini";

const REGISTERED_LANGS: Record<string, unknown> = {
  javascript: jsLang, js: jsLang,
  typescript: tsLang, ts: tsLang,
  tsx: tsxLang,
  jsx: jsxLang,
  json: jsonLang,
  yaml: yamlLang, yml: yamlLang,
  bash: bashLang, sh: bashLang, shell: bashLang,
  powershell: pwshLang, pwsh: pwshLang, ps: pwshLang, ps1: pwshLang,
  rust: rustLang, rs: rustLang,
  go: goLang, golang: goLang,
  python: pyLang, py: pyLang,
  csharp: csLang, cs: csLang, "c#": csLang,
  java: javaLang,
  sql: sqlLang,
  markdown: markdownLang, md: markdownLang,
  diff: diffLang,
  patch: diffLang,
  protobuf: protobufLang, proto: protobufLang,
  css: cssLang,
  docker: dockerLang, dockerfile: dockerLang,
  toml: tomlLang,
  ini: iniLang,
};
for (const [name, grammar] of Object.entries(REGISTERED_LANGS)) {
  // SyntaxHighlighter's registerLanguage accepts the name + grammar fn.
  (SyntaxHighlighter as unknown as { registerLanguage: (n: string, g: unknown) => void })
    .registerLanguage(name, grammar);
}

interface Props {
  children: string;
  className?: string;
  style?: CSSProperties;
  /** Base font size in px for the body. Headings/code scale proportionally. Default 14. */
  baseFontSize?: number;
  /**
   * Absolute directory of the source markdown file. Used to resolve
   * relative image paths (e.g. `images/foo.png`) into blob URLs loaded
   * through Tauri's `read_file_base64` command. When omitted, relative
   * paths are passed through unchanged (renders broken images, same as
   * before).
   */
  basePath?: string;
  /**
   * Internal link handler. Invoked when the user clicks a relative `<a>`
   * pointing at a file or directory on disk. The href is already resolved
   * against `basePath`. The host (Repo Explorer / FileEditorView wrapper)
   * decides what to do with it. When omitted, internal links fall back to
   * the previous behavior (default-tagged open in new tab — which is
   * broken under Tauri, hence the bug this prop fixes).
   */
  onLinkClick?: (absolutePath: string, kind: LinkTargetKind) => void;
}

/**
 * Shared markdown renderer for the app.
 *
 * Provides a VS Code-style dark theme: typography, headings with bottom border,
 * syntax-highlighted code blocks (vscDarkPlus), blockquotes with left border,
 * clean tables, and inline mermaid diagram rendering with zoom/pan.
 *
 * When `baseFontSize` is provided, all element sizes (headings, code blocks,
 * blockquote, inline code, etc.) scale proportionally via em units.
 */
export function MarkdownView({ children, className, style, baseFontSize, basePath, onLinkClick }: Props) {
  // Subscribe to global markdown font size; per-call baseFontSize prop wins
  // when explicitly provided (kept for back-compat / tests).
  const [globalFont, setGlobalFont] = useState<number>(() => getAppSettings().markdownFontSize);
  useEffect(() => subscribeAppSettings((s) => setGlobalFont(s.markdownFontSize)), []);
  const effectiveFontSize = baseFontSize ?? globalFont;
  // Keep the latest onLinkClick in a ref so handleLinkClick (and thus the
  // memoized componentMap) stays identity-stable even when callers pass a
  // fresh inline handler on every render.
  const onLinkClickRef = useRef(onLinkClick);
  onLinkClickRef.current = onLinkClick;
  const mergedContainer: CSSProperties = {
    ...containerStyle,
    fontSize: effectiveFontSize,
    ...style,
  };

  const handleLinkClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>, href: string | undefined) => {
      if (!href) return;
      // Anchor-only links — scroll within the rendered preview.
      if (href.startsWith("#")) {
        e.preventDefault();
        const id = decodeURIComponent(href.slice(1));
        const root = (e.currentTarget.ownerDocument || document)
          .querySelector('[data-testid="markdown-content"]');
        if (root) {
          const escapeId = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/"/g, "\\\"");
          let target: Element | null;
          try { target = root.querySelector(`#${escapeId}`); } catch { target = null; }
          if (!target) {
            target = Array.from(root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")).find((h) =>
              slugify(h.textContent || "") === id
            ) ?? null;
          }
          (target as HTMLElement | null)?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        return;
      }
      // External http(s) / mailto: / data: / blob: — open via system handler.
      if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) {
        if (/^https?:|^mailto:|^tel:/i.test(href)) {
          e.preventDefault();
          openUrl(href).catch(() => { /* swallow; opener may not be configured */ });
        }
        return;
      }
      // Internal relative path — needs basePath + a host handler. Without
      // either, fall through to native (broken) behaviour so we don't
      // regress unrelated callsites. We read onLinkClick through a ref so
      // an unstable inline handler prop doesn't churn this callback's
      // identity (which would rebuild componentMap and remount images).
      const onLinkClick = onLinkClickRef.current;
      if (!basePath || !onLinkClick) return;
      e.preventDefault();
      const resolved = resolveRelativePath(basePath, href);
      onLinkClick(resolved, classifyLinkTarget(resolved));
    },
    [basePath],
  );

  // Memoize the component map so the custom `img`/`a` renderers keep stable
  // function identities across re-renders. Without this, every host re-render
  // hands react-markdown brand-new component functions, which React treats as
  // new component *types* and remounts — restarting ResolvedImg's async image
  // load (and revoking its blob) on a loop. That produced blank, flickering
  // images that never settled.
  const componentMap = useMemo(() => ({
    ...components,
    ...(basePath
      ? { img: (props: { src?: string; alt?: string }) => <ResolvedImg {...props} basePath={basePath} /> }
      : null),
    a: ({ children: c, href }: { children?: ReactNode; href?: string }) => (
      <a
        href={href}
        style={linkStyle}
        onClick={(e) => handleLinkClick(e, href)}
        target="_blank"
        rel="noreferrer noopener"
      >
        {c}
      </a>
    ),
  }), [basePath, handleLinkClick]);

  // Extract a YAML-style frontmatter block (used by Copilot skill .md files,
  // Jekyll/Obsidian/MkDocs notes, etc.) and render it as a labeled metadata
  // card above the body. Without this it would land as a huge paragraph of
  // "name: x description: ..." text in the rendered output.
  const { fields: frontmatter, body, hasFrontmatter } = useMemo(
    () => extractFrontmatter(children),
    [children],
  );

  return (
    <div className={className} style={mergedContainer} data-testid="markdown-content">
      {hasFrontmatter && frontmatter.length > 0 ? (
        <FrontmatterCard fields={frontmatter} baseFontSize={effectiveFontSize} />
      ) : null}
      <Markdown remarkPlugins={[remarkGfm]} components={componentMap}>
        {body}
      </Markdown>
    </div>
  );
}

function FrontmatterCard({
  fields,
  baseFontSize,
}: {
  fields: Array<{ key: string; value: string }>;
  baseFontSize: number;
}): ReactNode {
  return (
    <div
      data-testid="markdown-frontmatter"
      style={{
        margin: "0 0 16px 0",
        padding: "10px 12px",
        border: "1px solid #313244",
        borderRadius: 6,
        background: "#1a1a23",
        fontSize: baseFontSize * 0.85,
        lineHeight: 1.5,
      }}
    >
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          {fields.map((f) => (
            <tr key={f.key}>
              <td
                style={{
                  color: "#89b4fa",
                  fontWeight: 600,
                  textTransform: "lowercase",
                  whiteSpace: "nowrap",
                  verticalAlign: "top",
                  padding: "2px 12px 2px 0",
                  width: 1, // shrink-to-fit
                }}
              >
                {f.key}
              </td>
              <td
                style={{
                  color: "#cdd6f4",
                  wordBreak: "break-word",
                  padding: "2px 0",
                }}
              >
                {f.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
}

/**
 * Image component that resolves relative `src` against `basePath` and
 * loads disk-resident image files through Tauri's read_file_base64.
 * Falls back to the raw src for URLs / absolute paths / unknown extensions.
 */
function ResolvedImg({ src, alt, basePath }: { src?: string; alt?: string; basePath: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);
  const resolved = src ? resolveRelativePath(basePath, src) : "";

  useEffect(() => {
    if (!src) return;
    // Pass through scheme URLs (http, data, blob, asset) untouched.
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) {
      setBlobUrl(src);
      return;
    }
    if (!isImageFile(resolved)) {
      setBlobUrl(resolved);
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    (async () => {
      try {
        const b64 = await invoke<string>("read_file_base64", { path: resolved });
        if (cancelled) return;
        const r = makeImageBlobUrl(resolved, b64);
        createdUrl = r.url;
        setBlobUrl(r.url);
      } catch {
        if (!cancelled) setErrored(true);
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [src, resolved]);

  if (errored) {
    return (
      <span data-testid="markdown-image-error" style={imgErrorStyle}>
        ⚠ Failed to load image: {resolved || src || alt}
      </span>
    );
  }
  // 1x1 transparent png as placeholder while loading — avoids React's
  // "empty string src" warning + an extra network round-trip in DOM.
  const PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  return (
    <img
      src={blobUrl ?? PLACEHOLDER}
      alt={alt}
      style={imgStyle}
      // Surface a real load failure (network for URLs, decode for blobs).
      // Without this a broken image is silent — the user just sees nothing.
      onError={() => setErrored(true)}
    />
  );
}

const containerStyle: CSSProperties = {
  background: "#1e1e2e",
  color: "#cdd6f4",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  fontSize: 14,
  lineHeight: 1.6,
  padding: "16px 24px",
};

const codeFont = "'Cascadia Code', 'Consolas', 'Courier New', monospace";

function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    // @ts-expect-error react node children traversal
    return extractText(node.props.children);
  }
  return "";
}

const components = {
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 style={h1Style}>{children}</h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 style={h2Style}>{children}</h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 style={h3Style}>{children}</h3>
  ),
  h4: ({ children }: { children?: ReactNode }) => (
    <h4 style={h4Style}>{children}</h4>
  ),
  h5: ({ children }: { children?: ReactNode }) => (
    <h5 style={h5Style}>{children}</h5>
  ),
  h6: ({ children }: { children?: ReactNode }) => (
    <h6 style={h6Style}>{children}</h6>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p style={pStyle}>{children}</p>
  ),
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    // Default fallback when MarkdownView is rendered without onLinkClick.
    // Kept for backwards compatibility — replaced at render time when the
    // host provides handling.
    <a href={href} style={linkStyle} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  hr: () => <hr style={hrStyle} />,
  img: ({ src, alt }: { src?: string; alt?: string }) => (
    <img src={src} alt={alt} style={imgStyle} />
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote style={blockquoteStyle}>{children}</blockquote>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul style={listStyle}>{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol style={listStyle}>{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <li style={liStyle}>{children}</li>
  ),
  table: ({ children }: { children?: ReactNode }) => (
    <div style={{ overflowX: "auto" }}>
      <table style={tableStyle}>{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: ReactNode }) => (
    <thead style={theadStyle}>{children}</thead>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th style={thStyle}>{children}</th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td style={tdStyle}>{children}</td>
  ),
  tr: ({ children }: { children?: ReactNode }) => (
    <tr style={trStyle}>{children}</tr>
  ),
  pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
  code({
    inline,
    className,
    children,
  }: {
    inline?: boolean;
    className?: string;
    children?: ReactNode;
  }) {
    const text = extractText(children).replace(/\n$/, "");
    const match = /language-([\w-]+)/.exec(className ?? "");
    const lang = match?.[1];

    // react-markdown v9+ does not pass `inline`; infer from presence of newline / language class.
    const isBlock = lang !== undefined || /\n/.test(text);

    if (!isBlock || inline) {
      return <code style={inlineCodeStyle}>{children}</code>;
    }

    if (lang === "mermaid") {
      return <MermaidDiagram source={text} />;
    }

    return (
      <div style={codeBlockWrapperStyle}>
        <SyntaxHighlighter
          // Fall back to plaintext for unregistered languages so we don't
          // pay the "render once then re-tokenize when grammar arrives"
          // dance that produced visible color shifts mid-scroll. Anything
          // we actually care about is registered above.
          language={lang && REGISTERED_LANGS[lang.toLowerCase()] ? lang.toLowerCase() : "text"}
          style={vscDarkPlus}
          PreTag="div"
          customStyle={{
            margin: 0,
            padding: 14,
            background: "#1e1e1e",
            fontSize: 13,
            fontFamily: codeFont,
            border: "1px solid #313244",
            borderRadius: 6,
          }}
          codeTagProps={{ style: { fontFamily: codeFont } }}
        >
          {text}
        </SyntaxHighlighter>
      </div>
    );
  },
};

const h1Style: CSSProperties = {
  fontSize: "2em",
  fontWeight: 600,
  color: "#cdd6f4",
  borderBottom: "1px solid #313244",
  paddingBottom: 10,
  marginTop: 24,
  marginBottom: 16,
};
const h2Style: CSSProperties = {
  fontSize: "1.6em",
  fontWeight: 600,
  color: "#cdd6f4",
  borderBottom: "1px solid #313244",
  paddingBottom: 6,
  marginTop: 28,
  marginBottom: 14,
};
const h3Style: CSSProperties = {
  fontSize: "1.3em",
  fontWeight: 600,
  color: "#cdd6f4",
  marginTop: 22,
  marginBottom: 10,
};
const h4Style: CSSProperties = {
  fontSize: "1.15em",
  fontWeight: 600,
  color: "#cdd6f4",
  marginTop: 18,
  marginBottom: 8,
};
const h5Style: CSSProperties = {
  fontSize: "1em",
  fontWeight: 600,
  color: "#bac2de",
  marginTop: 16,
  marginBottom: 6,
};
const h6Style: CSSProperties = {
  fontSize: "0.92em",
  fontWeight: 600,
  color: "#a6adc8",
  marginTop: 14,
  marginBottom: 6,
};

const pStyle: CSSProperties = { margin: "10px 0" };
const linkStyle: CSSProperties = { color: "#89b4fa", textDecoration: "none" };
const hrStyle: CSSProperties = {
  border: "none",
  borderTop: "1px solid #313244",
  margin: "24px 0",
};
const imgStyle: CSSProperties = {
  maxWidth: "100%",
  borderRadius: 4,
};

const imgErrorStyle: CSSProperties = {
  display: "inline-block",
  padding: "6px 10px",
  border: "1px dashed #f38ba8",
  borderRadius: 4,
  color: "#f38ba8",
  fontSize: "0.9em",
  background: "rgba(243, 139, 168, 0.08)",
};

const blockquoteStyle: CSSProperties = {
  borderLeft: "4px solid #45475a",
  margin: "12px 0",
  padding: "4px 14px",
  color: "#a6adc8",
  fontStyle: "italic",
  background: "rgba(49, 50, 68, 0.3)",
  borderRadius: "0 4px 4px 0",
};

const listStyle: CSSProperties = {
  paddingLeft: 28,
  margin: "8px 0",
};
const liStyle: CSSProperties = { margin: "4px 0" };

const tableStyle: CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  margin: "14px 0",
  fontSize: "0.95em",
};
const theadStyle: CSSProperties = { borderBottom: "2px solid #313244" };
const trStyle: CSSProperties = { borderBottom: "1px solid #313244" };
const thStyle: CSSProperties = {
  padding: "8px 12px",
  textAlign: "left",
  fontWeight: 600,
  color: "#cdd6f4",
};
const tdStyle: CSSProperties = {
  padding: "8px 12px",
  color: "#cdd6f4",
};

const inlineCodeStyle: CSSProperties = {
  background: "#313244",
  padding: "1px 6px",
  borderRadius: 3,
  fontSize: "0.9em",
  fontFamily: codeFont,
  color: "#f5c2e7",
};

const codeBlockWrapperStyle: CSSProperties = {
  margin: "12px 0",
};
