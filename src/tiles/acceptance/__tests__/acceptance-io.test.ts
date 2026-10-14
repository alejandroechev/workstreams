import { describe, it, expect, vi } from "vitest";
import { tauriAcceptanceIo, validationRounds, type AcceptanceIo } from "../acceptance-io";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

describe("reading validation rounds", () => {
  it("lists r<n> folders and their files, ignoring anything else", async () => {
    const tree: Record<string, string[]> = {
      "/f/validation": ["r1", "r10", "notes.md", "rx"],
      "/f/validation/r1": ["AT-1-1.png"],
      "/f/validation/r10": ["AT-1-1.png", "AT-2-1.png"],
    };
    const io = { listDir: vi.fn(async (p: string) => { if (!(p in tree)) throw new Error("no dir"); return tree[p]; }) } as unknown as AcceptanceIo;
    expect(await validationRounds(io, "/f")).toEqual([
      { round: 1, files: ["AT-1-1.png"] },
      { round: 10, files: ["AT-1-1.png", "AT-2-1.png"] },
    ]);
  });

  it("is empty when nothing has been validated, or a round can't be read", async () => {
    const io = { listDir: vi.fn(async (p: string) => { if (p === "/f/validation") return ["r1"]; throw new Error("gone"); }) } as unknown as AcceptanceIo;
    expect(await validationRounds(io, "/f")).toEqual([{ round: 1, files: [] }]);
    const none = { listDir: vi.fn(async () => { throw new Error("no dir"); }) } as unknown as AcceptanceIo;
    expect(await validationRounds(none, "/f")).toEqual([]);
  });
});

describe("the app's directory listing", () => {
  it("returns names with modified times for asset change detection", async () => {
    invokeMock.mockResolvedValueOnce([{ name: "1.html", is_dir: false, modified_epoch: 42, size: 3 }]);
    expect(await tauriAcceptanceIo.listEntries("/f/acceptance-assets/AT-1")).toEqual([{ name: "1.html", modified: 42 }]);
  });

  it("returns entry names from list_directory", async () => {
    invokeMock.mockResolvedValueOnce([{ name: "r1", is_dir: true, modified_epoch: 0, size: 0 }]);
    expect(await tauriAcceptanceIo.listDir("/f/validation")).toEqual(["r1"]);
    expect(invokeMock).toHaveBeenCalledWith("list_directory", { path: "/f/validation" });
  });
});
