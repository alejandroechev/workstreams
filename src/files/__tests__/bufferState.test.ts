import { describe, expect, it } from "vitest";

import { INITIAL_CONTEXT, reduce, type BufferEvent, type BufferState, type BufferStateContext } from "../bufferState";

const context = (state: BufferState, extra: Partial<BufferStateContext> = {}): BufferStateContext => ({
  state,
  autoSaveAllowed: state === "dirty",
  ...extra,
});

const expectTransition = (
  from: BufferState,
  event: BufferEvent,
  to: BufferState,
  expected: Partial<BufferStateContext> = {},
) => {
  expect(reduce(context(from), event)).toEqual(context(to, expected));
};

describe("bufferState reducer", () => {
  it("starts clean with autosave disabled", () => {
    expect(INITIAL_CONTEXT).toEqual({ state: "clean", autoSaveAllowed: false });
  });

  it.each<BufferState>(["clean", "saving", "conflicted", "deleted", "save_blocked"])(
    "disallows autosave in %s",
    (state) => {
      expect(reduce(context(state), { type: "user_typed" }).autoSaveAllowed).toBe(
        reduce(context(state), { type: "user_typed" }).state === "dirty",
      );
    },
  );

  it("allows autosave only in dirty", () => {
    const states: BufferState[] = ["clean", "dirty", "saving", "conflicted", "deleted", "save_blocked"];

    expect(states.map((state) => context(state).autoSaveAllowed)).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("transitions clean to dirty when the user types", () => {
    expectTransition("clean", { type: "user_typed" }, "dirty");
  });

  it("keeps clean on external changes", () => {
    expectTransition("clean", { type: "external_change_detected" }, "clean");
  });

  it("transitions clean to deleted on external delete", () => {
    expectTransition("clean", { type: "external_delete_detected" }, "deleted");
  });

  it("keeps dirty when the user types again", () => {
    expectTransition("dirty", { type: "user_typed" }, "dirty");
  });

  it("transitions dirty to saving when save starts", () => {
    expectTransition("dirty", { type: "save_started" }, "saving");
  });

  it("transitions dirty to conflicted on external changes", () => {
    const next = reduce(context("dirty"), { type: "external_change_detected" });

    expect(next.state).toBe("conflicted");
    expect(next.autoSaveAllowed).toBe(false);
    expect(next.conflictingDiskHash).toBeTruthy();
  });

  it("transitions dirty to deleted on external delete", () => {
    expectTransition("dirty", { type: "external_delete_detected" }, "deleted");
  });

  it("transitions saving to clean on save success", () => {
    expectTransition("saving", { type: "save_succeeded", newDiskHash: "hash-2" }, "clean");
  });

  it("transitions saving to conflicted on external modification failure", () => {
    expectTransition("saving", { type: "save_failed_external_modified", currentDiskHash: "disk-hash" }, "conflicted", {
      conflictingDiskHash: "disk-hash",
      lastError: "File changed on disk",
    });
  });

  it("transitions saving to deleted on not found", () => {
    expectTransition("saving", { type: "save_failed_not_found" }, "deleted");
  });

  it("transitions saving to save_blocked on permission failure", () => {
    expectTransition("saving", { type: "save_failed_permission" }, "save_blocked", { lastError: "Permission denied" });
  });

  it("transitions saving to save_blocked on disk full", () => {
    expectTransition("saving", { type: "save_failed_disk_full" }, "save_blocked", { lastError: "Disk full" });
  });

  it("transitions saving to save_blocked on other save failures", () => {
    expectTransition("saving", { type: "save_failed_other", message: "network share unavailable" }, "save_blocked", {
      lastError: "network share unavailable",
    });
  });

  it("keeps saving when the user types during save", () => {
    expectTransition("saving", { type: "user_typed" }, "saving");
  });

  it("resolves conflicts by keeping mine as dirty and clearing conflict metadata", () => {
    const ctx = context("conflicted", { conflictingDiskHash: "disk-hash", lastError: "File changed on disk" });

    expect(reduce(ctx, { type: "conflict_resolved_keep_mine" })).toEqual(context("dirty"));
  });

  it("resolves conflicts by taking disk as clean and clearing conflict metadata", () => {
    const ctx = context("conflicted", { conflictingDiskHash: "disk-hash", lastError: "File changed on disk" });

    expect(reduce(ctx, { type: "conflict_resolved_take_disk" })).toEqual(context("clean"));
  });

  it("keeps conflicted when the user types during a conflict", () => {
    expectTransition("conflicted", { type: "user_typed" }, "conflicted");
  });

  it("transitions deleted to dirty when the user types", () => {
    expectTransition("deleted", { type: "user_typed" }, "dirty");
  });

  it("transitions save_blocked to dirty on retry and clears errors", () => {
    const ctx = context("save_blocked", { lastError: "Disk full" });

    expect(reduce(ctx, { type: "user_retry_save" })).toEqual(context("dirty"));
  });

  it("keeps save_blocked when the user types", () => {
    expectTransition("save_blocked", { type: "user_typed" }, "save_blocked");
  });

  it("transitions save_blocked to conflicted on external changes", () => {
    const next = reduce(context("save_blocked", { lastError: "Permission denied" }), {
      type: "external_change_detected",
    });

    expect(next.state).toBe("conflicted");
    expect(next.autoSaveAllowed).toBe(false);
    expect(next.conflictingDiskHash).toBeTruthy();
    expect(next.lastError).toBe("File changed on disk");
  });

  it.each<[BufferState, BufferEvent]>([
    ["clean", { type: "save_started" }],
    ["dirty", { type: "save_succeeded", newDiskHash: "hash" }],
    ["saving", { type: "external_change_detected" }],
    ["conflicted", { type: "save_started" }],
    ["deleted", { type: "save_started" }],
    ["save_blocked", { type: "save_started" }],
  ])("does not throw or change state for unknown %s transitions", (state, event) => {
    const ctx = context(state, { lastError: "kept" });

    expect(() => reduce(ctx, event)).not.toThrow();
    expect(reduce(ctx, event)).toEqual(ctx);
  });
});
