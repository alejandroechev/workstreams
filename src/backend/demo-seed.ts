import type { TileType } from "../domain/types";
import { MemoryBackend } from "./memory-backend";

export interface DemoMemorySeed {
  projects?: Array<{ name: string; directory: string; color?: string }>;
  workstreams?: Array<{
    name: string;
    directory: string;
    project?: string;
    workstreamType?: string;
    worktreeBranch?: string;
    tiles?: Array<{
      type: TileType;
      title: string;
      config?: Record<string, unknown>;
    }>;
  }>;
  files?: Array<{ path: string; content: string }>;
}

export async function applyDemoSeed(
  backend: MemoryBackend,
  seed: DemoMemorySeed,
): Promise<void> {
  const projects = new Map<string, string>();
  for (const item of seed.projects ?? []) {
    const project = await backend.createProject(
      item.name,
      item.directory,
      item.color,
    );
    projects.set(item.name, project.id);
  }

  for (const item of seed.workstreams ?? []) {
    const projectId = item.project ? projects.get(item.project) : undefined;
    if (item.project && !projectId) {
      throw new Error(`unknown demo project '${item.project}'`);
    }
    const workstream = await backend.createWorkstream(item.name, item.directory, {
      projectId,
      workstreamType: item.workstreamType,
      worktreeBranch: item.worktreeBranch,
    });
    const tileIds: string[] = [];
    for (const tile of item.tiles ?? []) {
      const created = await backend.createTile(
        workstream.id,
        tile.type,
        tile.title,
        JSON.stringify(tile.config ?? {}),
      );
      tileIds.push(created.id);
    }
    await backend.updateLayout(workstream.id, {
      tile_order_json: JSON.stringify(tileIds),
    });
  }

  for (const file of seed.files ?? []) {
    backend.seedFile(file.path, file.content);
  }
}
