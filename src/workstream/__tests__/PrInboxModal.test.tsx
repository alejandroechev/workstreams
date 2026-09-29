import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PrInboxModal } from "../PrInboxModal";
import type { PrInboxItem, PrInboxSnapshot } from "../../domain/pr-inbox";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

function event(over: Partial<PrInboxItem> = {}): PrInboxItem {
  return {
    id: "n",
    project_id: "p",
    repo_name: "Repo",
    pr_id: 42,
    kind: "assigned",
    title: "Fix race",
    summary: "Assigned to you as reviewer",
    author: "Author",
    url: "https://dev.azure.com/o/p/_git/r/pullrequest/42",
    is_read: false,
    discovered_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const snapshot: PrInboxSnapshot = {
  items: [event()],
  repos: [{
    project_id: "p", repo_name: "Repo", enabled: true, mode: "both",
    last_checked: null, error: "Run az login",
  }],
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
    render(<PrInboxModal snapshot={{ ...snapshot, items: [event({ is_read: true })] }}
      error={null} loading={false} onRead={onRead} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
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
      expect(screen.getByTestId("pr-inbox-summary")).toHaveTextContent("1 unread of 1 notification");
    });

    it("pluralises the subtitle and counts only unread items", () => {
      const two = { ...snapshot, items: [event(), event({ id: "n2", pr_id: 43, is_read: true })] };
      render(<PrInboxModal snapshot={two} error={null} loading={false} onRead={vi.fn()} onClose={vi.fn()} />);
      expect(screen.getByTestId("pr-inbox-summary")).toHaveTextContent("1 unread of 2 notifications");
    });

    it("names the repo's watch mode alongside its last check", () => {
      render(<PrInboxModal snapshot={snapshot} error={null} loading={false} onRead={vi.fn()} onClose={vi.fn()} />);
      expect(screen.getByText(/Both · waiting for first successful check/)).toBeInTheDocument();
    });
  });

  /**
   * A PR that gets three comments and a failed build is one thing happening,
   * not four. Flat rows buried the PR identity and made "I have dealt with
   * this" a four-click operation.
   */
  describe("grouping a PR's events", () => {
    const busy: PrInboxSnapshot = {
      repos: snapshot.repos,
      items: [
        event({ id: "a", kind: "assigned", discovered_at: "2026-01-01T00:00:00Z", is_read: true }),
        event({ id: "b", kind: "comment", summary: "Dev commented: needs a test", discovered_at: "2026-01-03T00:00:00Z" }),
        event({ id: "c", kind: "policy", summary: "CI build failed", discovered_at: "2026-01-02T00:00:00Z" }),
        event({ id: "d", pr_id: 7, title: "Other PR", kind: "vote", summary: "Dev approved", discovered_at: "2026-01-04T00:00:00Z" }),
      ],
    };

    it("collects every event for a PR under one entry, newest first", () => {
      render(<PrInboxModal snapshot={busy} error={null} loading={false} onRead={vi.fn()} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "All" }));
      const group = screen.getByTestId("pr-group-p-42");
      const rows = within(group).getAllByRole("listitem");
      expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
        "pr-notification-b",
        "pr-notification-c",
        "pr-notification-a",
      ]);
      expect(within(group).getByText("Build gate")).toBeInTheDocument();
      expect(within(group).getByText("CI build failed")).toBeInTheDocument();
    });

    it("orders PRs by their most recent event", () => {
      render(<PrInboxModal snapshot={busy} error={null} loading={false} onRead={vi.fn()} onClose={vi.fn()} />);
      const groups = screen.getAllByTestId(/^pr-group-/);
      expect(groups.map((g) => g.getAttribute("data-testid"))).toEqual([
        "pr-group-p-7",
        "pr-group-p-42",
      ]);
    });

    it("marks a whole PR read in one click, touching only what needs it", async () => {
      const onRead = vi.fn().mockResolvedValue(undefined);
      render(<PrInboxModal snapshot={busy} error={null} loading={false} onRead={onRead} onClose={vi.fn()} />);
      const group = screen.getByTestId("pr-group-p-42");
      expect(group).toHaveAttribute("data-unread", "true");
      fireEvent.click(within(group).getByRole("button", { name: "Mark read" }));
      await waitFor(() => expect(onRead).toHaveBeenCalledTimes(2));
      expect(onRead.mock.calls.map(([id]) => id).sort()).toEqual(["b", "c"]);
    });

    it("still allows dismissing a single event", async () => {
      const onRead = vi.fn().mockResolvedValue(undefined);
      render(<PrInboxModal snapshot={busy} error={null} loading={false} onRead={onRead} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "Mark read: Dev commented: needs a test" }));
      await waitFor(() => expect(onRead).toHaveBeenCalledWith("b", true));
    });

    it("opening the PR clears its unread events but not the ones already read", async () => {
      const onRead = vi.fn().mockResolvedValue(undefined);
      render(<PrInboxModal snapshot={busy} error={null} loading={false} onRead={onRead} onClose={vi.fn()} />);
      const group = screen.getByTestId("pr-group-p-42");
      fireEvent.click(within(group).getByRole("button", { name: "#42 Fix race" }));
      await waitFor(() => expect(onRead).toHaveBeenCalledTimes(2));
      expect(onRead.mock.calls.every(([, read]) => read === true)).toBe(true);
    });
  });
  /**
   * Read notifications are history. Leaving them in the default view buried
   * the one new comment under every PR already dealt with.
   */
  describe("hiding read notifications", () => {
    const mixed: PrInboxSnapshot = {
      repos: snapshot.repos,
      items: [
        event({ id: "old", kind: "assigned", is_read: true }),
        event({ id: "new", kind: "comment", summary: "Dev: needs a test" }),
        event({ id: "done", pr_id: 7, title: "Settled PR", kind: "vote", summary: "Dev approved", is_read: true }),
      ],
    };

    it("shows only unread events by default and drops PRs with nothing unread", () => {
      render(<PrInboxModal snapshot={mixed} error={null} loading={false} onRead={vi.fn()} onClose={vi.fn()} />);
      expect(screen.getByRole("button", { name: "Unread" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("pr-notification-new")).toBeInTheDocument();
      expect(screen.queryByTestId("pr-notification-old")).not.toBeInTheDocument();
      expect(screen.queryByTestId("pr-group-p-7")).not.toBeInTheDocument();
    });

    it("reveals read notifications when switched to All, and hides them again", () => {
      render(<PrInboxModal snapshot={mixed} error={null} loading={false} onRead={vi.fn()} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "All" }));
      expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("pr-notification-old")).toBeInTheDocument();
      expect(screen.getByTestId("pr-group-p-7")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Unread" }));
      expect(screen.queryByTestId("pr-group-p-7")).not.toBeInTheDocument();
    });

    it("says the inbox is caught up rather than empty when everything is read", () => {
      const read = { ...mixed, items: mixed.items.map((item) => ({ ...item, is_read: true })) };
      render(<PrInboxModal snapshot={read} error={null} loading={false} onRead={vi.fn()} onClose={vi.fn()} />);
      expect(screen.getByTestId("pr-inbox-caught-up")).toHaveTextContent("No unread notifications. 3 read hidden.");
      expect(screen.queryByText("No review notifications yet.")).not.toBeInTheDocument();
    });
  });
});
