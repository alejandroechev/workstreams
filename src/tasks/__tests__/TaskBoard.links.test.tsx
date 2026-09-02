import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const openUrlMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock }));

import { TaskBoard } from "../TaskBoard";
import { MemoryBackend } from "../../backend/memory-backend";

let backend: MemoryBackend;

beforeEach(() => {
  backend = new MemoryBackend();
  openUrlMock.mockClear();
});

async function openTaskWithEntry(text: string) {
  const task = await backend.createTask("media_store read API");
  await backend.addTaskEvent(task.id, "note", text);
  render(<TaskBoard backend={backend} workstreams={[]} projects={[]} onClose={vi.fn()} />);
  await screen.findByText("media_store read API");
  fireEvent.click(screen.getByTestId(`task-card-${task.id}`));
  return task;
}

describe("clickable links in the activity log", () => {
  it("renders a URL inside an entry as a link and keeps the prose intact", async () => {
    await openTaskWithEntry("see https://example.com/x for details");

    const entry = await screen.findByTestId(/^event-text-/);
    const anchor = entry.querySelector("a")!;
    expect(anchor).toHaveAttribute("href", "https://example.com/x");
    expect(anchor).toHaveAttribute("target", "_blank");
    expect(anchor).toHaveAttribute("rel", "noreferrer noopener");
    expect(entry.textContent).toBe("see https://example.com/x for details");
  });

  it("opens a clicked link with the system opener", async () => {
    await openTaskWithEntry("see https://example.com/x for details");

    const entry = await screen.findByTestId(/^event-text-/);
    fireEvent.click(entry.querySelector("a")!);
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com/x");
  });

  it("renders markup in an entry literally, never as an element", async () => {
    await openTaskWithEntry("<b>hi</b>");

    const entry = await screen.findByTestId(/^event-text-/);
    expect(entry.textContent).toBe("<b>hi</b>");
    expect(entry.querySelector("b")).toBeNull();
  });

  it("keeps a trailing period out of the href", async () => {
    await openTaskWithEntry("read https://example.com/x.");

    const entry = await screen.findByTestId(/^event-text-/);
    expect(entry.querySelector("a")).toHaveAttribute("href", "https://example.com/x");
    expect(entry.textContent).toBe("read https://example.com/x.");
  });

  it("leaves a link-free entry as plain text", async () => {
    await openTaskWithEntry("no links in this one");

    const entry = await screen.findByTestId(/^event-text-/);
    expect(entry.textContent).toBe("no links in this one");
    expect(entry.querySelector("a")).toBeNull();
  });

  it("does not touch the log input", async () => {
    await openTaskWithEntry("https://example.com");
    const input = await screen.findByTestId("log-input");
    expect(input.tagName).toBe("TEXTAREA");
  });
});

describe("clickable links in task notes", () => {
  async function openTaskWithNotes(notes: string) {
    const task = await backend.createTask("media_store read API");
    await backend.updateTask(task.id, { notes });
    render(<TaskBoard backend={backend} workstreams={[]} projects={[]} onClose={vi.fn()} />);
    await screen.findByText("media_store read API");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));
    return task;
  }

  it("lists the URLs found in the notes as clickable links", async () => {
    await openTaskWithNotes("spec at https://example.com/spec and https://example.com/api");

    const links = await screen.findByTestId("notes-links");
    const hrefs = [...links.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://example.com/spec", "https://example.com/api"]);
  });

  it("opens a clicked notes link with the system opener", async () => {
    await openTaskWithNotes("spec at https://example.com/spec");

    const links = await screen.findByTestId("notes-links");
    fireEvent.click(links.querySelector("a")!);
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com/spec");
  });

  it("keeps a trailing period out of a notes href", async () => {
    await openTaskWithNotes("spec at https://example.com/spec.");

    const links = await screen.findByTestId("notes-links");
    expect(links.querySelector("a")).toHaveAttribute("href", "https://example.com/spec");
  });

  it("hides the row when the notes hold no URL", async () => {
    await openTaskWithNotes("plain context, <b>no</b> links");

    await screen.findByTestId("detail-notes");
    expect(screen.queryByTestId("notes-links")).not.toBeInTheDocument();
  });

  it("hides the row when the notes are empty", async () => {
    await openTaskWithNotes("");

    await screen.findByTestId("detail-notes");
    expect(screen.queryByTestId("notes-links")).not.toBeInTheDocument();
  });

  it("keeps the notes textarea editable", async () => {
    await openTaskWithNotes("spec at https://example.com/spec");

    const box = (await screen.findByTestId("detail-notes")) as HTMLTextAreaElement;
    expect(box.tagName).toBe("TEXTAREA");
    expect(box.readOnly).toBe(false);
    expect(box.value).toBe("spec at https://example.com/spec");
  });

  it("tracks edits to the notes draft without waiting for a save", async () => {
    await openTaskWithNotes("no links yet");

    const box = await screen.findByTestId("detail-notes");
    fireEvent.change(box, { target: { value: "now with https://example.com/new" } });

    const links = await screen.findByTestId("notes-links");
    expect(links.querySelector("a")).toHaveAttribute("href", "https://example.com/new");
  });
});
