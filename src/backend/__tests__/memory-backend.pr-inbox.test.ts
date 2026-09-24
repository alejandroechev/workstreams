import { describe, it, expect } from "vitest";
import { MemoryBackend } from "../memory-backend";

describe("PR inbox offline backend", () => {
  it("opts in only ADO repos, keeps read state, and reports missing notifications", async () => {
    const backend = new MemoryBackend();
    const repo = await backend.createProject("Repo", "/repo");
    expect(await backend.getPrInbox()).toEqual({ items: [], repos: [] });
    await expect(backend.configurePrInbox(repo.id, true)).rejects.toThrow("Azure DevOps");
    await backend.updateProject(repo.id, { git_remote: "https://dev.azure.com/org/proj/_git/repo" });
    await backend.configurePrInbox(repo.id, true);
    expect((await backend.getPrInbox()).repos[0].enabled).toBe(true);
    backend.seedPrInboxItems([{
      id: "n", project_id: repo.id, repo_name: "Repo", pr_id: 3, title: "Review this",
      author: "Author", url: "https://dev.azure.com/org/proj/_git/repo/pullrequest/3",
      is_read: false, discovered_at: "2026-01-01T00:00:00Z",
    }]);
    await backend.setPrInboxRead("n", true);
    expect((await backend.getPrInbox()).items[0].is_read).toBe(true);
    await backend.configurePrInbox(repo.id, false);
    await backend.setPrInboxRead("n", false);
    expect((await backend.getPrInbox()).items[0].is_read).toBe(false);
    await expect(backend.setPrInboxRead("missing", true)).rejects.toThrow("not found");
    await expect(backend.configurePrInbox("missing", false)).rejects.toThrow("not found");
    await backend.deleteProject(repo.id);
    expect(await backend.getPrInbox()).toEqual({ items: [], repos: [] });
  });
});
