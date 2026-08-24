import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { TaskBoard } from "../TaskBoard";
import { MemoryBackend } from "../../backend/memory-backend";

let backend: MemoryBackend;

beforeEach(() => {
  backend = new MemoryBackend();
});

function renderBoard(over: Record<string, unknown> = {}) {
  return render(
    <TaskBoard backend={backend} workstreams={[]} projects={[]} onClose={vi.fn()} {...over} />,
  );
}

async function openTask(title = "media_store read API") {
  const task = await backend.createTask(title);
  renderBoard();
  await screen.findByText(title);
  fireEvent.click(screen.getByTestId(`task-card-${task.id}`));
  return task;
}

describe("free-form notes", () => {
  it("offers a multiline box", async () => {
    await openTask();
    const box = await screen.findByTestId("detail-notes");
    expect(box.tagName).toBe("TEXTAREA");
  });

  it("saves multi-line text on blur", async () => {
    const task = await openTask();
    const box = await screen.findByTestId("detail-notes");

    fireEvent.change(box, {
      target: { value: "sync with Erwin on read patterns\ngather precise requirements" },
    });
    fireEvent.blur(box);

    await waitFor(async () => {
      const [stored] = await backend.listTasks();
      expect(stored.notes).toBe("sync with Erwin on read patterns\ngather precise requirements");
    });
    expect(task.id).toBeTruthy();
  });

  it("keeps Enter as a newline rather than submitting", async () => {
    // The whole point is free-form multi-line text; if Enter committed, the
    // box could never hold more than one line.
    await openTask();
    const box = (await screen.findByTestId("detail-notes")) as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "line one" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await new Promise((r) => setTimeout(r, 20));
    expect(await backend.listTaskEvents()).toEqual([]);
    expect(box.value).toBe("line one");
  });

  it("is editable, unlike an event", async () => {
    await openTask();
    const box = await screen.findByTestId("detail-notes");

    fireEvent.change(box, { target: { value: "first thought" } });
    fireEvent.blur(box);
    await waitFor(async () => expect((await backend.listTasks())[0].notes).toBe("first thought"));

    fireEvent.change(box, { target: { value: "revised thought" } });
    fireEvent.blur(box);
    await waitFor(async () => expect((await backend.listTasks())[0].notes).toBe("revised thought"));
  });

  it("can be cleared", async () => {
    const task = await backend.createTask("x");
    await backend.updateTask(task.id, { notes: "something" });
    renderBoard();
    await screen.findByText("x");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));

    const box = await screen.findByTestId("detail-notes");
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.blur(box);

    await waitFor(async () => expect((await backend.listTasks())[0].notes).toBe(""));
  });

  it("does not write when nothing changed", async () => {
    await openTask();
    const spy = vi.spyOn(backend, "updateTask");
    fireEvent.blur(await screen.findByTestId("detail-notes"));

    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows the newly selected task's notes when switching cards", async () => {
    const a = await backend.createTask("first");
    const b = await backend.createTask("second");
    await backend.updateTask(a.id, { notes: "notes for A" });
    await backend.updateTask(b.id, { notes: "notes for B" });

    renderBoard();
    await screen.findByText("first");

    fireEvent.click(screen.getByTestId(`task-card-${a.id}`));
    expect(await screen.findByTestId("detail-notes")).toHaveValue("notes for A");

    fireEvent.click(screen.getByTestId(`task-card-${b.id}`));
    await waitFor(() => expect(screen.getByTestId("detail-notes")).toHaveValue("notes for B"));
  });

  it("does not record a note edit in the activity feed", async () => {
    // Notes are current state; the activity log is history. Mixing them would
    // fill the log with revisions of the same paragraph.
    await openTask();
    const box = await screen.findByTestId("detail-notes");
    fireEvent.change(box, { target: { value: "some context" } });
    fireEvent.blur(box);

    await waitFor(async () => expect((await backend.listTasks())[0].notes).toBe("some context"));
    expect(await backend.listTaskEvents()).toEqual([]);
  });

  it("shows a note indicator on the card", async () => {
    const task = await backend.createTask("x");
    await backend.updateTask(task.id, { notes: "context" });
    renderBoard();
    expect(await screen.findByTestId(`card-has-notes-${task.id}`)).toBeInTheDocument();
  });

  it("shows no indicator when there is no note", async () => {
    const task = await backend.createTask("x");
    renderBoard();
    await screen.findByText("x");
    expect(screen.queryByTestId(`card-has-notes-${task.id}`)).not.toBeInTheDocument();
  });
});

