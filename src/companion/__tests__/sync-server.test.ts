import { describe, it, expect, vi, afterEach } from "vitest";
import { syncServerUrls, registerSyncDevice, syncAuthRequired } from "../sync-server";

afterEach(() => vi.unstubAllGlobals());

describe("sync server addresses", () => {
  it("derives the WebSocket address from the HTTP one, with the token", () => {
    expect(syncServerUrls("https://sync.stormlab.app/", "t k")).toEqual({
      http: "https://sync.stormlab.app",
      ws: "wss://sync.stormlab.app?token=t%20k",
    });
    expect(syncServerUrls("http://localhost:3931", null)).toEqual({
      http: "http://localhost:3931",
      ws: "ws://localhost:3931",
    });
  });

  it("rejects anything that is not an http(s) URL", () => {
    expect(() => syncServerUrls("ftp://x", null)).toThrow(/http/);
    expect(() => syncServerUrls("not a url", null)).toThrow();
  });
});

describe("device registration", () => {
  it("posts the device name and key and returns the token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ jwt: "the-jwt", deviceId: "d1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(registerSyncDevice("https://s.example", "Laptop", "key")).resolves.toEqual({ token: "the-jwt", deviceId: "d1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://s.example/auth/register",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ deviceName: "Laptop", registrationKey: "key" }) }),
    );
  });

  it("refuses a success response that carries no token, saying so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ deviceId: "d1" }), { status: 201 })));
    await expect(registerSyncDevice("https://s.example", "Laptop", "key")).rejects.toThrow("returned no token");
  });

  it("explains a rejected key with the server's own message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Invalid registration key" }), { status: 401 })));
    await expect(registerSyncDevice("https://s.example", "Laptop", "nope")).rejects.toThrow("Invalid registration key");
  });

  it("names the server when it cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Load failed"); }));
    await expect(registerSyncDevice("https://s.example", "Laptop", "key")).rejects.toThrow("https://s.example");
  });

  it("asks the server whether a token is needed at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "ok", authEnabled: false }))));
    await expect(syncAuthRequired("http://localhost:3931")).resolves.toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "ok", authEnabled: true }))));
    await expect(syncAuthRequired("https://s.example")).resolves.toBe(true);
  });
});
