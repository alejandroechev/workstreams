import { describe, it, expect, vi, beforeEach } from "vitest";
import { TauriBackend } from "../tauri-backend";

// Mock @tauri-apps/api/core
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("TauriBackend", () => {
  let backend: TauriBackend;

  beforeEach(() => {
    invoke.mockReset();
    backend = new TauriBackend();
  });

  it("listProjects calls list_projects", async () => {
    invoke.mockResolvedValueOnce([]);
    await backend.listProjects();
    expect(invoke).toHaveBeenCalledWith("list_projects");
  });

  it("createProject passes name/directory/color", async () => {
    invoke.mockResolvedValueOnce({ id: "p1" });
    await backend.createProject("My", "/tmp", "#fff");
    expect(invoke).toHaveBeenCalledWith("create_project", {
      name: "My",
      directory: "/tmp",
      color: "#fff",
    });
  });

  it("updateProject passes id and updates", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.updateProject("p1", { name: "Renamed" });
    expect(invoke).toHaveBeenCalledWith("update_project", expect.objectContaining({ id: "p1", name: "Renamed" }));
  });

  it("updateWorkstream passes id and updates", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.updateWorkstream("w1", { name: "Renamed", status: "blocked" });
    expect(invoke).toHaveBeenCalledWith("update_workstream", expect.objectContaining({ id: "w1", name: "Renamed", status: "blocked" }));
  });

  it("deleteProject passes id", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.deleteProject("p1");
    expect(invoke).toHaveBeenCalledWith("delete_project", { id: "p1" });
  });

  it("listWorkstreams calls list_workstreams", async () => {
    invoke.mockResolvedValueOnce([]);
    await backend.listWorkstreams();
    expect(invoke).toHaveBeenCalledWith("list_workstreams");
  });

  it("createWorkstream passes opts", async () => {
    invoke.mockResolvedValueOnce({ id: "w1" });
    await backend.createWorkstream("WS", "/dir", { projectId: "p1", workstreamType: "worktree", worktreeBranch: "branch" });
    expect(invoke).toHaveBeenCalledWith("create_workstream", {
      name: "WS",
      directory: "/dir",
      projectId: "p1",
      workstreamType: "worktree",
      worktreeBranch: "branch",
    });
  });

  it("createWorkstream works without opts", async () => {
    invoke.mockResolvedValueOnce({ id: "w1" });
    await backend.createWorkstream("WS", "/dir");
    expect(invoke).toHaveBeenCalledWith("create_workstream", expect.objectContaining({
      name: "WS",
      directory: "/dir",
    }));
  });

  it("updateLayout passes all fields when set", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.updateLayout("w1", {
      tile_order_json: "[]",
      fullscreen_tile_id: "t1",
      focused_tile_id: "t2",
      layout_mode: "vertical",
    });
    expect(invoke).toHaveBeenCalledWith("update_layout", expect.objectContaining({
      workstreamId: "w1",
      tileOrderJson: "[]",
      fullscreenTileId: "t1",
      focusedTileId: "t2",
      layoutMode: "vertical",
    }));
  });

  it("updateLayout omits undefined fields", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.updateLayout("w1", {});
    const call = invoke.mock.calls[0][1] as Record<string, unknown>;
    expect(call).not.toHaveProperty("tileOrderJson");
    expect(call).not.toHaveProperty("layoutMode");
    expect(call).toHaveProperty("workstreamId", "w1");
  });

  it("spawnTerminal omits undefined args", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.spawnTerminal("t1", "/cwd");
    expect(invoke).toHaveBeenCalledWith("spawn_terminal", expect.objectContaining({
      tileId: "t1",
      cwd: "/cwd",
    }));
  });

  it("updateTileConfig works without title", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.updateTileConfig("t1", '{"a":1}');
    expect(invoke).toHaveBeenCalledWith("update_tile_config", expect.objectContaining({
      tileId: "t1",
      configJson: '{"a":1}',
    }));
  });

  it("discoverCopilotConfig works without workstreamDir", async () => {
    invoke.mockResolvedValueOnce([]);
    await backend.discoverCopilotConfig();
    expect(invoke).toHaveBeenCalledWith("discover_copilot_config", { workstreamDir: null });
  });

  it("gitLog works without limit", async () => {
    invoke.mockResolvedValueOnce([]);
    await backend.gitLog("/dir");
    expect(invoke).toHaveBeenCalledWith("git_log", expect.objectContaining({ directory: "/dir" }));
  });

  it("createProject works without color", async () => {
    invoke.mockResolvedValueOnce({ id: "p1" });
    await backend.createProject("Name", "/dir");
    expect(invoke).toHaveBeenCalledWith("create_project", expect.objectContaining({
      name: "Name",
      directory: "/dir",
    }));
  });

  it("listTiles passes workstreamId", async () => {
    invoke.mockResolvedValueOnce([]);
    await backend.listTiles("w1");
    expect(invoke).toHaveBeenCalledWith("list_tiles", { workstreamId: "w1" });
  });

  it("createTile passes args", async () => {
    invoke.mockResolvedValueOnce({ id: "t1" });
    await backend.createTile("w1", "terminal", "Term", "{}");
    expect(invoke).toHaveBeenCalledWith("create_tile", expect.objectContaining({
      workstreamId: "w1",
      tileType: "terminal",
      title: "Term",
    }));
  });

  it("spawnTerminal passes args", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.spawnTerminal("t1", "/cwd", "pwsh.exe", ["arg1"], 24, 80);
    expect(invoke).toHaveBeenCalledWith("spawn_terminal", expect.objectContaining({
      tileId: "t1",
      cwd: "/cwd",
      command: "pwsh.exe",
      args: ["arg1"],
      rows: 24,
      cols: 80,
    }));
  });

  it("spawnCopilotSession passes resumeSessionId when provided", async () => {
    invoke.mockResolvedValueOnce(42);
    const pid = await backend.spawnCopilotSession("t1", "/cwd", "sid-abc", 24, 80);
    expect(pid).toBe(42);
    expect(invoke).toHaveBeenCalledWith("spawn_copilot_session", {
      tileId: "t1",
      cwd: "/cwd",
      resumeSessionId: "sid-abc",
      rows: 24,
      cols: 80,
      command: null,
    });
  });

  it("spawnCopilotSession forwards a custom command template", async () => {
    invoke.mockResolvedValueOnce(7);
    await backend.spawnCopilotSession("t1", "/cwd", null, 30, 120, "copilot --yolo");
    expect(invoke).toHaveBeenCalledWith("spawn_copilot_session", expect.objectContaining({
      command: "copilot --yolo",
    }));
  });

  it("spawnCopilotSession defaults resumeSessionId to null and pid to null", async () => {
    invoke.mockResolvedValueOnce(null);
    const pid = await backend.spawnCopilotSession("t1", "/cwd");
    expect(pid).toBeNull();
    expect(invoke).toHaveBeenCalledWith("spawn_copilot_session", expect.objectContaining({
      resumeSessionId: null,
      rows: 30,
      cols: 120,
    }));
  });

  it("readFile passes path", async () => {
    invoke.mockResolvedValueOnce("content");
    const result = await backend.readFile("/some/path");
    expect(result).toBe("content");
    expect(invoke).toHaveBeenCalledWith("read_file", { path: "/some/path" });
  });

  it("saveScrollback passes data", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.saveScrollback("t1", "scrollback data");
    expect(invoke).toHaveBeenCalledWith("save_scrollback", { tileId: "t1", scrollback: "scrollback data" });
  });

  it("loadScrollback returns invoke result", async () => {
    invoke.mockResolvedValueOnce("data");
    const result = await backend.loadScrollback("t1");
    expect(result).toBe("data");
  });

  it("detectGitInfo unpacks tuple result", async () => {
    invoke.mockResolvedValueOnce(["repo-url", "main"]);
    const result = await backend.detectGitInfo("/path");
    expect(result).toEqual({ repo: "repo-url", branch: "main" });
  });

  it("gitLog passes directory and limit", async () => {
    invoke.mockResolvedValueOnce([]);
    await backend.gitLog("/dir", 50);
    expect(invoke).toHaveBeenCalledWith("git_log", { directory: "/dir", limit: 50 });
  });

  it("searchFiles passes query", async () => {
    invoke.mockResolvedValueOnce(["a.ts"]);
    const result = await backend.searchFiles("/", "a");
    expect(result).toEqual(["a.ts"]);
    expect(invoke).toHaveBeenCalledWith("search_files", { directory: "/", query: "a" });
  });

  it("searchInFiles passes directory, query, limit, and options", async () => {
    invoke.mockResolvedValueOnce([{ path: "a.ts", line_number: 1, line_text: "foo" }]);
    const result = await backend.searchInFiles("/", "foo", 25, { caseSensitive: true, regex: false });
    expect(result).toEqual([{ path: "a.ts", line_number: 1, line_text: "foo" }]);
    expect(invoke).toHaveBeenCalledWith("search_in_files", { directory: "/", query: "foo", limit: 25, options: { caseSensitive: true, regex: false } });
  });

  it("getLayout passes workstreamId", async () => {
    invoke.mockResolvedValueOnce({ workstream_id: "w1" });
    await backend.getLayout("w1");
    expect(invoke).toHaveBeenCalledWith("get_layout", { workstreamId: "w1" });
  });

  it("updateLayout passes args", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.updateLayout("w1", { layout_mode: "vertical" });
    expect(invoke).toHaveBeenCalledWith("update_layout", expect.objectContaining({
      workstreamId: "w1",
      layoutMode: "vertical",
    }));
  });

  it("writeToTerminal, resizeTerminal, closeTerminal call correct commands", async () => {
    invoke.mockResolvedValue(undefined);
    await backend.writeToTerminal("t1", "input");
    expect(invoke).toHaveBeenCalledWith("write_to_pty", { tileId: "t1", data: "input" });
    await backend.resizeTerminal("t1", 24, 80);
    expect(invoke).toHaveBeenCalledWith("resize_pty", { tileId: "t1", rows: 24, cols: 80 });
    await backend.closeTerminal("t1");
    expect(invoke).toHaveBeenCalledWith("close_terminal", { tileId: "t1" });
  });

  it("watchSession passes args", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.watchSession("t1", "session-name");
    expect(invoke).toHaveBeenCalledWith("watch_session", { tileId: "t1", sessionName: "session-name" });
  });

  it("unwatchSession passes tileId", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.unwatchSession("t1");
    expect(invoke).toHaveBeenCalledWith("unwatch_session", { tileId: "t1" });
  });

  it("updateTileConfig passes config", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.updateTileConfig("t1", '{"a":1}', "new title");
    expect(invoke).toHaveBeenCalledWith("update_tile_config", { tileId: "t1", configJson: '{"a":1}', title: "new title" });
  });

  it("deleteTile, deleteWorkstream call correct commands", async () => {
    invoke.mockResolvedValue(undefined);
    await backend.deleteTile("t1");
    expect(invoke).toHaveBeenCalledWith("delete_tile", { tileId: "t1" });
    await backend.deleteWorkstream("w1");
    expect(invoke).toHaveBeenCalledWith("delete_workstream", { id: "w1" });
  });

  it("listDirectory, gitDiffFiles, gitDiffFile, gitShowCommit, gitCurrentBranch call correct commands", async () => {
    invoke.mockResolvedValue([]);
    await backend.listDirectory("/");
    expect(invoke).toHaveBeenCalledWith("list_directory", { path: "/" });
    await backend.gitDiffFiles("/", "unstaged");
    expect(invoke).toHaveBeenCalledWith("git_diff_files", { directory: "/", mode: "unstaged" });
    await backend.gitDiffFile("/", "f.ts", "unstaged");
    expect(invoke).toHaveBeenCalledWith("git_diff_file", { directory: "/", filePath: "f.ts", mode: "unstaged" });
    invoke.mockResolvedValueOnce([["a.ts", "A"], ["b.ts", "M"], ["c.ts", "X"]]);
    const statusFiles = await backend.gitDiffFilesWithStatus("/", "unstaged");
    expect(invoke).toHaveBeenCalledWith("git_diff_files_with_status", { directory: "/", mode: "unstaged" });
    expect(statusFiles).toEqual([
      { path: "a.ts", status: "A" },
      { path: "b.ts", status: "M" },
      { path: "c.ts", status: "M" }, // unknown -> M fallback
    ]);
    invoke.mockResolvedValueOnce(["before-text", "after-text"]);
    const sides = await backend.gitDiffFileSides("/", "f.ts", "unstaged");
    expect(invoke).toHaveBeenCalledWith("git_diff_file_sides", { directory: "/", filePath: "f.ts", mode: "unstaged" });
    expect(sides).toEqual({ before: "before-text", after: "after-text" });
    await backend.gitShowCommit("/", "abc");
    expect(invoke).toHaveBeenCalledWith("git_show_commit", { directory: "/", hash: "abc" });
    await backend.gitCurrentBranch("/");
    expect(invoke).toHaveBeenCalledWith("git_current_branch", { directory: "/" });
    invoke.mockResolvedValueOnce([2, 3, "abc1234"]);
    const tracking = await backend.gitBranchTrackingInfo("/");
    expect(invoke).toHaveBeenCalledWith("git_branch_tracking_info", { directory: "/" });
    expect(tracking).toEqual({ ahead: 2, behind: 3, remoteHeadShort: "abc1234" });
  });

  it("discoverCopilotConfig passes workstreamDir", async () => {
    invoke.mockResolvedValueOnce([]);
    await backend.discoverCopilotConfig("/repo");
    expect(invoke).toHaveBeenCalledWith("discover_copilot_config", { workstreamDir: "/repo" });
  });

  it("session plan/todo/dep commands invoke with sessionId", async () => {
    invoke.mockResolvedValue([]);
    await backend.listSessionPlans("s1");
    expect(invoke).toHaveBeenCalledWith("query_session_plans", { sessionId: "s1" });
    invoke.mockResolvedValueOnce(null);
    await backend.getCurrentSessionPlan("s1");
    expect(invoke).toHaveBeenCalledWith("query_session_current_plan", { sessionId: "s1" });
    await backend.listSessionTodoDeps("s1");
    expect(invoke).toHaveBeenCalledWith("query_session_todo_deps", { sessionId: "s1" });
    await backend.listSessionTodos("s1");
    expect(invoke).toHaveBeenCalledWith("query_session_todos", { sessionId: "s1" });
  });

  it("diff review commands map to snake_case Tauri commands", async () => {
    invoke.mockResolvedValueOnce({ id: "rev-1" });
    await backend.createDiffReview("ws-1", "branch", "main");
    expect(invoke).toHaveBeenCalledWith("create_diff_review", { workstreamId: "ws-1", diffSource: "branch", sourceRef: "main" });

    invoke.mockResolvedValueOnce(undefined);
    await backend.setReviewPlan("rev-1", "{}", []);
    expect(invoke).toHaveBeenCalledWith("set_review_plan", { reviewId: "rev-1", planJson: "{}", chunks: [] });

    invoke.mockResolvedValueOnce({ id: "rev-1" });
    await backend.getReview("rev-1");
    expect(invoke).toHaveBeenCalledWith("get_review", { reviewId: "rev-1" });

    invoke.mockResolvedValueOnce([]);
    await backend.listChunks("rev-1");
    expect(invoke).toHaveBeenCalledWith("list_chunks", { reviewId: "rev-1" });

    invoke.mockResolvedValueOnce({ chunk: {}, hunks: [], comments: [] });
    await backend.getChunkDetails("c1");
    expect(invoke).toHaveBeenCalledWith("get_chunk_details", { chunkId: "c1" });

    invoke.mockResolvedValueOnce(undefined);
    await backend.activateChunk("rev-1", "c1");
    expect(invoke).toHaveBeenCalledWith("activate_chunk", { reviewId: "rev-1", chunkId: "c1" });

    invoke.mockResolvedValueOnce(undefined);
    await backend.ackChunk("c1", "approved");
    expect(invoke).toHaveBeenCalledWith("ack_chunk", { chunkId: "c1", state: "approved" });

    invoke.mockResolvedValueOnce({ id: "cm-1" });
    await backend.addComment("c1", "f.ts", 1, 2, "note");
    expect(invoke).toHaveBeenCalledWith("add_comment", {
      chunkId: "c1",
      anchorFile: "f.ts",
      anchorLineStart: 1,
      anchorLineEnd: 2,
      text: "note",
    });

    invoke.mockResolvedValueOnce({ exported_path: "/p" });
    await backend.completeReview("rev-1");
    expect(invoke).toHaveBeenCalledWith("complete_review", { reviewId: "rev-1" });

    invoke.mockResolvedValueOnce([]);
    await backend.detectDrift("rev-1");
    expect(invoke).toHaveBeenCalledWith("detect_drift", { reviewId: "rev-1" });
  });

  it("diff review tile commands map to snake_case Tauri commands", async () => {
    invoke.mockResolvedValueOnce([]);
    await backend.listActiveDiffReviews("ws-1");
    expect(invoke).toHaveBeenCalledWith("list_active_diff_reviews", { workstreamId: "ws-1" });

    invoke.mockResolvedValueOnce({ id: "tile-1" });
    await backend.createOrFocusDiffReviewTile("ws-1", "rev-1");
    expect(invoke).toHaveBeenCalledWith("create_or_focus_diff_review_tile", { workstreamId: "ws-1", reviewId: "rev-1" });
  });

  it("file comment commands map to snake_case Tauri commands", async () => {
    invoke.mockResolvedValueOnce([]);
    await backend.listFileComments("ws-1", "C:/a.ts");
    expect(invoke).toHaveBeenCalledWith("list_file_comments", { workstreamId: "ws-1", absolutePath: "C:/a.ts" });

    invoke.mockResolvedValueOnce({ id: "fc-1" });
    await backend.addFileComment("ws-1", "C:/a.ts", 5, 7, "  foo();", "note");
    expect(invoke).toHaveBeenCalledWith("add_file_comment", {
      workstreamId: "ws-1",
      absolutePath: "C:/a.ts",
      anchorLineStart: 5,
      anchorLineEnd: 7,
      anchorText: "  foo();",
      bodyMd: "note",
    });

    invoke.mockResolvedValueOnce({ id: "fc-1" });
    await backend.updateFileComment("fc-1", "edited");
    expect(invoke).toHaveBeenCalledWith("update_file_comment", { id: "fc-1", bodyMd: "edited" });

    invoke.mockResolvedValueOnce(undefined);
    await backend.deleteFileComment("fc-1");
    expect(invoke).toHaveBeenCalledWith("delete_file_comment", { id: "fc-1" });

    invoke.mockResolvedValueOnce({ inserted: 2, skipped: 1 });
    const items = [
      {
        absolute_path: "C:/a.ts",
        anchor_line_start: 1,
        anchor_line_end: 1,
        body_md: "x",
        author: "bob",
        origin_pr_id: "42",
        origin_comment_id: "c-1",
      },
    ];
    await backend.importPrComments("ws-1", items);
    expect(invoke).toHaveBeenCalledWith("import_pr_comments", { workstreamId: "ws-1", items });
  });
});
