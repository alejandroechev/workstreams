import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";

import { WorkstreamQuickNote } from "../WorkstreamQuickNote";
import { MemoryBackend } from "../../backend/memory-backend";

let backend: MemoryBackend;

beforeEach(() => {
  backend = new MemoryBackend();
});

describe("WorkstreamQuickNote", () => {
  it("stays out of the way when the workstream has no task", async () => {
    // Case 3 from the design: workstreams without tasks are normal, and the
    // bar must not nag about it.
    render(<WorkstreamQuickNote backend={backend} workstreamId="w1" />);
    await waitFor(() => expect(screen.queryByTestId("quick-note-input")).not.toBeInTheDocument());
  });

  it("logs a note against the task linked to this workstream", async () => {
    // The adoption path: if logging is slower than editing the wiki, nobody
    // switches. This must work without opening the board at all.
    const task = await backend.createTask("offline sdk", { workstreamId: "w1" });
    render(<WorkstreamQuickNote backend={backend} workstreamId="w1" />);

    const input = await screen.findByTestId("quick-note-input");
    fireEvent.change(input, { target: { value: "synced with Erwin on read patterns" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(async () => {
      const events = await backend.listTaskEvents(task.id);
      expect(events.map((e) => e.text)).toEqual(["synced with Erwin on read patterns"]);
    });
  });

  it("records the note as manual so it reaches the exported page", async () => {
    const task = await backend.createTask("offline sdk", { workstreamId: "w1" });
    render(<WorkstreamQuickNote backend={backend} workstreamId="w1" />);

    const input = await screen.findByTestId("quick-note-input");
    fireEvent.change(input, { target: { value: "a note" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(async () => {
      expect((await backend.listTaskEvents(task.id))[0].source).toBe("manual");
    });
  });

  it("clears the box after logging so the next note can be typed straight away", async () => {
    await backend.createTask("offline sdk", { workstreamId: "w1" });
    render(<WorkstreamQuickNote backend={backend} workstreamId="w1" />);

    const input = (await screen.findByTestId("quick-note-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "a note" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(input.value).toBe(""));
  });

  it("ignores a blank note", async () => {
    const task = await backend.createTask("offline sdk", { workstreamId: "w1" });
    render(<WorkstreamQuickNote backend={backend} workstreamId="w1" />);

    const input = await screen.findByTestId("quick-note-input");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await new Promise((r) => setTimeout(r, 20));
    expect(await backend.listTaskEvents(task.id)).toHaveLength(0);
  });

  it("names the task it will log against, so the target is never ambiguous", async () => {
    await backend.createTask("media_store read API", { workstreamId: "w1" });
    render(<WorkstreamQuickNote backend={backend} workstreamId="w1" />);
    expect(await screen.findByText(/media_store read API/)).toBeInTheDocument();
  });

  it("lets the user choose when several tasks share the workstream", async () => {
    // Nothing constrains one task per workstream, and silently picking the
    // first would file notes under the wrong task in the archive.
    await backend.createTask("first task", { workstreamId: "w1" });
    const second = await backend.createTask("second task", { workstreamId: "w1" });

    render(<WorkstreamQuickNote backend={backend} workstreamId="w1" />);
    const picker = (await screen.findByTestId("quick-note-target")) as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: second.id } });

    const input = screen.getByTestId("quick-note-input");
    fireEvent.change(input, { target: { value: "goes to the second one" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(async () => {
      expect((await backend.listTaskEvents(second.id)).map((e) => e.text)).toEqual([
        "goes to the second one",
      ]);
    });
  });

  it("shows no picker when there is only one task", async () => {
    await backend.createTask("only task", { workstreamId: "w1" });
    render(<WorkstreamQuickNote backend={backend} workstreamId="w1" />);
    await screen.findByTestId("quick-note-input");
    expect(screen.queryByTestId("quick-note-target")).not.toBeInTheDocument();
  });

  it("reports a failure instead of looking like it logged the note", async () => {
    const task = await backend.createTask("x", { workstreamId: "w1" });
    const failing = {
      listTasks: async () => [task],
      addTaskEvent: async () => {
        throw new Error("db is gone");
      },
    } as unknown as MemoryBackend;

    render(<WorkstreamQuickNote backend={failing} workstreamId="w1" />);
    const input = await screen.findByTestId("quick-note-input");
    fireEvent.change(input, { target: { value: "a note" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("db is gone")).toBeInTheDocument();
  });

  it("ignores tasks linked to a different workstream", async () => {
    await backend.createTask("someone else's task", { workstreamId: "w2" });
    render(<WorkstreamQuickNote backend={backend} workstreamId="w1" />);
    await waitFor(() => expect(screen.queryByTestId("quick-note-input")).not.toBeInTheDocument());
  });
});
