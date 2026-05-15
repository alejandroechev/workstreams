import { type CSSProperties, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { MermaidDiagram } from "./MermaidDiagram";

interface Props {
  children: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Shared markdown renderer for the app.
 *
 * Provides a VS Code-style dark theme: typography, headings with bottom border,
 * syntax-highlighted code blocks (vscDarkPlus), blockquotes with left border,
 * clean tables, and inline mermaid diagram rendering with zoom/pan.
 */
export function MarkdownView({ children, className, style }: Props) {
  return (
    <div className={className} style={{ ...containerStyle, ...style }}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </Markdown>
    </div>
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
          language={lang ?? "text"}
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
  fontSize: 28,
  fontWeight: 600,
  color: "#cdd6f4",
  borderBottom: "1px solid #313244",
  paddingBottom: 10,
  marginTop: 24,
  marginBottom: 16,
};
const h2Style: CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  color: "#cdd6f4",
  borderBottom: "1px solid #313244",
  paddingBottom: 6,
  marginTop: 28,
  marginBottom: 14,
};
const h3Style: CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: "#cdd6f4",
  marginTop: 22,
  marginBottom: 10,
};
const h4Style: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: "#cdd6f4",
  marginTop: 18,
  marginBottom: 8,
};
const h5Style: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "#bac2de",
  marginTop: 16,
  marginBottom: 6,
};
const h6Style: CSSProperties = {
  fontSize: 13,
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
  fontSize: 13,
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
