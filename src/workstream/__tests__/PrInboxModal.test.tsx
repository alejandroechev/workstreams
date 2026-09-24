import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PrInboxModal } from "../PrInboxModal";
import type { PrInboxSnapshot } from "../../domain/pr-inbox";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
const snapshot: PrInboxSnapshot = {
  items: [{
    id: "n", project_id: "p", repo_name: "Repo", pr_id: 42, title: "Fix race",
    author: "Author", url: "https://dev.azure.com/o/p/_git/r/pullrequest/42",
    is_read: false, discovered_at: "2026-01-01T00:00:00Z",
  }],
  repos: [{ project_id: "p", repo_name: "Repo", enabled: true, last_checked: null, error: "Run az login" }],
};

describe("PR inbox", () => {
  it("shows assignments and connection errors, opens ADO and marks read", async () => {
    const onRead = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<PrInboxModal snapshot={snapshot} error={null} loading={false} onRead={onRead} onClose={onClose} />);
    expect(screen.getByText("Run az login")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "#42 Fix race" }));
    await waitFor(() => expect(onRead).toHaveBeenCalledWith("n", true));
    expect(openUrl).toHaveBeenCalledWith(snapshot.items[0].url);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("can mark unread and reports failed writes and browser opens", async () => {
    const onRead = vi.fn().mockRejectedValue(new Error("Write failed"));
    render(<PrInboxModal snapshot={{ ...snapshot, items: [{ ...snapshot.items[0], is_read: true }] }}
      error={null} loading={false} onRead={onRead} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark unread" }));
    await waitFor(() => expect(screen.getByText("Write failed")).toBeInTheDocument());
    expect(onRead).toHaveBeenCalledWith("n", false);
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("Browser failed"));
    fireEvent.click(screen.getByRole("button", { name: "#42 Fix race" }));
    await waitFor(() => expect(screen.getByText("Browser failed")).toBeInTheDocument());
  });

  it("distinguishes loading, read failure and a genuinely empty inbox", () => {
    const props = { snapshot: { items: [], repos: [] }, onRead: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<PrInboxModal {...props} loading error={null} />);
    expect(screen.getByText("Loading inbox...")).toBeInTheDocument();
    rerender(<PrInboxModal {...props} loading={false} error="Read failed" />);
    expect(screen.getByText("Read failed")).toBeInTheDocument();
    expect(screen.queryByText("No review notifications yet.")).not.toBeInTheDocument();
    rerender(<PrInboxModal {...props} loading={false} error={null} />);
    expect(screen.getByText("No review notifications yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close inbox" }));
    expect(props.onClose).toHaveBeenCalled();
  });

  /**
   * The inbox is reached from the same footer as the repo manager, so it should
   * not look like it came from a different app: same backdrop, same panel
   * chrome, same header shape, same dismissal affordances.
   */
  describe("chrome consistent with the repo manager", () => {
    it("uses the shared backdrop and panel shell", () => {
      render(<PrInboxModal snapshot={snapshot} error={null} loading={false} onRead={vi.fn()} onClose={vi.fn()} />);
      expect(screen.getByTestId("pr-inbox-backdrop")).toHaveStyle({ background: "rgba(0,0,0,0.5)" });
      expect(screen.getByTestId("pr-inbox-panel")).toHaveStyle({
        background: "#1e1e2e",
        border: "1px solid #313244",
      });
    });

    it("closes on backdrop click but not on a click inside the panel", () => {
      const onClose = vi.fn();
      render(<PrInboxModal snapshot={snapshot} error={null} loading={false} onRead={vi.fn()} onClose={onClose} />);
      fireEvent.click(screen.getByTestId("pr-inbox-panel"));
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId("pr-inbox-backdrop"));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("summarises unread and total counts in the header subtitle", () => {
      render(<PrInboxModal snapshot={snapshot} error={null} loading={false} onRead={vi.fn()} onClose={vi.fn()} />);
      expect(screen.getByTestId("pr-inbox-summary")).toHaveTextContent("1 unread of 1 assignment");
    });

    it("pluralises the subtitle and counts only unread items", () => {
      const two = {
        ...snapshot,
        items: [snapshot.items[0], { ...snapshot.items[0], id: "n2", pr_id: 43, is_read: true }],
      };
      render(<PrInboxModal snapshot={two} error={null} loading={false} onRead={vi.fn()} onClose={vi.fn()} />);
      expect(screen.getByTestId("pr-inbox-summary")).toHaveTextContent("1 unread of 2 assignments");
    });
  });
});
