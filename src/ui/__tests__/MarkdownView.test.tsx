import { describe, it, expect, vi, afterAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MarkdownView } from "../MarkdownView";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// MermaidDiagram lazy-loads scripts in jsdom which would fail; stub it.
vi.mock("../MermaidDiagram", () => ({
  MermaidDiagram: ({ source }: { source: string }) => (
    <div data-testid="mermaid-stub">{source}</div>
  ),
}));

const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
URL.createObjectURL = vi.fn(() => "blob:test-img") as typeof URL.createObjectURL;
URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;

afterAll(() => {
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
});

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

  describe("image resolution", () => {
    it("passes through scheme URLs untouched and does not invoke", () => {
      invokeMock.mockClear();
      const md = "![alt](https://example.com/x.png)";
      const { container } = render(<MarkdownView basePath="/repo">{md}</MarkdownView>);
      const img = container.querySelector("img") as HTMLImageElement;
      expect(img.src).toBe("https://example.com/x.png");
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it("resolves a relative image path against basePath via read_file_base64", async () => {
      invokeMock.mockReset();
      invokeMock.mockImplementation((cmd: string, args: { path: string }) => {
        if (cmd === "read_file_base64") {
          expect(args.path).toBe("/repo/docs/images/01.png");
          return Promise.resolve("aGVsbG8=");
        }
        return Promise.resolve("");
      });
      const md = "![alt](images/01.png)";
      const { container } = render(<MarkdownView basePath="/repo/docs">{md}</MarkdownView>);
      await waitFor(() => {
        const img = container.querySelector("img") as HTMLImageElement;
        expect(img.src).toBe("blob:test-img");
      });
      expect(invokeMock).toHaveBeenCalledWith("read_file_base64", { path: "/repo/docs/images/01.png" });
    });

    it("walks up with ../ when resolving", async () => {
      invokeMock.mockReset();
      invokeMock.mockImplementation((cmd: string, args: { path: string }) => {
        if (cmd === "read_file_base64") {
          expect(args.path).toBe("/repo/shot.png");
          return Promise.resolve("aGVsbG8=");
        }
        return Promise.resolve("");
      });
      const { container } = render(<MarkdownView basePath="/repo/docs/tutorial">{"![](../../shot.png)"}</MarkdownView>);
      await waitFor(() => {
        expect((container.querySelector("img") as HTMLImageElement).src).toBe("blob:test-img");
      });
    });

    it("falls back to a plain <img src> when no basePath is supplied", () => {
      invokeMock.mockClear();
      const { container } = render(<MarkdownView>{"![](images/01.png)"}</MarkdownView>);
      const img = container.querySelector("img") as HTMLImageElement;
      // No basePath means the original components.img runs — relative src is preserved untouched.
      expect(img.getAttribute("src")).toBe("images/01.png");
      expect(invokeMock).not.toHaveBeenCalled();
    });
  });
});
