import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri window API
const requestUserAttention = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    requestUserAttention: (...args: unknown[]) => requestUserAttention(...args),
  }),
}));

describe("notifications", () => {
  beforeEach(async () => {
    requestUserAttention.mockReset();
    // Reset module so audioCtx is fresh
    vi.resetModules();
    // Mock AudioContext
    const oscillator = {
      connect: vi.fn(),
      frequency: { value: 0 },
      type: "",
      start: vi.fn(),
      stop: vi.fn(),
    };
    const gain = {
      connect: vi.fn(),
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    };
    const audioCtx = {
      createOscillator: vi.fn(() => oscillator),
      createGain: vi.fn(() => gain),
      destination: {},
      currentTime: 0,
    };
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = vi.fn(() => audioCtx);
    // Mock Notification API
    (globalThis as unknown as { Notification: unknown }).Notification = vi.fn();
    (globalThis as unknown as { Notification: { permission: string; requestPermission: () => Promise<string> } }).Notification.permission = "granted";
    (globalThis as unknown as { Notification: { permission: string; requestPermission: () => Promise<string> } }).Notification.requestPermission = vi.fn(() => Promise.resolve("granted"));
  });

  describe("playBell", () => {
    it("plays a beep without throwing", async () => {
      const { playBell } = await import("../notifications");
      expect(() => playBell()).not.toThrow();
    });

    it("handles AudioContext failure gracefully", async () => {
      (globalThis as unknown as { AudioContext: unknown }).AudioContext = vi.fn(() => {
        throw new Error("not available");
      });
      const { playBell } = await import("../notifications");
      expect(() => playBell()).not.toThrow();
    });
  });

  describe("flashWindow", () => {
    it("calls requestUserAttention", async () => {
      const { flashWindow } = await import("../notifications");
      await flashWindow();
      expect(requestUserAttention).toHaveBeenCalledWith(2);
    });

    it("swallows errors gracefully", async () => {
      requestUserAttention.mockRejectedValueOnce(new Error("no window"));
      const { flashWindow } = await import("../notifications");
      await expect(flashWindow()).resolves.toBeUndefined();
    });
  });

  describe("notifySessionIdle", () => {
    it("plays bell, flashes window, and shows notification when permission granted", async () => {
      const NotificationCtor = (globalThis as unknown as { Notification: typeof Notification }).Notification;
      const { notifySessionIdle } = await import("../notifications");
      notifySessionIdle("test-session");
      expect(NotificationCtor).toHaveBeenCalledWith(
        "Copilot Session Idle",
        expect.objectContaining({ body: expect.stringContaining("test-session") })
      );
    });

    it("requests permission when default", async () => {
      (globalThis as unknown as { Notification: { permission: string } }).Notification.permission = "default";
      const reqPerm = (globalThis as unknown as { Notification: { requestPermission: () => Promise<string> } }).Notification.requestPermission;
      const { notifySessionIdle } = await import("../notifications");
      notifySessionIdle("s");
      expect(reqPerm).toHaveBeenCalled();
    });

    it("does not request permission when denied", async () => {
      (globalThis as unknown as { Notification: { permission: string } }).Notification.permission = "denied";
      const reqPerm = vi.fn();
      (globalThis as unknown as { Notification: { permission: string; requestPermission: () => Promise<string> } }).Notification.requestPermission = reqPerm;
      const { notifySessionIdle } = await import("../notifications");
      notifySessionIdle("s");
      expect(reqPerm).not.toHaveBeenCalled();
    });

    it("handles missing Notification API", async () => {
      const originalNotification = (globalThis as unknown as { Notification?: unknown }).Notification;
      delete (globalThis as unknown as { Notification?: unknown }).Notification;
      const { notifySessionIdle } = await import("../notifications");
      expect(() => notifySessionIdle("s")).not.toThrow();
      (globalThis as unknown as { Notification: unknown }).Notification = originalNotification;
    });
  });
});
