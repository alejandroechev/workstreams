import { describe, it, expect, afterEach, vi } from "vitest";

import {
  isWindowsPlatform,
  pathSeparator,
  joinPath,
  defaultRootDir,
  defaultTerminalCommand,
  supportsWsl,
  terminalTileLabel,
  __setPlatformOverrideForTests,
} from "../platform";

afterEach(() => {
  __setPlatformOverrideForTests(null);
  vi.unstubAllGlobals();
});

describe("platform detection", () => {
  it("detects Windows from a WebView2 user agent", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/150.0" });
    expect(isWindowsPlatform()).toBe(true);
  });

  it("detects macOS from a WKWebView user agent", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605" });
    expect(isWindowsPlatform()).toBe(false);
  });

  it("treats Linux as non-Windows", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
    expect(isWindowsPlatform()).toBe(false);
  });

  it("defaults to Windows when the user agent is unavailable (back-compat)", () => {
    vi.stubGlobal("navigator", undefined);
    // The app shipped Windows-only, so an undetectable environment should keep
    // the historical behaviour rather than silently switching separators.
    expect(isWindowsPlatform()).toBe(true);
  });
});

describe("path helpers", () => {
  it("uses a backslash separator and C:\\ root on Windows", () => {
    __setPlatformOverrideForTests("windows");
    expect(pathSeparator()).toBe("\\");
    expect(defaultRootDir()).toBe("C:\\");
  });

  it("uses a forward slash separator and / root on unix", () => {
    __setPlatformOverrideForTests("unix");
    expect(pathSeparator()).toBe("/");
    expect(defaultRootDir()).toBe("/");
  });

  it("joins segments with the platform separator", () => {
    __setPlatformOverrideForTests("windows");
    expect(joinPath("C:\\repo", "src", "main.ts")).toBe("C:\\repo\\src\\main.ts");

    __setPlatformOverrideForTests("unix");
    expect(joinPath("/home/me", "src", "main.ts")).toBe("/home/me/src/main.ts");
  });

  it("normalises separators inside supplied segments when joining", () => {
    __setPlatformOverrideForTests("unix");
    // A relative segment captured on Windows (features\\a) must not leak a
    // backslash into a unix path.
    expect(joinPath("/root", "features\\a")).toBe("/root/features/a");

    __setPlatformOverrideForTests("windows");
    expect(joinPath("C:\\root", "features/a")).toBe("C:\\root\\features\\a");
  });

  it("ignores empty segments rather than emitting doubled separators", () => {
    __setPlatformOverrideForTests("unix");
    expect(joinPath("/root", "", "a")).toBe("/root/a");
    expect(joinPath("/root")).toBe("/root");
  });

  it("does not double a separator already present on the base", () => {
    __setPlatformOverrideForTests("unix");
    expect(joinPath("/root/", "a")).toBe("/root/a");

    __setPlatformOverrideForTests("windows");
    expect(joinPath("C:\\", "a")).toBe("C:\\a");
  });
});

describe("terminal defaults", () => {
  it("keeps pwsh.exe as the persisted default on Windows", () => {
    __setPlatformOverrideForTests("windows");
    expect(defaultTerminalCommand()).toBe("pwsh.exe");
  });

  it("persists NO shell on unix so the backend resolves $SHELL", () => {
    // Persisting "pwsh.exe" on macOS would be re-sent verbatim when the tile
    // is restored on the next launch, and the spawn would fail because that
    // binary does not exist. `null` lets the Rust side pick the login shell.
    __setPlatformOverrideForTests("unix");
    expect(defaultTerminalCommand()).toBeNull();
  });

  it("only offers WSL on Windows", () => {
    __setPlatformOverrideForTests("windows");
    expect(supportsWsl()).toBe(true);

    __setPlatformOverrideForTests("unix");
    expect(supportsWsl()).toBe(false);
  });

  it("labels the terminal tile per platform", () => {
    __setPlatformOverrideForTests("windows");
    expect(terminalTileLabel()).toBe("PowerShell");

    // "PowerShell" would be wrong on macOS, where the tile runs $SHELL.
    __setPlatformOverrideForTests("unix");
    expect(terminalTileLabel()).toBe("Terminal");
  });
});
