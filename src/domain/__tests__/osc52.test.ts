import { describe, it, expect, vi, beforeEach } from "vitest";

const writeMock = vi.fn(async (_text: string) => {});

vi.mock("../clipboard", () => ({
  writeTextToClipboard: (text: string) => writeMock(text),
}));

import { handleOsc52 } from "../osc52";

beforeEach(() => {
  writeMock.mockReset();
  writeMock.mockResolvedValue(undefined);
});

describe("handleOsc52", () => {
  it("decodes base64 UTF-8 payload and writes it to the clipboard", async () => {
    const text = "hello clipboard 🎉";
    const b64 = btoa(unescape(encodeURIComponent(text)));
    const ok = await handleOsc52(`c;${b64}`);
    expect(ok).toBe(true);
    expect(writeMock).toHaveBeenCalledWith(text);
  });

  it("supports empty targets prefix (just ';<b64>')", async () => {
    const b64 = btoa("plain");
    const ok = await handleOsc52(`;${b64}`);
    expect(ok).toBe(true);
    expect(writeMock).toHaveBeenCalledWith("plain");
  });

  it("returns false for malformed payload (no semicolon)", async () => {
    const ok = await handleOsc52("notvalid");
    expect(ok).toBe(false);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("ignores read queries (payload === '?')", async () => {
    const ok = await handleOsc52("c;?");
    expect(ok).toBe(false);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("returns false when base64 cannot be decoded", async () => {
    const ok = await handleOsc52("c;!!!not-base64!!!");
    expect(ok).toBe(false);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("returns false when clipboard write throws", async () => {
    writeMock.mockRejectedValueOnce(new Error("denied"));
    const b64 = btoa("hi");
    const ok = await handleOsc52(`c;${b64}`);
    expect(ok).toBe(false);
  });
});
