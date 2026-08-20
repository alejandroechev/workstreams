import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { TaskBoard } from "../TaskBoard";
import { MemoryBackend } from "../../backend/memory-backend";
import type { Project, Workstream } from "../../domain/types";

function ws(id: string, projectId: string | null): Workstream {
  return {
    id,
    name: id,
    description: null,
    directory: null,
    git_repo: null,
    git_branch: null,
    status: "active",
    project_id: projectId,
    workstream_type: "standalone",
    worktree_branch: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const REPO: Project = {
  id: "repo-a",
  name: "waimea",
  directory: "/Code/waimea",
  git_remote: null,
  color: "#89b4fa",
  copilot_command: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

let backend: MemoryBackend;

async function seed() {
  backend = new MemoryBackend();
  const a = await backend.createTask("offline sdk with mock storage", { status: "in_progress" });
  await backend.setTaskLabels(a.id, ["OfflineSDK"]);
  const b = await backend.createTask("Create Kusto DB", { status: "blocked" });
  await backend.setTaskLabels(b.id, ["AI Crew"]);
  const c = await backend.createTask("unlabelled chore");
  return { a, b, c };
}

function renderBoard(over: Record<string, unknown> = {}) {
  return render(
    <TaskBoard
      backend={backend}
      workstreams={[ws("w1", "repo-a")]}
      projects={[REPO]}
      onClose={vi.fn()}
      {...over}
    />,
  );
}

beforeEach(async () => {
  await seed();
});

describe("TaskBoard", () => {
  it("renders every column, including the empty ones", async () => {
    renderBoard();
    await screen.findByText("offline sdk with mock storage");
    for (const id of ["todo", "in_progress", "in_review", "blocked", "parked", "delegated", "done"]) {
      expect(screen.getByTestId(`board-column-${id}`)).toBeInTheDocument();
    }
  });

  it("groups tasks into swimlanes by label, with a lane for unlabelled work", async () => {
    renderBoard();
    await screen.findByText("offline sdk with mock storage");
    expect(screen.getByTestId("swimlane-OfflineSDK")).toBeInTheDocument();
    expect(screen.getByTestId("swimlane-AI Crew")).toBeInTheDocument();
    expect(screen.getByTestId("swimlane-No label")).toBeInTheDocument();
  });

  it("places a card in the column its status maps to", async () => {
    renderBoard();
    await screen.findByText("offline sdk with mock storage");
    const lane = screen.getByTestId("swimlane-OfflineSDK");
    const column = within(lane).getByTestId("lane-column-in_progress");
    expect(within(column).getByText("offline sdk with mock storage")).toBeInTheDocument();
  });

  it("creates a task from the composer", async () => {
    renderBoard();
    await screen.findByText("offline sdk with mock storage");

    fireEvent.change(screen.getByTestId("new-task-input"), {
      target: { value: "media_store read API" },
    });
    fireEvent.click(screen.getByTestId("new-task-submit"));

    await screen.findByText("media_store read API");
    expect((await backend.listTasks()).map((t) => t.title)).toContain("media_store read API");
  });

  it("moves a card to another column and records the move as an event", async () => {
    const { a } = await seed();
    renderBoard();
    await screen.findByText("offline sdk with mock storage");

    fireEvent.click(screen.getByTestId(`task-card-${a.id}`));
    fireEvent.change(await screen.findByTestId("detail-status"), {
      target: { value: "in_review" },
    });

    await waitFor(async () => {
      const task = (await backend.listTasks()).find((t) => t.id === a.id)!;
      expect(task.status).toBe("in_review");
    });
    const events = await backend.listTaskEvents(a.id);
    expect(events.some((e) => e.kind === "status" && e.source === "auto")).toBe(true);
  });

  it("hides work finished on an earlier day until show-all is toggled", async () => {
    const done = await backend.createTask("finished long ago");
    await backend.updateTask(done.id, { status: "done" });

    // Render as if it were a later day, so the task's completion is genuinely
    // in the past. Mutating the returned task would not work -- listTasks
    // hands back clones on purpose.
    renderBoard({ today: "2026-12-31" });
    await screen.findByText("offline sdk with mock storage");
    expect(screen.queryByText("finished long ago")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("toggle-show-all-done"));
    expect(await screen.findByText("finished long ago")).toBeInTheDocument();
  });

  it("adds a note without offering any way to edit one", async () => {
    const { a } = await seed();
    renderBoard();
    await screen.findByText("offline sdk with mock storage");
    fireEvent.click(screen.getByTestId(`task-card-${a.id}`));

    fireEvent.change(await screen.findByTestId("log-input"), {
      target: { value: "picked this back up after the review comments" },
    });
    fireEvent.click(screen.getByTestId("log-submit"));

    await screen.findByText("picked this back up after the review comments");
    // Immutability has to hold at the UI surface, not only in the backend.
    expect(screen.queryAllByTestId(/^event-edit-/)).toHaveLength(0);
    expect(screen.getAllByTestId(/^event-delete-/).length).toBeGreaterThan(0);
  });

  it("deletes an event, because a typed typo must not be permanent", async () => {
    const { a } = await seed();
    const event = await backend.addTaskEvent(a.id, "note", "typo");
    renderBoard();
    await screen.findByText("offline sdk with mock storage");
    fireEvent.click(screen.getByTestId(`task-card-${a.id}`));

    fireEvent.click(await screen.findByTestId(`event-delete-${event.id}`));
    await waitFor(async () => {
      expect(await backend.listTaskEvents(a.id)).toHaveLength(0);
    });
  });

  it("adds a subtask that carries its own status", async () => {
    const { a } = await seed();
    renderBoard();
    await screen.findByText("offline sdk with mock storage");
    fireEvent.click(screen.getByTestId(`task-card-${a.id}`));

    fireEvent.change(await screen.findByTestId("new-subtask-input"), {
      target: { value: "Address first round of structural reviews" },
    });
    fireEvent.click(screen.getByTestId("new-subtask-submit"));

    const select = await screen.findByTestId(/^subtask-status-/);
    fireEvent.change(select, { target: { value: "done" } });

    await waitFor(async () => {
      const task = (await backend.listTasks()).find((t) => t.id === a.id)!;
      expect(task.subtasks[0].status).toBe("done");
    });
  });

  it("reuses an existing label when a case variant is typed", async () => {
    const { c } = await seed();
    renderBoard();
    await screen.findByText("unlabelled chore");
    fireEvent.click(screen.getByTestId(`task-card-${c.id}`));

    fireEvent.change(await screen.findByTestId("label-input"), {
      target: { value: "offlinesdk" },
    });
    fireEvent.click(screen.getByTestId("label-submit"));

    await waitFor(async () => {
      const labels = await backend.listLabels();
      expect(labels.filter((l) => l.name.toLowerCase() === "offlinesdk")).toHaveLength(1);
    });
  });

  it("closes on the close button", async () => {
    const onClose = vi.fn();
    renderBoard({ onClose });
    await screen.findByText("offline sdk with mock storage");
    fireEvent.click(screen.getByTestId("board-close"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("failure surfacing", () => {
  it("shows a backend failure instead of an empty board", async () => {
    // An unhandled rejection with a silent empty board is indistinguishable
    // from "you have no tasks", which is the worst possible failure mode.
    const failing = {
      listTasks: async () => {
        throw new Error("db is gone");
      },
      listLabels: async () => [],
      listTaskEvents: async () => [],
    } as unknown as MemoryBackend;

    render(
      <TaskBoard backend={failing} workstreams={[]} projects={[]} onClose={vi.fn()} />,
    );
    expect(await screen.findByTestId("board-error")).toHaveTextContent("db is gone");
  });

  it("reports a failed mutation rather than swallowing it", async () => {
    const task = await backend.createTask("x");
    const flaky = Object.create(backend) as MemoryBackend;
    flaky.updateTask = async () => {
      throw new Error("write rejected");
    };

    render(<TaskBoard backend={flaky} workstreams={[]} projects={[]} onClose={vi.fn()} />);
    await screen.findByText("x");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));
    fireEvent.change(await screen.findByTestId("detail-status"), {
      target: { value: "done" },
    });

    expect(await screen.findByTestId("board-error")).toHaveTextContent("write rejected");
  });

  it("renders event times in the local timezone, matching the exported page", async () => {
    const task = await backend.createTask("x");
    await backend.addTaskEvent(task.id, "note", "a note");
    render(<TaskBoard backend={backend} workstreams={[]} projects={[]} onClose={vi.fn()} />);
    await screen.findByText("x");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));

    const now = new Date();
    const expected = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    expect(await screen.findByTestId("event-feed")).toHaveTextContent(expected);
  });
});

describe("failed mutations preserve typed input", () => {
  it("keeps the note in the box when the write fails", async () => {
    // Clearing on failure loses the note entirely: it is in no database and
    // no longer on screen. That is worse than not saving it.
    const task = await backend.createTask("x");
    const flaky = Object.create(backend) as MemoryBackend;
    flaky.addTaskEvent = async () => {
      throw new Error("write rejected");
    };

    render(<TaskBoard backend={flaky} workstreams={[]} projects={[]} onClose={vi.fn()} />);
    await screen.findByText("x");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));

    const input = (await screen.findByTestId("log-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hard-won context" } });
    fireEvent.click(screen.getByTestId("log-submit"));

    await screen.findByTestId("board-error");
    expect(input.value).toBe("hard-won context");
  });

  it("keeps the new task title when the write fails", async () => {
    const flaky = Object.create(backend) as MemoryBackend;
    flaky.createTask = async () => {
      throw new Error("write rejected");
    };

    render(<TaskBoard backend={flaky} workstreams={[]} projects={[]} onClose={vi.fn()} />);
    const input = (await screen.findByTestId("new-task-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "media_store read API" } });
    fireEvent.click(screen.getByTestId("new-task-submit"));

    await screen.findByTestId("board-error");
    expect(input.value).toBe("media_store read API");
  });

  it("still clears the box on success", async () => {
    const task = await backend.createTask("x");
    render(<TaskBoard backend={backend} workstreams={[]} projects={[]} onClose={vi.fn()} />);
    await screen.findByText("x");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));

    const input = (await screen.findByTestId("log-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "a note" } });
    fireEvent.click(screen.getByTestId("log-submit"));

    await waitFor(() => expect(input.value).toBe(""));
  });
});

describe("slow writes do not eat newer drafts", () => {
  it("keeps a draft typed while the previous note was still saving", async () => {
    // The success handler clears the box. If the user starts the next note
    // before the first request lands, an unconditional clear silently eats it.
    const task = await backend.createTask("x");
    let release: (() => void) | null = null;
    const slow = Object.create(backend) as MemoryBackend;
    slow.addTaskEvent = (async (...args: unknown[]) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return (MemoryBackend.prototype.addTaskEvent as never as (...a: unknown[]) => unknown).apply(
        backend,
        args,
      );
    }) as never;

    render(<TaskBoard backend={slow} workstreams={[]} projects={[]} onClose={vi.fn()} />);
    await screen.findByText("x");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));

    const input = (await screen.findByTestId("log-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "first note" } });
    fireEvent.click(screen.getByTestId("log-submit"));

    // The user carries on typing before the write lands.
    fireEvent.change(input, { target: { value: "second note in progress" } });
    release!();

    await waitFor(async () => {
      expect(await backend.listTaskEvents(task.id)).toHaveLength(1);
    });
    expect(input.value).toBe("second note in progress");
  });
});
