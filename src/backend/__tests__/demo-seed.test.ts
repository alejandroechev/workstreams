import { describe, expect, it } from "vitest";

import { applyDemoSeed, type DemoMemorySeed } from "../demo-seed";
import { MemoryBackend } from "../memory-backend";

describe("applyDemoSeed", () => {
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
