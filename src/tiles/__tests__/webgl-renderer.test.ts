import { describe, it, expect, vi } from "vitest";
import { createWebglController, type WebglAddonLike } from "../webgl-renderer";

function makeAddon() {
  const addon = {
    onContextLoss: vi.fn<(cb: () => void) => void>(),
    dispose: vi.fn(),
    triggerContextLoss() {
      const cb = addon.onContextLoss.mock.calls[0]?.[0];
      cb?.();
    },
  };
  return addon;
}

function makeContainer(width = 800, height = 600): HTMLElement {
  return { offsetWidth: width, offsetHeight: height } as unknown as HTMLElement;
}

describe("createWebglController", () => {
  it("loads the addon when the container is visible and sized", () => {
    const addon = makeAddon();
    const loadAddon = vi.fn();
    const ctl = createWebglController({
      createAddon: () => addon as unknown as WebglAddonLike,
      loadAddon,
      getContainer: () => makeContainer(),
    });
    expect(ctl.isLoaded()).toBe(false);
    ctl.tryLoad();
    expect(loadAddon).toHaveBeenCalledWith(addon);
    expect(ctl.isLoaded()).toBe(true);
  });

  it("is idempotent while loaded (creates the addon only once)", () => {
    const create = vi.fn(() => makeAddon() as unknown as WebglAddonLike);
    const ctl = createWebglController({
      createAddon: create,
      loadAddon: vi.fn(),
      getContainer: () => makeContainer(),
    });
    ctl.tryLoad();
    ctl.tryLoad();
    ctl.tryLoad();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not load while the container is hidden/unsized", () => {
    const create = vi.fn(() => makeAddon() as unknown as WebglAddonLike);
    const ctl = createWebglController({
      createAddon: create,
      loadAddon: vi.fn(),
      getContainer: () => makeContainer(0, 0),
    });
    ctl.tryLoad();
    expect(create).not.toHaveBeenCalled();
    expect(ctl.isLoaded()).toBe(false);
  });

  it("does not load when there is no container", () => {
    const create = vi.fn(() => makeAddon() as unknown as WebglAddonLike);
    const ctl = createWebglController({
      createAddon: create,
      loadAddon: vi.fn(),
      getContainer: () => null,
    });
    ctl.tryLoad();
    expect(create).not.toHaveBeenCalled();
  });

  it("disposes the addon and allows re-create on context loss", () => {
    const addon = makeAddon();
    const create = vi.fn(() => addon as unknown as WebglAddonLike);
    const ctl = createWebglController({
      createAddon: create,
      loadAddon: vi.fn(),
      getContainer: () => makeContainer(),
    });
    ctl.tryLoad();
    expect(ctl.isLoaded()).toBe(true);
    // Simulate a GPU context loss.
    addon.triggerContextLoss();
    expect(addon.dispose).toHaveBeenCalled();
    expect(ctl.isLoaded()).toBe(false);
    // A subsequent reveal re-creates it.
    ctl.tryLoad();
    expect(create).toHaveBeenCalledTimes(2);
    expect(ctl.isLoaded()).toBe(true);
  });

  it("stays on the DOM renderer when addon creation throws", () => {
    const ctl = createWebglController({
      createAddon: () => {
        throw new Error("no webgl2");
      },
      loadAddon: vi.fn(),
      getContainer: () => makeContainer(),
    });
    expect(() => ctl.tryLoad()).not.toThrow();
    expect(ctl.isLoaded()).toBe(false);
  });

  it("disposes the addon when loadAddon throws", () => {
    const addon = makeAddon();
    const ctl = createWebglController({
      createAddon: () => addon as unknown as WebglAddonLike,
      loadAddon: () => {
        throw new Error("load failed");
      },
      getContainer: () => makeContainer(),
    });
    ctl.tryLoad();
    expect(addon.dispose).toHaveBeenCalled();
    expect(ctl.isLoaded()).toBe(false);
  });

  it("dispose() tears down the addon and blocks further loads", () => {
    const addon = makeAddon();
    const create = vi.fn(() => addon as unknown as WebglAddonLike);
    const ctl = createWebglController({
      createAddon: create,
      loadAddon: vi.fn(),
      getContainer: () => makeContainer(),
    });
    ctl.tryLoad();
    ctl.dispose();
    expect(addon.dispose).toHaveBeenCalled();
    expect(ctl.isLoaded()).toBe(false);
    ctl.tryLoad();
    expect(create).toHaveBeenCalledTimes(1); // no re-create after dispose
  });
});
