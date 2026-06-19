import { describe, it, expect, vi, afterAll } from "vitest";
import { useReducer } from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MarkdownView } from "../MarkdownView";

const invokeMock = vi.hoisted(() => vi.fn());
const openUrlMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock }));

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

    it("surfaces a visible error when an image fails to load in the webview", () => {
      invokeMock.mockClear();
      const md = "![alt](https://example.com/x.png)";
      const { container, getByTestId } = render(<MarkdownView basePath="/repo">{md}</MarkdownView>);
      const img = container.querySelector("img") as HTMLImageElement;
      // Simulate the WebView failing to load the image (network / blocked).
      fireEvent.error(img);
      const err = getByTestId("markdown-image-error");
      expect(err.textContent).toContain("https://example.com/x.png");
    });

    it("does not remount the image (re-invoke read_file_base64) when the parent re-renders", async () => {
      invokeMock.mockReset();
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "read_file_base64") return Promise.resolve("aGVsbG8=");
        return Promise.resolve("");
      });

      // Wrapper that can force MarkdownView to re-render with identical props,
      // simulating a host tile that re-renders frequently. The image's async
      // resolution must survive — otherwise ResolvedImg remounts and the load
      // restarts forever (the flicker bug).
      function Harness() {
        const [, force] = useReducer((n: number) => n + 1, 0);
        return (
          <div>
            <button data-testid="force" onClick={() => force()}>force</button>
            <MarkdownView basePath="/repo/docs">{"![alt](images/01.png)"}</MarkdownView>
          </div>
        );
      }

      const { container, getByTestId } = render(<Harness />);
      await waitFor(() => {
        expect((container.querySelector("img") as HTMLImageElement).src).toBe("blob:test-img");
      });
      const callsAfterLoad = invokeMock.mock.calls.filter((c) => c[0] === "read_file_base64").length;

      // Force several parent re-renders.
      fireEvent.click(getByTestId("force"));
      fireEvent.click(getByTestId("force"));
      fireEvent.click(getByTestId("force"));

      // The image must still be resolved (not reset to placeholder) and the
      // backend must NOT have been hit again.
      expect((container.querySelector("img") as HTMLImageElement).src).toBe("blob:test-img");
      const callsNow = invokeMock.mock.calls.filter((c) => c[0] === "read_file_base64").length;
      expect(callsNow).toBe(callsAfterLoad);
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

  describe("link click handling", () => {
    it("calls onLinkClick with resolved absolute path + kind for a relative .md link", () => {
      const onLinkClick = vi.fn();
      const { container } = render(
        <MarkdownView basePath="/repo/docs" onLinkClick={onLinkClick}>
          {"[next](./other.md)"}
        </MarkdownView>,
      );
      fireEvent.click(container.querySelector("a")!);
      expect(onLinkClick).toHaveBeenCalledWith("/repo/docs/other.md", "markdown");
    });

    it("classifies images and code files correctly", () => {
      const onLinkClick = vi.fn();
      const { container } = render(
        <MarkdownView basePath="/repo" onLinkClick={onLinkClick}>
          {"[img](pic.png) [code](script.ts)"}
        </MarkdownView>,
      );
      const links = container.querySelectorAll("a");
      fireEvent.click(links[0]);
      fireEvent.click(links[1]);
      expect(onLinkClick).toHaveBeenNthCalledWith(1, "/repo/pic.png", "image");
      expect(onLinkClick).toHaveBeenNthCalledWith(2, "/repo/script.ts", "file");
    });

    it("walks up with ../ when resolving relative links", () => {
      const onLinkClick = vi.fn();
      const { container } = render(
        <MarkdownView basePath="/repo/docs/tutorial" onLinkClick={onLinkClick}>
          {"[adr](../adrs/001.md)"}
        </MarkdownView>,
      );
      fireEvent.click(container.querySelector("a")!);
      expect(onLinkClick).toHaveBeenCalledWith("/repo/docs/adrs/001.md", "markdown");
    });

    it("routes http(s) links to openUrl via tauri-plugin-opener, NOT onLinkClick", () => {
      const onLinkClick = vi.fn();
      openUrlMock.mockClear();
      const { container } = render(
        <MarkdownView basePath="/repo" onLinkClick={onLinkClick}>
          {"[ext](https://example.com)"}
        </MarkdownView>,
      );
      fireEvent.click(container.querySelector("a")!);
      expect(openUrlMock).toHaveBeenCalledWith("https://example.com");
      expect(onLinkClick).not.toHaveBeenCalled();
    });

    it("anchor-only links scroll to the matching heading (no onLinkClick)", () => {
      const onLinkClick = vi.fn();
      const scrollSpy = vi.fn();
      // Stub scrollIntoView on the Element prototype for jsdom.
      const realScroll = (window as unknown as { HTMLElement: { prototype: { scrollIntoView?: () => void } } }).HTMLElement.prototype.scrollIntoView;
      (window as unknown as { HTMLElement: { prototype: { scrollIntoView: () => void } } }).HTMLElement.prototype.scrollIntoView = scrollSpy;
      try {
        const { container } = render(
          <MarkdownView basePath="/repo" onLinkClick={onLinkClick}>
            {"## Some Heading\n\n[jump](#some-heading)"}
          </MarkdownView>,
        );
        const link = container.querySelector("a")!;
        fireEvent.click(link);
        expect(onLinkClick).not.toHaveBeenCalled();
        expect(scrollSpy).toHaveBeenCalled();
      } finally {
        if (realScroll) (window as unknown as { HTMLElement: { prototype: { scrollIntoView?: () => void } } }).HTMLElement.prototype.scrollIntoView = realScroll;
      }
    });

    it("does nothing for internal links when onLinkClick is omitted", () => {
      openUrlMock.mockClear();
      const { container } = render(
        <MarkdownView basePath="/repo">{"[x](./other.md)"}</MarkdownView>,
      );
      // No throw — and no openUrl invocation for the relative href.
      fireEvent.click(container.querySelector("a")!);
      expect(openUrlMock).not.toHaveBeenCalled();
    });
  });
});
