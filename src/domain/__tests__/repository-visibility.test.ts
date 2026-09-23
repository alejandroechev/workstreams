import { describe, expect, it } from "vitest";

import {
  filterRepositories,
  repositoryActiveWorkstreamCounts,
  selectableRepositories,
} from "../repository-visibility";
import type { Project, Workstream } from "../types";

function project(id: string, archived = false): Project {
  return {
    id,
    name: id,
    directory: `/Code/${id}`,
    git_remote: null,
    color: "#89b4fa",
    copilot_command: null,
    archived,
    created_at: "",
    updated_at: "",
  };
}

function workstream(
  id: string,
  projectId: string,
  status: Workstream["status"] = "active",
): Workstream {
  return {
    id,
    name: id,
    description: null,
    directory: null,
    git_repo: null,
    git_branch: null,
    status,
    project_id: projectId,
    workstream_type: "standalone",
    worktree_branch: null,
    created_at: "",
    updated_at: "",
  };
}

describe("repository visibility", () => {
  const projects = [project("active"), project("dormant"), project("archived", true)];
  const workstreams = [
    workstream("w1", "active"),
    workstream("w2", "active", "archived"),
    workstream("w3", "archived", "active"),
  ];

  it("counts only non-archived workstreams", () => {
    expect(repositoryActiveWorkstreamCounts(workstreams)).toEqual(
      new Map([
        ["active", 1],
        ["archived", 1],
      ]),
    );
  });

  it("hides archived repositories by default", () => {
    const counts = repositoryActiveWorkstreamCounts(workstreams);
    expect(filterRepositories(projects, counts, "not_archived").map((p) => p.id)).toEqual([
      "active",
      "dormant",
    ]);
  });

  it("can show only non-dormant repositories", () => {
    const counts = repositoryActiveWorkstreamCounts(workstreams);
    expect(filterRepositories(projects, counts, "non_dormant").map((p) => p.id)).toEqual([
      "active",
    ]);
  });

  it("can show every repository including archived ones", () => {
    const counts = repositoryActiveWorkstreamCounts(workstreams);
    expect(filterRepositories(projects, counts, "all").map((p) => p.id)).toEqual([
      "active",
      "dormant",
      "archived",
    ]);
  });

  it("excludes archived repositories from creation pickers", () => {
    expect(selectableRepositories(projects).map((p) => p.id)).toEqual(["active", "dormant"]);
  });
});
