import type { Project, Workstream } from "./types";

export type RepositoryFilter = "not_archived" | "non_dormant" | "all";

const ARCHIVED_WORKSTREAM_STATUSES: ReadonlySet<Workstream["status"]> = new Set([
  "archived",
  "archiving",
]);

export function repositoryActiveWorkstreamCounts(
  workstreams: readonly Workstream[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const workstream of workstreams) {
    if (!workstream.project_id || ARCHIVED_WORKSTREAM_STATUSES.has(workstream.status)) {
      continue;
    }
    counts.set(workstream.project_id, (counts.get(workstream.project_id) ?? 0) + 1);
  }
  return counts;
}

export function filterRepositories(
  projects: readonly Project[],
  activeCounts: ReadonlyMap<string, number>,
  filter: RepositoryFilter,
): Project[] {
  return projects.filter((project) => {
    if (filter === "all") return true;
    if (project.archived) return false;
    return filter === "not_archived" || (activeCounts.get(project.id) ?? 0) > 0;
  });
}

export function selectableRepositories(projects: readonly Project[]): Project[] {
  return projects.filter((project) => !project.archived);
}
