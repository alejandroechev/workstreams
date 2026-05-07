import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBackend } from "../memory-backend";

describe("MemoryBackend projects", () => {
  let backend: MemoryBackend;

  beforeEach(() => {
    backend = new MemoryBackend();
  });

  it("starts with no projects", async () => {
    const projects = await backend.listProjects();
    expect(projects).toEqual([]);
  });

  it("creates a project with defaults", async () => {
    const p = await backend.createProject("My App", "C:\\code\\app");
    expect(p.name).toBe("My App");
    expect(p.directory).toBe("C:\\code\\app");
    expect(p.color).toBe("#89b4fa");
    expect(p.git_remote).toBeNull();
    expect(p.id).toBeTruthy();

    const list = await backend.listProjects();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(p.id);
  });

  it("creates a project with custom color", async () => {
    const p = await backend.createProject("Red Project", "C:\\code", "#f38ba8");
    expect(p.color).toBe("#f38ba8");
  });

  it("updates a project", async () => {
    const p = await backend.createProject("Old", "C:\\old");
    await backend.updateProject(p.id, { name: "New", git_remote: "https://github.com/test/repo" });
    const list = await backend.listProjects();
    expect(list[0].name).toBe("New");
    expect(list[0].git_remote).toBe("https://github.com/test/repo");
  });

  it("throws when updating non-existent project", async () => {
    await expect(backend.updateProject("nope", { name: "x" })).rejects.toThrow("Project not found");
  });

  it("deletes a project", async () => {
    const p = await backend.createProject("Temp", "C:\\temp");
    await backend.deleteProject(p.id);
    const list = await backend.listProjects();
    expect(list).toHaveLength(0);
  });

  it("creates workstream linked to a project", async () => {
    const p = await backend.createProject("App", "C:\\app");
    const ws = await backend.createWorkstream("Feature", "C:\\app", {
      projectId: p.id,
      workstreamType: "worktree",
      worktreeBranch: "ws-feature",
    });
    expect(ws.project_id).toBe(p.id);
    expect(ws.workstream_type).toBe("worktree");
    expect(ws.worktree_branch).toBe("ws-feature");
  });

  it("creates standalone workstream with no project", async () => {
    const ws = await backend.createWorkstream("Solo", "C:\\solo", {
      workstreamType: "standalone",
    });
    expect(ws.project_id).toBeNull();
    expect(ws.workstream_type).toBe("standalone");
  });

  it("archives and unarchives a workstream", async () => {
    const ws = await backend.createWorkstream("ToArchive", "C:\\dir");
    expect(ws.status).toBe("active");

    await backend.updateWorkstream(ws.id, { status: "archived" });
    const list = await backend.listWorkstreams();
    expect(list[0].status).toBe("archived");

    await backend.updateWorkstream(ws.id, { status: "active" });
    const list2 = await backend.listWorkstreams();
    expect(list2[0].status).toBe("active");
  });
});
