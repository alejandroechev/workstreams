import { describe, expect, it } from "vitest";

import { applyDemoSeed, type DemoMemorySeed } from "../demo-seed";
import { MemoryBackend } from "../memory-backend";

describe("applyDemoSeed", () => {
  it("can seed an ADO clone URL before the app loads project configuration", async () => {
    const backend = new MemoryBackend();
    await applyDemoSeed(backend, { projects: [{ name: "ADO", directory: "/ado", git_remote: "https://dev.azure.com/o/p/_git/r" }] });
    expect((await backend.listProjects())[0].git_remote).toBe("https://dev.azure.com/o/p/_git/r");
  });
  it("creates synthetic projects, workstreams, tiles, layouts, and files", async () => {
    const backend = new MemoryBackend();
    const seed: DemoMemorySeed = {
      projects: [
        { name: "Atlas", directory: "/demo/atlas", color: "#89b4fa" },
      ],
      workstreams: [
        {
          name: "Parser cleanup",
          directory: "/demo/atlas/worktrees/parser-cleanup",
          project: "Atlas",
          tiles: [
            {
              type: "terminal",
              title: "Tests",
              config: { cwd: "/demo/atlas/worktrees/parser-cleanup" },
            },
          ],
        },
      ],
      files: [
        {
          path: "/demo/atlas/src/parser.ts",
          content: "export const parse = () => true;\n",
        },
      ],
    };

    await applyDemoSeed(backend, seed);

    const [project] = await backend.listProjects();
    const [workstream] = await backend.listWorkstreams();
    const [tile] = await backend.listTiles(workstream.id);
    expect(project).toMatchObject({ name: "Atlas", directory: "/demo/atlas" });
    expect(workstream).toMatchObject({
      name: "Parser cleanup",
      project_id: project.id,
    });
    expect(tile).toMatchObject({ title: "Tests", tile_type: "terminal" });
    expect(await backend.getLayout(workstream.id)).toMatchObject({
      tile_order_json: JSON.stringify([tile.id]),
    });
    expect(await backend.readFile("/demo/atlas/src/parser.ts")).toContain(
      "export const parse",
    );
  });

  it("rejects a workstream that names an unknown synthetic project", async () => {
    const backend = new MemoryBackend();
    await expect(
      applyDemoSeed(backend, {
        projects: [],
        workstreams: [
          {
            name: "Invalid",
            directory: "/demo/invalid",
            project: "Missing",
          },
        ],
      }),
    ).rejects.toThrow("unknown demo project 'Missing'");
  });

  it("supports minimal standalone seed entries and an empty seed", async () => {
    const backend = new MemoryBackend();
    await applyDemoSeed(backend, {});
    await applyDemoSeed(backend, {
      projects: [{ name: "Solo", directory: "/demo/solo" }],
      workstreams: [
        {
          name: "Standalone",
          directory: "/demo/standalone",
          tiles: [{ type: "terminal", title: "Shell" }],
        },
        {
          name: "No tiles",
          directory: "/demo/no-tiles",
        },
      ],
    });

    expect(await backend.listProjects()).toHaveLength(1);
    const workstreams = await backend.listWorkstreams();
    expect(workstreams).toHaveLength(2);
    expect(workstreams[0].project_id).toBeNull();
    expect(JSON.parse((await backend.listTiles(workstreams[0].id))[0].config_json)).toEqual({});
    expect(await backend.listTiles(workstreams[1].id)).toEqual([]);
  });
});

describe("applyDemoSeed loaded workstreams", () => {
  /**
   * The restore-on-startup path reads `is_loaded` off the workstream rows, so
   * without this a spec has no way to stage "the app was closed with these
   * open" -- `page.reload()` throws the in-memory backend away along with
   * everything seeded into it.
   */
  it("can stage a workstream as left open", async () => {
    const backend = new MemoryBackend();
    await applyDemoSeed(backend, {
      workstreams: [
        { name: "open one", directory: "/demo/a", loaded: true },
        { name: "closed one", directory: "/demo/b" },
      ],
    });

    const all = await backend.listWorkstreams();
    expect(all.find((w) => w.name === "open one")?.is_loaded).toBe(true);
    expect(all.find((w) => w.name === "closed one")?.is_loaded ?? false).toBe(false);
  });
});
