import { describe, it, expect, vi } from "vitest";
import { tauriGrillIo, updateGrillFile, type GrillIo } from "../grill-io";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function memoryIo(initial: string) {
  let text = initial;
  let version = 0;
  const io: GrillIo & { set(t: string): void; get(): string } = {
    read: vi.fn(async () => ({ text, hash: String(version) })),
    write: vi.fn(async (_path: string, next: string, expected: string) => {
      if (expected !== String(version)) throw Object.assign(new Error("conflict"), { kind: "ExternalModified" });
      text = next;
      version += 1;
    }),
    readBase64: vi.fn(async () => ""),
    set(t) { text = t; version += 1; },
    get: () => text,
  };
  return io;
}

describe("updating the grill file", () => {
  it("applies an edit to what is on disk now", async () => {
    const io = memoryIo("a");
    const result = await updateGrillFile(io, "/g.md", (text) => ({ ok: true, text: `${text}b` }));
    expect(result).toEqual({ ok: true, text: "ab" });
    expect(io.get()).toBe("ab");
  });

  it("re-applies the edit when the file changed between reading and writing", async () => {
    const io = memoryIo("a");
    let first = true;
    const result = await updateGrillFile(io, "/g.md", (text) => {
      if (first) { first = false; io.set("a+agent"); }
      return { ok: true, text: `${text}!` };
    });
    expect(result).toEqual({ ok: true, text: "a+agent!" });
    expect(io.get()).toBe("a+agent!");
  });

  it("passes refusals through without writing", async () => {
    const io = memoryIo("a");
    expect(await updateGrillFile(io, "/g.md", () => ({ ok: false, error: "nope" }))).toEqual({ ok: false, error: "nope" });
    expect(io.write).not.toHaveBeenCalled();
  });

  it("does not write when the edit changes nothing", async () => {
    const io = memoryIo("a");
    expect(await updateGrillFile(io, "/g.md", (text) => ({ ok: true, text }))).toEqual({ ok: true, text: "a" });
    expect(io.write).not.toHaveBeenCalled();
  });

  it("gives up after repeated conflicts, saying so", async () => {
    const io = memoryIo("a");
    const result = await updateGrillFile(io, "/g.md", (text) => { io.set(`${text}x`); return { ok: true, text: `${text}!` }; });
    expect(result).toEqual({ ok: false, error: "The file kept changing while saving; try again." });
  });

  it("reports a failed read as a failed save", async () => {
    const io = memoryIo("a");
    io.read = vi.fn(async () => { throw new Error("read denied"); });
    expect(await updateGrillFile(io, "/g.md", (text) => ({ ok: true, text }))).toEqual({ ok: false, error: "Could not save the answer: read denied" });
  });

  it("reports other write errors", async () => {
    const io = memoryIo("a");
    io.write = vi.fn(async () => { throw new Error("disk full"); });
    expect(await updateGrillFile(io, "/g.md", (text) => ({ ok: true, text: `${text}!` }))).toEqual({ ok: false, error: "Could not save the answer: disk full" });
  });
});

describe("the app's file access", () => {
  it("reads with LF endings and writes back in the file's own style, only if unchanged", async () => {
    invokeMock.mockResolvedValueOnce({ content: "a\r\nb\r\n", hash_hex: "h1", line_ending: "crlf", has_trailing_newline: false });
    expect(await tauriGrillIo.read("/crlf.md")).toEqual({ text: "a\nb\n", hash: "h1" });
    invokeMock.mockResolvedValueOnce({});
    await tauriGrillIo.write("/crlf.md", "x\n", "h1");
    expect(invokeMock).toHaveBeenLastCalledWith("write_text_file", {
      args: { path: "/crlf.md", content: "x\n", expected_hash_hex: "h1", line_ending: "crlf", ensure_trailing_newline: false },
    });
  });

  it("refuses to write a file with mixed line endings rather than normalise it", async () => {
    invokeMock.mockResolvedValueOnce({ content: "a\r\nb\n", hash_hex: "h1", line_ending: "mixed", has_trailing_newline: true });
    await tauriGrillIo.read("/mixed.md");
    invokeMock.mockClear();
    await expect(tauriGrillIo.write("/mixed.md", "x\n", "h1")).rejects.toThrow("mixes CRLF and LF");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("writes an unread file as LF with a trailing newline", async () => {
    invokeMock.mockResolvedValueOnce({});
    await tauriGrillIo.write("/new.md", "x", "h");
    expect(invokeMock).toHaveBeenLastCalledWith("write_text_file", {
      args: { path: "/new.md", content: "x", expected_hash_hex: "h", line_ending: "lf", ensure_trailing_newline: true },
    });
  });

  it("turns a changed-on-disk refusal into ExternalModified, as object or JSON", async () => {
    invokeMock.mockRejectedValueOnce({ kind: "ExternalModified", current_hash_hex: "h2" });
    await expect(tauriGrillIo.write("/a.md", "x", "h")).rejects.toMatchObject({ kind: "ExternalModified" });
    invokeMock.mockRejectedValueOnce(JSON.stringify({ kind: "ExternalModified", current_hash_hex: "h2" }));
    await expect(tauriGrillIo.write("/a.md", "x", "h")).rejects.toMatchObject({ kind: "ExternalModified" });
  });

  it("passes other write errors on as errors", async () => {
    invokeMock.mockRejectedValueOnce("permission denied");
    await expect(tauriGrillIo.write("/a.md", "x", "h")).rejects.toThrow("permission denied");
    invokeMock.mockRejectedValueOnce({ kind: "NotFound" });
    await expect(tauriGrillIo.write("/a.md", "x", "h")).rejects.toThrow('{"kind":"NotFound"}');
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    await expect(tauriGrillIo.write("/a.md", "x", "h")).rejects.toThrow("boom");
  });

  it("reads assets as base64", async () => {
    invokeMock.mockResolvedValueOnce("QUJD");
    expect(await tauriGrillIo.readBase64("/f/grill-assets/A1/x.png")).toBe("QUJD");
    expect(invokeMock).toHaveBeenLastCalledWith("read_file_base64", { path: "/f/grill-assets/A1/x.png" });
  });
});
