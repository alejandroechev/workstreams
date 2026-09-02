import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const openUrlMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock }));

import { LinkifiedText } from "../LinkifiedText";

beforeEach(() => {
  openUrlMock.mockClear();
});

describe("LinkifiedText", () => {
  it("renders link-free text as plain text with no anchor", () => {
    const { container } = render(<LinkifiedText text="just a note" />);
    expect(container.textContent).toBe("just a note");
    expect(container.querySelector("a")).toBeNull();
  });

  it("renders nothing for empty text", () => {
    const { container } = render(<LinkifiedText text="" />);
    expect(container.textContent).toBe("");
  });

  it("turns a URL into an anchor and keeps the surrounding prose", () => {
    const { container } = render(<LinkifiedText text="see https://example.com/x for details" />);
    const anchor = container.querySelector("a")!;
    expect(anchor).toHaveAttribute("href", "https://example.com/x");
    expect(anchor).toHaveAttribute("target", "_blank");
    expect(anchor).toHaveAttribute("rel", "noreferrer noopener");
    expect(container.textContent).toBe("see https://example.com/x for details");
  });

  it("opens a clicked link through the system opener instead of navigating", () => {
    const { container } = render(<LinkifiedText text="see https://example.com/x for details" />);
    const anchor = container.querySelector("a")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(anchor, event);
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com/x");
    expect(event.defaultPrevented).toBe(true);
  });

  it("swallows an opener rejection", () => {
    openUrlMock.mockReturnValueOnce(Promise.reject(new Error("no opener")));
    const { container } = render(<LinkifiedText text="https://example.com" />);
    expect(() => fireEvent.click(container.querySelector("a")!)).not.toThrow();
  });

  it("renders markup literally without injecting elements", () => {
    const { container } = render(<LinkifiedText text="<b>hi</b>" />);
    expect(container.textContent).toBe("<b>hi</b>");
    expect(container.querySelector("b")).toBeNull();
  });

  it("keeps a trailing period out of the href", () => {
    const { container } = render(<LinkifiedText text="read https://example.com/x." />);
    expect(container.querySelector("a")).toHaveAttribute("href", "https://example.com/x");
    expect(container.textContent).toBe("read https://example.com/x.");
  });

  it("renders every URL in a multi-link string", () => {
    const { container } = render(<LinkifiedText text="a https://one.dev b https://two.dev c" />);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://one.dev", "https://two.dev"]);
  });

  it("forwards a testid and extra styles to the wrapper", () => {
    render(<LinkifiedText text="x" testid="linked" style={{ fontSize: 11 }} />);
    const el = screen.getByTestId("linked");
    expect(el).toHaveStyle({ fontSize: "11px" });
  });
});
