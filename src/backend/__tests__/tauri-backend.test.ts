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

  it("updateProject maps copilot_command to the camelCase Rust arg", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.updateProject("p1", { copilot_command: "copilot --yolo" });
    expect(invoke).toHaveBeenCalledWith("update_project", { id: "p1", copilotCommand: "copilot --yolo" });
  });

  it("updateProject forwards an empty copilot_command (clear override)", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.updateProject("p1", { copilot_command: "" });
    expect(invoke).toHaveBeenCalledWith("update_project", { id: "p1", copilotCommand: "" });
  });

  it("updateProject does not forward fields that update_project can't write", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await backend.updateProject("p1", { git_remote: "https://x" } as never);
    expect(invoke).toHaveBeenCalledWith("update_project", { id: "p1" });
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

  it("session file comment commands map to snake_case Tauri commands", async () => {
    invoke.mockResolvedValueOnce([]);
    await backend.listSessionFileComments("ws-1", "src/a.ts");
    expect(invoke).toHaveBeenCalledWith("list_session_file_comments", {
      workstreamId: "ws-1",
      file: "src/a.ts",
    });

    invoke.mockResolvedValueOnce({ id: "fc-1" });
    await backend.addSessionFileComment("ws-1", "src/a.ts", 5, 7, "  foo();", "note");
    expect(invoke).toHaveBeenCalledWith("add_session_file_comment", {
      workstreamId: "ws-1",
      file: "src/a.ts",
      anchorLineStart: 5,
      anchorLineEnd: 7,
      anchorText: "  foo();",
      body: "note",
    });

    invoke.mockResolvedValueOnce({ id: "fc-2" });
    await backend.replySessionFileComment("ws-1", "fc-1", "reply");
    expect(invoke).toHaveBeenCalledWith("reply_session_file_comment", {
      workstreamId: "ws-1",
      parentId: "fc-1",
      body: "reply",
    });

    invoke.mockResolvedValueOnce({ id: "fc-1" });
    await backend.updateSessionFileComment("ws-1", "fc-1", "edited");
    expect(invoke).toHaveBeenCalledWith("update_session_file_comment", {
      workstreamId: "ws-1",
      id: "fc-1",
      body: "edited",
    });

    invoke.mockResolvedValueOnce({ id: "fc-1" });
    await backend.setSessionFileCommentStatus("ws-1", "fc-1", "resolved");
    expect(invoke).toHaveBeenCalledWith("set_session_file_comment_status", {
      workstreamId: "ws-1",
      id: "fc-1",
      status: "resolved",
    });

    invoke.mockResolvedValueOnce(undefined);
    await backend.deleteSessionFileComment("ws-1", "fc-1");
    expect(invoke).toHaveBeenCalledWith("delete_session_file_comment", {
      workstreamId: "ws-1",
      id: "fc-1",
    });
  });

  it("code review commands map to snake_case Tauri commands (with tuple mapping)", async () => {
    invoke.mockResolvedValueOnce("sess-1");
    expect(await backend.resolveWorkstreamSession("ws-1")).toBe("sess-1");
    expect(invoke).toHaveBeenCalledWith("resolve_workstream_session", { workstreamId: "ws-1" });

    // Rust returns Vec<(path,status)>; backend maps to ChangedFile[].
    invoke.mockResolvedValueOnce([["a.js", "M"], ["b.js", "A"]]);
    const files = await backend.codeReviewDiffFiles("/repo", "branch", "master");
    expect(invoke).toHaveBeenCalledWith("code_review_diff_files", {
      directory: "/repo",
      diffSource: "branch",
      baseRef: "master",
    });
    expect(files).toEqual([{ path: "a.js", status: "M" }, { path: "b.js", status: "A" }]);

    // Rust returns (before, after) tuple; backend maps to DiffSides.
    invoke.mockResolvedValueOnce(["BEFORE", "AFTER"]);
    const sides = await backend.codeReviewDiffFileSides("/repo", "a.js", "working_tree");
    expect(invoke).toHaveBeenCalledWith("code_review_diff_file_sides", {
      directory: "/repo",
      filePath: "a.js",
      diffSource: "working_tree",
      baseRef: null,
    });
    expect(sides).toEqual({ before: "BEFORE", after: "AFTER" });

    invoke.mockResolvedValueOnce({ id: "rv1" });
    await backend.createReview("ws-1", "branch", "master", "T");
    expect(invoke).toHaveBeenCalledWith("create_review", {
      workstreamId: "ws-1",
      diffSource: "branch",
      baseRef: "master",
      title: "T",
    });

    invoke.mockResolvedValueOnce(null);
    await backend.getActiveReview("ws-1");
    expect(invoke).toHaveBeenCalledWith("get_active_review", { workstreamId: "ws-1" });

    invoke.mockResolvedValueOnce([]);
    await backend.listReviews("ws-1");
    expect(invoke).toHaveBeenCalledWith("list_reviews", { workstreamId: "ws-1" });

    invoke.mockResolvedValueOnce({ id: "c1" });
    await backend.addReviewComment("ws-1", "rv1", "a.js", 4, "new", "code", "@@", "note");
    expect(invoke).toHaveBeenCalledWith("add_review_comment", {
      workstreamId: "ws-1",
      reviewId: "rv1",
      file: "a.js",
      line: 4,
      side: "new",
      code: "code",
      hunkHeader: "@@",
      body: "note",
    });

    invoke.mockResolvedValueOnce([]);
    await backend.listReviewComments("ws-1", "rv1");
    expect(invoke).toHaveBeenCalledWith("list_review_comments", { workstreamId: "ws-1", reviewId: "rv1" });

    invoke.mockResolvedValueOnce(undefined);
    await backend.setReviewCommentStatus("ws-1", "c1", "resolved");
    expect(invoke).toHaveBeenCalledWith("set_review_comment_status", {
      workstreamId: "ws-1",
      commentId: "c1",
      status: "resolved",
    });

    invoke.mockResolvedValueOnce(undefined);
    await backend.completeCodeReview("ws-1", "rv1");
    expect(invoke).toHaveBeenCalledWith("complete_code_review", { workstreamId: "ws-1", reviewId: "rv1" });

    // Cover the baseRef/title fallback branches: omitted → null, provided → passed.
    invoke.mockResolvedValueOnce([]);
    await backend.codeReviewDiffFiles("/repo", "working_tree");
    expect(invoke).toHaveBeenCalledWith("code_review_diff_files", {
      directory: "/repo",
      diffSource: "working_tree",
      baseRef: null,
    });

    invoke.mockResolvedValueOnce(["B", "A"]);
    await backend.codeReviewDiffFileSides("/repo", "a.js", "branch", "develop");
    expect(invoke).toHaveBeenCalledWith("code_review_diff_file_sides", {
      directory: "/repo",
      filePath: "a.js",
      diffSource: "branch",
      baseRef: "develop",
    });

    invoke.mockResolvedValueOnce({ id: "rv2" });
    await backend.createReview("ws-1", "working_tree");
    expect(invoke).toHaveBeenCalledWith("create_review", {
      workstreamId: "ws-1",
      diffSource: "working_tree",
      baseRef: null,
      title: null,
    });
  });

  it("thin command wrappers forward their arguments", async () => {
    // These are one-line invoke() passthroughs, but an untested wrapper is
    // exactly where a renamed command or a mistyped argument key hides.
    const cases: Array<[() => Promise<unknown>, string, unknown]> = [
      [() => backend.createDirectory("/d"), "create_directory", { path: "/d" }],
      [() => backend.cancelSearches(), "cancel_searches", undefined],
      [() => backend.completeSessionPlan("s1", "p1"), "complete_session_plan", { sessionId: "s1", planId: "p1" }],
      [() => backend.watchSessionFeatures("s1"), "watch_session_features", { sessionId: "s1" }],
      [() => backend.unwatchSessionFeatures("s1"), "unwatch_session_features", { sessionId: "s1" }],
      [() => backend.listSessionFeatures("s1"), "list_session_features", { sessionId: "s1" }],
    ];
    for (const [call, command, args] of cases) {
      invoke.mockReset();
      invoke.mockResolvedValueOnce(undefined);
      await call();
      if (args === undefined) expect(invoke).toHaveBeenCalledWith(command);
      else expect(invoke).toHaveBeenCalledWith(command, args);
    }
  });

  describe("code traces", () => {
    it("listCodeTraces passes a null workstream when unscoped", async () => {
      invoke.mockResolvedValueOnce([]);
      await backend.listCodeTraces();
      expect(invoke).toHaveBeenCalledWith("list_code_traces", { workstreamId: null });
    });

    it("listCodeTraces forwards the workstream when scoped", async () => {
      invoke.mockResolvedValueOnce([]);
      await backend.listCodeTraces("ws-1");
      expect(invoke).toHaveBeenCalledWith("list_code_traces", { workstreamId: "ws-1" });
    });

    it("getCodeTrace and deleteCodeTrace pass the id", async () => {
      invoke.mockResolvedValueOnce(null);
      await backend.getCodeTrace("t1");
      expect(invoke).toHaveBeenCalledWith("get_code_trace", { id: "t1" });

      invoke.mockResolvedValueOnce(undefined);
      await backend.deleteCodeTrace("t1");
      expect(invoke).toHaveBeenCalledWith("delete_code_trace", { id: "t1" });
    });

    it("indexCodeTrace forwards the path", async () => {
      invoke.mockResolvedValueOnce({ id: "/t.json" });
      await backend.indexCodeTrace("/t.json", "ws-1");
      expect(invoke).toHaveBeenCalledWith("index_code_trace", {
        tracePath: "/t.json",
        workstreamId: "ws-1",
      });
    });

    it("readCodeTraceFile validates through the shared parser", async () => {
      // The app and the CLI must agree on what a well-formed trace is, so the
      // read path goes through the same parser rather than casting.
      invoke.mockResolvedValueOnce({
        content: JSON.stringify({
          version: 1,
          test: "a::b",
          repoRoot: "/r",
          commitSha: "abc",
          recordedAt: "2026-01-01T00:00:00Z",
          truncated: false,
          steps: [{ file: "a.rs", line: 1, function: "f" }],
        }),
      });
      const trace = await backend.readCodeTraceFile("/t.json");
      expect(trace.steps).toHaveLength(1);
      expect(invoke).toHaveBeenCalledWith("read_text_file", { path: "/t.json" });
    });

    it("traceStaleness and listRustTests forward their arguments", async () => {
      invoke.mockResolvedValueOnce("fresh");
      await backend.traceStaleness("/repo", "abc123");
      expect(invoke).toHaveBeenCalledWith("trace_staleness", { repoDir: "/repo", recordedSha: "abc123" });

      invoke.mockResolvedValueOnce([]);
      await backend.listRustTests("/repo");
      expect(invoke).toHaveBeenCalledWith("list_rust_tests", { manifestDir: "/repo" });
    });

    it("recordCodeTrace passes the owning session so traces stay out of the repo", async () => {
      invoke.mockResolvedValueOnce("/traces/t.json");
      await backend.recordCodeTrace("a::b", "/repo", "/repo", "sess-1", 500);
      expect(invoke).toHaveBeenCalledWith("record_code_trace", {
        testName: "a::b",
        manifestDir: "/repo",
        repoRoot: "/repo",
        sessionId: "sess-1",
        maxSteps: 500,
      });
    });

    it("recordCodeTrace sends explicit nulls when session and cap are omitted", async () => {
      // Tauri distinguishes a missing argument from null; sending undefined
      // would fail deserialisation on the Rust side.
      invoke.mockResolvedValueOnce("/traces/t.json");
      await backend.recordCodeTrace("a::b", "/repo", "/repo");
      expect(invoke).toHaveBeenCalledWith("record_code_trace", {
        testName: "a::b",
        manifestDir: "/repo",
        repoRoot: "/repo",
        sessionId: null,
        maxSteps: null,
      });
    });

    it("readCodeTraceFile rejects a malformed trace instead of returning it", async () => {
      invoke.mockResolvedValueOnce({ content: JSON.stringify({ version: 42 }) });
      await expect(backend.readCodeTraceFile("/bad.json")).rejects.toThrow(/version/i);
    });
  });
}); 
