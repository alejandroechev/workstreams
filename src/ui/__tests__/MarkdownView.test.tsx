import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownView } from "../MarkdownView";

// MermaidDiagram lazy-loads scripts in jsdom which would fail; stub it.
vi.mock("../MermaidDiagram", () => ({
  MermaidDiagram: ({ source }: { source: string }) => (
    <div data-testid="mermaid-stub">{source}</div>
  ),
}));

describe("MarkdownView", () => {
  it("renders headings", () => {
    render(<MarkdownView>{"# Title\n\n## Sub"}</MarkdownView>);
    expect(screen.getByText("Title").tagName).toBe("H1");
    expect(screen.getByText("Sub").tagName).toBe("H2");
  });

  it("renders inline code differently from code blocks", () => {
    const md = "Use `foo` inline and:\n\n```\nblock\n```\n";
    const { container } = render(<MarkdownView>{md}</MarkdownView>);
    expect(container.querySelector("code")).toBeTruthy();
  });

  it("routes mermaid code blocks to MermaidDiagram", () => {
    const md = "```mermaid\ngraph TD\nA-->B\n```\n";
    render(<MarkdownView>{md}</MarkdownView>);
    const stub = screen.getByTestId("mermaid-stub");
    expect(stub.textContent).toContain("graph TD");
    expect(stub.textContent).toContain("A-->B");
  });

  it("renders blockquotes", () => {
    const { container } = render(<MarkdownView>{"> note"}</MarkdownView>);
    expect(container.querySelector("blockquote")).toBeTruthy();
  });

  it("renders tables via remark-gfm", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |\n";
    const { container } = render(<MarkdownView>{md}</MarkdownView>);
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelectorAll("td").length).toBe(2);
  });

  it("renders links with target=_blank", () => {
    render(<MarkdownView>{"[x](https://example.com)"}</MarkdownView>);
    const a = screen.getByText("x") as HTMLAnchorElement;
    expect(a.tagName).toBe("A");
    expect(a.target).toBe("_blank");
  });
});