describe("activity log naming", () => {
  it("calls the append-only box a log entry, not a note", async () => {
    // Two boxes both called "note" would make it impossible to know which one
    // you are typing into.
    await openTask();
    expect(await screen.findByTestId("log-input")).toBeInTheDocument();
    expect(screen.getByTestId("log-submit")).toBeInTheDocument();
    expect(screen.queryByTestId("note-input")).not.toBeInTheDocument();
  });

  it("still appends log entries immutably", async () => {
    const task = await openTask();
    const input = await screen.findByTestId("log-input");
    fireEvent.change(input, { target: { value: "picked this back up" } });
    fireEvent.click(screen.getByTestId("log-submit"));

    await waitFor(async () => {
      expect((await backend.listTaskEvents(task.id)).map((e) => e.text)).toEqual([
        "picked this back up",
      ]);
    });
    expect(screen.queryAllByTestId(/^event-edit-/)).toHaveLength(0);
  });
});

describe("notes layout", () => {
  it("lets the notes box grow into the panel's spare height", async () => {
    // A six-row box wasted the panel's vertical space on tasks with long
    // notes, which is the field most likely to need it.
    await openTask();
    const box = await screen.findByTestId("detail-notes");
    expect(box.style.flex).toBe("1 1 0%");
    expect(box.style.minHeight).not.toBe("");
  });

  it("keeps the panel a flex column so the growth has something to fill", async () => {
    await openTask();
    const panel = screen.getByTestId("task-detail");
    expect(panel.style.display).toBe("flex");
    expect(panel.style.flexDirection).toBe("column");
    // Without minHeight:0 a flex child cannot shrink, and the box would
    // overflow the panel instead of filling it.
    expect(panel.style.minHeight).toBe("0px");
  });

  it("bounds the activity feed so notes get the slack, not the log", async () => {
    await openTask();
    const feed = screen.getByTestId("event-feed");
    expect(feed.style.maxHeight).not.toBe("");
  });
});

describe("the activity feed is scoped to today", () => {
  /** Backdate an event by writing straight into the store. */
  function backdate(id: string, iso: string) {
    const events = (backend as unknown as { taskEvents: Array<{ id: string; at: string }> })
      .taskEvents;
    events.find((e) => e.id === id)!.at = iso;
  }

  it("hides entries from earlier days", async () => {
    const task = await backend.createTask("x");
    const old = await backend.addTaskEvent(task.id, "note", "yesterday's entry");
    backdate(old.id, new Date(2020, 0, 1, 9, 0).toISOString());
    await backend.addTaskEvent(task.id, "note", "today's entry");

    renderBoard();
    await screen.findByText("x");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));

    const feed = await screen.findByTestId("event-feed");
    expect(feed).toHaveTextContent("today's entry");
    expect(feed).not.toHaveTextContent("yesterday's entry");
  });

  it("says how many earlier entries are hidden rather than losing them silently", async () => {
    const task = await backend.createTask("x");
    const old = await backend.addTaskEvent(task.id, "note", "old one");
    backdate(old.id, new Date(2020, 0, 1, 9, 0).toISOString());

    renderBoard();
    await screen.findByText("x");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));

    expect(await screen.findByTestId("event-show-all")).toHaveTextContent("1 earlier");
  });

  it("reveals them on demand, since delete lives in this list", async () => {
    // Without a way back, a typo logged yesterday could never be removed.
    const task = await backend.createTask("x");
    const old = await backend.addTaskEvent(task.id, "note", "yesterday's typo");
    backdate(old.id, new Date(2020, 0, 1, 9, 0).toISOString());

    renderBoard();
    await screen.findByText("x");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));
    fireEvent.click(await screen.findByTestId("event-show-all"));

    expect(await screen.findByTestId("event-feed")).toHaveTextContent("yesterday's typo");
    fireEvent.click(screen.getByTestId(`event-delete-${old.id}`));
    await waitFor(async () => expect(await backend.listTaskEvents(task.id)).toHaveLength(0));
  });

  it("offers no toggle when nothing is hidden", async () => {
    const task = await backend.createTask("x");
    await backend.addTaskEvent(task.id, "note", "today only");

    renderBoard();
    await screen.findByText("x");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));
    await screen.findByTestId("event-feed");

    expect(screen.queryByTestId("event-show-all")).not.toBeInTheDocument();
  });

  it("still shows a note the moment it is logged", async () => {
    const task = await backend.createTask("x");
    renderBoard();
    await screen.findByText("x");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));

    fireEvent.change(await screen.findByTestId("log-input"), { target: { value: "just now" } });
    fireEvent.click(screen.getByTestId("log-submit"));

    await waitFor(() => expect(screen.getByTestId("event-feed")).toHaveTextContent("just now"));
  });
});

