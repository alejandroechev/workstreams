import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import WorkstreamSidebar from "../WorkstreamSidebar";
import type { Project, Workstream } from "../../domain/types";
import type { WorkLane } from "../../domain/work-lanes";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const now = new Date().toISOString();

const mkWs = (id: string, over: Partial<Workstream> = {}): Workstream => ({
  id,
  name: id,
  description: null,
  directory: null,
  git_repo: null,
  git_branch: null,
  status: "active",
  project_id: null,
  workstream_type: "standalone",
  worktree_branch: null,
  created_at: now,
  updated_at: now,
  ...over,
});

const project: Project = {
  id: "p1",
  name: "waimea",
  directory: "/repos/waimea",
  git_remote: null,
  color: "#89b4fa",
  copilot_command: null,
  created_at: now,
  updated_at: now,
};

const lane = (id: string, name: string): WorkLane => ({ id, name });

function renderSidebar(
  workstreams: Workstream[],
  over: Partial<React.ComponentProps<typeof WorkstreamSidebar>> = {},
) {
  render(
    <WorkstreamSidebar
      projects={[project]}
      workstreams={workstreams}
      loadedWsIds={new Set()}
      activeWsId={null}
      onSelectWorkstream={vi.fn()}
      onCreateProject={vi.fn()}
      onImportProject={vi.fn()}
      onCreateWorkstream={vi.fn()}
      onArchiveWorkstream={vi.fn()}
      onRenameWorkstream={vi.fn()}
      onUpdateProject={vi.fn()}
      onChangeStatus={vi.fn()}
      {...over}
    />,
  );
}

function type(text: string) {
  fireEvent.change(screen.getByTestId("ws-search-input"), { target: { value: text } });
}

function visibleNames(): string[] {
  return screen
    .queryAllByTestId("workstream-item")
    .map((node) => node.getAttribute("data-workstream-id") ?? "");
}

afterEach(cleanup);

describe("workstream list search", () => {
  it("shows everything when the box is empty", () => {
    renderSidebar([mkWs("media store"), mkWs("encoder")]);
    expect(visibleNames().sort()).toEqual(["encoder", "media store"]);
  });

  it("narrows to the rows whose name matches", () => {
    renderSidebar([mkWs("media store"), mkWs("encoder")]);
    type("media");
    expect(visibleNames()).toEqual(["media store"]);
  });

  it("ignores case", () => {
    renderSidebar([mkWs("Media Store"), mkWs("encoder")]);
    type("MEDIA");
    expect(visibleNames()).toEqual(["Media Store"]);
  });

  it("matches on the repo name as well as the workstream name", () => {
    renderSidebar([mkWs("fix encoder", { project_id: "p1" }), mkWs("unrelated")]);
    type("waimea");
    expect(visibleNames()).toEqual(["fix encoder"]);
  });

  it("clears on Escape", () => {
    renderSidebar([mkWs("media store"), mkWs("encoder")]);
    type("media");
    expect(visibleNames()).toEqual(["media store"]);
    fireEvent.keyDown(screen.getByTestId("ws-search-input"), { key: "Escape" });
    expect(visibleNames().sort()).toEqual(["encoder", "media store"]);
  });

  /**
   * The row that must never vanish. `create_failed` has no other signal in the
   * UI, so a search that hides it hides the only evidence something is broken.
   */
  it("keeps a failed creation visible even when it does not match", () => {
    renderSidebar([
      mkWs("media store"),
      mkWs("broken one", { status: "create_failed" }),
    ]);
    type("media");
    expect(visibleNames().sort()).toEqual(["broken one", "media store"]);
  });

  it("does not extend that courtesy to a workstream merely being created", () => {
    renderSidebar([
      mkWs("media store"),
      mkWs("pending one", { status: "creating" }),
    ]);
    type("media");
    expect(visibleNames()).toEqual(["media store"]);
  });
});

describe("workstream list search and lanes", () => {
  const lanes = [lane("l1", "Alpha"), lane("l2", "Beta")];
  const rows = [
    mkWs("alpha work", { lane_id: "l1" }),
    mkWs("beta work", { lane_id: "l2" }),
  ];

  it("keeps every lane visible when not searching, so each stays a drop target", () => {
    renderSidebar(rows, { lanes });
    expect(screen.queryByTestId("ws-lane-l1")).toBeInTheDocument();
    expect(screen.queryByTestId("ws-lane-l2")).toBeInTheDocument();
  });

  it("hides lanes with no matches while searching", () => {
    renderSidebar(rows, { lanes });
    type("alpha");
    expect(screen.queryByTestId("ws-lane-l1")).toBeInTheDocument();
    expect(screen.queryByTestId("ws-lane-l2")).not.toBeInTheDocument();
  });

  it("brings the empty lanes back when the search is cleared", () => {
    renderSidebar(rows, { lanes });
    type("alpha");
    type("");
    expect(screen.queryByTestId("ws-lane-l2")).toBeInTheDocument();
  });
});

describe("workstream list search across filter stops", () => {
  /**
   * The search looks broken otherwise: you are on Loaded, you type the name of
   * something archived, and the list empties with no clue that changing the
   * stop would find it.
   */
  it("says so when the only matches are under another stop", () => {
    renderSidebar([
      mkWs("media store", { status: "archived" }),
      mkWs("encoder"),
    ]);
    type("media");
    expect(visibleNames()).toEqual([]);
    expect(screen.getByTestId("ws-search-elsewhere")).toHaveTextContent("1");
  });

  it("stays quiet when nothing matches anywhere", () => {
    renderSidebar([mkWs("encoder")]);
    type("zzz");
    expect(screen.queryByTestId("ws-search-elsewhere")).not.toBeInTheDocument();
  });

  it("stays quiet when the matches are on screen", () => {
    renderSidebar([mkWs("media store"), mkWs("encoder")]);
    type("media");
    expect(screen.queryByTestId("ws-search-elsewhere")).not.toBeInTheDocument();
  });
});

/**
 * The hidden-count badge means "the stop you picked is holding rows back".
 * Folding the text query into it made every lane sprout a "2 hidden" badge
 * mid-search, announcing that a search hides non-matches.
 */
describe("workstream list search and the hidden-count badge", () => {
  it("does not count rows hidden by the search itself", () => {
    renderSidebar([mkWs("media store"), mkWs("encoder")]);
    type("media");
    expect(screen.queryByTestId("ws-lane-hidden-__no_lane__")).not.toBeInTheDocument();
  });

  it("still counts rows the filter stop is holding back", () => {
    // "media pipeline" matches the text but is archived, so under the default
    // Not archived stop it is genuinely hidden by the stop -- worth saying.
    renderSidebar([
      mkWs("media store"),
      mkWs("media pipeline", { status: "archived" }),
    ]);
    type("media");
    expect(screen.getByTestId("ws-lane-hidden-__no_lane__")).toBeInTheDocument();
  });
});
