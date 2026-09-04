import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectDownloadPlatform,
  releasePresentation,
  selectDownloadAsset,
} from "../../site/downloads.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const RELEASE = {
  tag_name: "v0.7.0",
  published_at: "2026-09-03T18:16:28Z",
  html_url: "https://github.com/alejandroechev/workstreams/releases/tag/v0.7.0",
  assets: [
    {
      name: "Workstreams_0.7.0_x64-setup.exe",
      browser_download_url: "https://example.test/windows.exe",
    },
    {
      name: "Workstreams_0.7.0_x64_en-US.msi",
      browser_download_url: "https://example.test/windows.msi",
    },
    {
      name: "workstreams-v0.7.0.exe",
      browser_download_url: "https://example.test/windows-raw.exe",
    },
    {
      name: "Workstreams-v0.7.0-arm64.dmg",
      browser_download_url: "https://example.test/macos.dmg",
    },
    {
      name: "Workstreams-v0.7.0-arm64.app.zip",
      browser_download_url: "https://example.test/macos.zip",
    },
  ],
};

describe("detectDownloadPlatform", () => {
  it.each([
    ["MacIntel", "mac"],
    ["macOS", "mac"],
    ["Win32", "windows"],
    ["Windows", "windows"],
    ["Linux x86_64", "other"],
    ["", "other"],
  ])("maps %s to %s", (platform, expected) => {
    expect(detectDownloadPlatform({ platform })).toBe(expected);
  });

  it("falls back to the user agent when platform is unavailable", () => {
    expect(
      detectDownloadPlatform({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      }),
    ).toBe("windows");
    expect(
      detectDownloadPlatform({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      }),
    ).toBe("mac");
  });
});

describe("selectDownloadAsset", () => {
  it("prefers the Windows installer over MSI and the raw executable", () => {
    expect(selectDownloadAsset(RELEASE.assets, "windows")).toMatchObject({
      name: "Workstreams_0.7.0_x64-setup.exe",
    });
  });

  it("selects the Apple Silicon DMG on macOS", () => {
    expect(selectDownloadAsset(RELEASE.assets, "mac")).toMatchObject({
      name: "Workstreams-v0.7.0-arm64.dmg",
    });
  });

  it("returns null for an unsupported platform or absent asset", () => {
    expect(selectDownloadAsset(RELEASE.assets, "other")).toBeNull();
    expect(selectDownloadAsset([], "windows")).toBeNull();
  });
});

describe("releasePresentation", () => {
  it("builds an OS-specific primary CTA and release eyebrow", () => {
    const presentation = releasePresentation(RELEASE, "windows", "en-US");

    expect(presentation).toEqual({
      tag: "v0.7.0",
      date: "Sep 3, 2026",
      releaseUrl:
        "https://github.com/alejandroechev/workstreams/releases/tag/v0.7.0",
      downloadUrl: "https://example.test/windows.exe",
      downloadLabel: "Download for Windows",
      assetName: "Workstreams_0.7.0_x64-setup.exe",
    });
  });

  describe("landing-page download contract", () => {
    const html = readFileSync(join(REPO, "site", "index.html"), "utf8");

    it("loads the release resolver once", () => {
      expect(html.match(/src="downloads\.js"/g)).toHaveLength(1);
    });

    it("has one latest-release eyebrow with dynamic version and date slots", () => {
      expect(html.match(/data-release-link/g)).toHaveLength(1);
      expect(html.match(/data-release-tag/g)).toHaveLength(1);
      expect(html.match(/data-release-date/g)).toHaveLength(1);
    });

    it("repeats the OS-aware primary CTA at the hero, install, and final call to action", () => {
      expect(html.match(/data-download-primary/g)).toHaveLength(3);
    });

    it("keeps an always-visible escape hatch to every release artifact", () => {
      expect(html).toContain('href="https://github.com/alejandroechev/workstreams/releases"');
      expect(html).toContain(">All downloads</a>");
    });
  });

  it("labels macOS as Apple Silicon because Intel builds are unavailable", () => {
    expect(releasePresentation(RELEASE, "mac", "en-US").downloadLabel).toBe(
      "Download for macOS (Apple Silicon)",
    );
  });

  it("keeps the releases page as the fallback on unsupported systems", () => {
    expect(releasePresentation(RELEASE, "other", "en-US")).toMatchObject({
      downloadUrl:
        "https://github.com/alejandroechev/workstreams/releases/tag/v0.7.0",
      downloadLabel: "View all downloads",
      assetName: null,
    });
  });
});