describe("multi-line log entries", () => {
  it("uses a textarea so Enter is a newline", async () => {
    await openTask();
    const box = await screen.findByTestId("log-input");
    expect(box.tagName).toBe("TEXTAREA");
  });

  it("does not commit on a bare Enter", async () => {
    // Enter must insert a newline, or an entry could never hold more than one
    // line -- which is the whole point of the change.
    const task = await openTask();
    const box = (await screen.findByTestId("log-input")) as HTMLTextAreaElement;

    fireEvent.change(box, { target: { value: "line one" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await new Promise((r) => setTimeout(r, 20));
    expect(await backend.listTaskEvents(task.id)).toEqual([]);
    expect(box.value).toBe("line one");
  });

  it("commits on Cmd+Enter", async () => {
    const task = await openTask();
    const box = await screen.findByTestId("log-input");

    fireEvent.change(box, { target: { value: "first\nsecond" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });

    await waitFor(async () => {
      expect((await backend.listTaskEvents(task.id)).map((e) => e.text)).toEqual(["first\nsecond"]);
    });
  });

  it("commits on Ctrl+Enter too, for the Windows build", async () => {
    const task = await openTask();
    const box = await screen.findByTestId("log-input");

    fireEvent.change(box, { target: { value: "typed on windows" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });

    await waitFor(async () => {
      expect((await backend.listTaskEvents(task.id))[0].text).toBe("typed on windows");
    });
  });

  it("still commits from the button", async () => {
    const task = await openTask();
    fireEvent.change(await screen.findByTestId("log-input"), {
      target: { value: "via the button\nwith a second line" },
    });
    fireEvent.click(screen.getByTestId("log-submit"));

    await waitFor(async () => {
      expect((await backend.listTaskEvents(task.id))[0].text).toBe(
        "via the button\nwith a second line",
      );
    });
  });

  it("clears the box after a successful commit", async () => {
    await openTask();
    const box = (await screen.findByTestId("log-input")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "one\ntwo" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });

    await waitFor(() => expect(box.value).toBe(""));
  });

  it("preserves the newlines when rendering the entry back", async () => {
    // Collapsing them in the feed would make a multi-line entry look like it
    // had been mangled on save.
    // Seed before rendering: openTask() renders, so adding a second render
    // here would duplicate every test id.
    const task = await backend.createTask("multi-line host");
    const event = await backend.addTaskEvent(task.id, "note", "first line\nsecond line");

    renderBoard();
    await screen.findByText("multi-line host");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));

    const body = await screen.findByTestId(`event-text-${event.id}`);
    expect(body.style.whiteSpace).toBe("pre-wrap");
    expect(body).toHaveTextContent("first line");
    expect(body).toHaveTextContent("second line");
  });

  it("grows with the content rather than staying one line", async () => {
    await openTask();
    const box = await screen.findByTestId("log-input");
    expect(box.style.resize).toBe("none");
    expect(Number.parseInt(box.style.maxHeight, 10)).toBeGreaterThan(0);
  });
});
