import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import AgentReviewTile from "../AgentReviewTile";

const listenMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

function renderTile(backend: MemoryBackend) {
  return render(
    <BackendProvider backend={backend}>
      <AgentReviewTile tileId="t1" isFocused workstreamId="ws-1" />
    </BackendProvider>,
  );
}

afterEach(() => {
  cleanup();
  listenMock.mockReset();
});

describe("AgentReviewTile", () => {
  it("creates a review on mount and shows the round", async () => {
    listenMock.mockResolvedValue(() => {});
    const backend = new MemoryBackend();
    renderTile(backend);
    expect(await screen.findByText("Agent Review")).toBeTruthy();
    expect(await screen.findByText("round 1")).toBeTruthy();
    expect(screen.getByText("No review comments yet.")).toBeTruthy();
  });

  it("adds a comment, replies as agent, then resolves the thread", async () => {
    listenMock.mockResolvedValue(() => {});
    const backend = new MemoryBackend();
    renderTile(backend);
    await screen.findByText("Agent Review");

    // Open the add form and fill it.
    fireEvent.click(screen.getByText("Comment"));
    fireEvent.change(screen.getByPlaceholderText("absolute file path"), {
      target: { value: "C:/repo/a.js" },
    });
    fireEvent.change(screen.getByPlaceholderText("line"), { target: { value: "4" } });
    fireEvent.change(screen.getByPlaceholderText("comment (markdown)"), {
      target: { value: "remove the console.log" },
    });
    fireEvent.click(screen.getByText("Add comment"));

    // Thread appears, anchored at a.js:4, status Open.
    await waitFor(() => expect(screen.getByTestId("review-thread")).toBeTruthy());
    expect(screen.getByText("a.js:4")).toBeTruthy();
    expect(screen.getByTestId("thread-status").textContent).toBe("Open");

    // Reply, then resolve.
    fireEvent.change(screen.getByPlaceholderText("reply…"), { target: { value: "will do" } });
    fireEvent.click(screen.getByText("Reply"));
    await waitFor(() => expect(screen.getByTestId("thread-reply")).toBeTruthy());

    fireEvent.click(screen.getByText("Resolve"));
    await waitFor(() => expect(screen.getByTestId("thread-status").textContent).toBe("Resolved"));
    // Once resolved, a Reopen control is offered.
    expect(screen.getByText("Reopen")).toBeTruthy();
  });

  it("subscribes to review events for live refresh", async () => {
    listenMock.mockResolvedValue(() => {});
    const backend = new MemoryBackend();
    renderTile(backend);
    await screen.findByText("Agent Review");
    const events = listenMock.mock.calls.map((c) => c[0]);
    expect(events).toContain("review:comment-updated");
    expect(events).toContain("review:round-ready");
  });
});
