import { describe, it, expect } from "vitest";
import {
  matchesText,
  isSearching,
  laneVisibleWhileSearching,
  matchesElsewhere,
} from "../workstream-search";
import type { Workstream, WorkstreamStatus } from "../types";

function ws(
  name: string,
  over: { status?: WorkstreamStatus; project_id?: string | null } = {},
): Workstream {
  return {
    id: name,
    name,
    description: null,
    directory: null,
    git_repo: null,
    git_branch: null,
    status: over.status ?? "active",
    project_id: over.project_id ?? null,
    workstream_type: "standalone",
    worktree_branch: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("isSearching", () => {
  it("treats blank input as not searching", () => {
    // Whitespace must not collapse the lanes or trip the "no matches" hint.
    for (const raw of ["", "   ", "\t"]) {
      expect(isSearching(raw), JSON.stringify(raw)).toBe(false);
    }
  });

  it("treats any real text as searching", () => {
    expect(isSearching("m")).toBe(true);
    expect(isSearching("  media  ")).toBe(true);
  });
});

describe("matchesText", () => {
  it("matches nothing-as-everything when the query is blank", () => {
    expect(matchesText(ws("anything"), "", undefined)).toBe(true);
    expect(matchesText(ws("anything"), "   ", undefined)).toBe(true);
  });

  it("matches on a substring of the name, ignoring case", () => {
    expect(matchesText(ws("Media Store"), "media", undefined)).toBe(true);
    expect(matchesText(ws("Media Store"), "STORE", undefined)).toBe(true);
    expect(matchesText(ws("Media Store"), "zzz", undefined)).toBe(false);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(matchesText(ws("Media Store"), "  media  ", undefined)).toBe(true);
  });

  it("matches on the repo name too", () => {
    // Asked for explicitly: "show me everything in waimea" is a real query,
    // and the repo is not in the workstream's own name.
    const w = ws("fix the encoder", { project_id: "p1" });
    expect(matchesText(w, "waimea", () => "waimea-bay")).toBe(true);
    expect(matchesText(w, "encoder", () => "waimea-bay")).toBe(true);
    expect(matchesText(w, "zzz", () => "waimea-bay")).toBe(false);
  });

  it("survives a workstream with no repo", () => {
    const w = ws("standalone thing");
    expect(matchesText(w, "standalone", () => undefined)).toBe(true);
    expect(matchesText(w, "waimea", () => undefined)).toBe(false);
  });

  /**
   * `create_failed` has no other signal anywhere in the UI -- ADR 027 keeps it
   * visible under every stop for exactly that reason. A text search is still a
   * filter, so the same argument applies: hiding the one broken row because it
   * does not contain the letters you typed is how it gets forgotten.
   */
  it("keeps a failed creation visible whatever you type", () => {
    const broken = ws("some name", { status: "create_failed" });
    expect(matchesText(broken, "completely unrelated", undefined)).toBe(true);
  });

  /**
   * ...but `creating` is not exempt. It resolves on its own in seconds and it
   * is not a problem anyone has to act on, so during a search it is noise.
   */
  it("does filter a workstream that is merely being created", () => {
    const pending = ws("some name", { status: "creating" });
    expect(matchesText(pending, "unrelated", undefined)).toBe(false);
    expect(matchesText(pending, "some", undefined)).toBe(true);
  });
});

describe("laneVisibleWhileSearching", () => {
  /**
   * `groupByLane` emits every lane unconditionally, because a lane is a drop
   * target and hiding an empty one makes a newly created lane impossible to
   * drag into (ADR 027). That reasoning does not survive a text search: you
   * are reading, not dragging, and eight empty headers around one hit makes
   * the result unreadable.
   */
  it("hides an empty lane while searching", () => {
    expect(laneVisibleWhileSearching(0, true)).toBe(false);
  });

  it("keeps an empty lane when not searching, so it stays a drop target", () => {
    expect(laneVisibleWhileSearching(0, false)).toBe(true);
  });

  it("keeps a lane that has matches", () => {
    expect(laneVisibleWhileSearching(3, true)).toBe(true);
    expect(laneVisibleWhileSearching(3, false)).toBe(true);
  });
});

/**
 * The failure this prevents: you are on Loaded, you type the name of a
 * workstream you archived last week, and the list goes empty. Nothing is
 * broken, but the search looks broken -- and the fix (change the stop) is the
 * one thing the empty list does not tell you.
 */
describe("matchesElsewhere", () => {
  const all = [
    ws("media store"),
    ws("media pipeline", { status: "archived" }),
    ws("unrelated"),
  ];

  it("counts matches excluded by the current stop", () => {
    // "media" matches two, but only one is not archived.
    const visible = [all[0]];
    expect(matchesElsewhere(all, visible, "media", undefined)).toBe(1);
  });

  it("is zero when everything that matches is already on screen", () => {
    const visible = [all[0], all[1]];
    expect(matchesElsewhere(all, visible, "media", undefined)).toBe(0);
  });

  it("is zero when not searching, however much is filtered out", () => {
    // Without a query the empty list is explained by the stop you chose, and
    // a hint would fire on every switch to Loaded.
    expect(matchesElsewhere(all, [], "", undefined)).toBe(0);
  });

  it("does not count rows that fail the text match either", () => {
    expect(matchesElsewhere(all, [], "zzz", undefined)).toBe(0);
  });
});
