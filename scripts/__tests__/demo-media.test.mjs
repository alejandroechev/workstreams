import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  calculateSourceHash,
  checkDemoMedia,
  validateManifest,
} from "../demo-media.mjs";

const roots = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workstreams-demo-media-"));
  roots.push(root);
  write(root, "scripts/demo-media.mjs", "export const recorder = true;\n");
  write(root, "e2e/demos/overview.spec.ts", "test('overview', async ({ page }) => page.screencast);\n");
  write(root, "docs/assets/demos/overview.webm", "video");
  write(root, "README.md", "docs/assets/demos/overview.webm\n");
  write(root, "site/index.html", "assets/demos/overview.webm\n");
  return root;
}

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function manifest(overrides = {}) {
  return {
    version: 1,
    sharedSources: ["scripts/demo-media.mjs"],
    retiredGifs: [],
    clips: [
      {
        id: "overview",
        scenario: "e2e/demos/overview.spec.ts",
        sources: ["e2e/demos/overview.spec.ts"],
        viewport: { width: 1280, height: 800 },
        theme: "dark",
        sourceHash: "0".repeat(64),
        artifacts: [
          {
            type: "video",
            path: "docs/assets/demos/overview.webm",
            container: "webm",
            codec: "vp9",
            width: 1280,
            height: 800,
            maxBytes: 1000,
            maxDurationSeconds: 30,
            references: [
              { file: "README.md", target: "docs/assets/demos/overview.webm" },
              { file: "site/index.html", target: "assets/demos/overview.webm" },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

const probe = () => ({
  codec: "vp9",
  width: 1280,
  height: 800,
  durationSeconds: 12,
  pixelFormat: null,
  fastStart: null,
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("demo media manifest", () => {
  it("rejects malformed manifests", () => {
    expect(validateManifest({ version: 2, clips: "nope" })).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/version must be 1/),
        expect.stringMatching(/sharedSources must be an array/),
        expect.stringMatching(/clips must be an array/),
      ]),
    );
  });

  it("fails a recorded clip when any visual source changed", () => {
    const root = fixture();
    const data = manifest();
    data.clips[0].sourceHash = calculateSourceHash(root, data, data.clips[0]);
    expect(checkDemoMedia({ root, manifest: data, probeMedia: probe })).toEqual([]);

    write(root, "e2e/demos/overview.spec.ts", "// changed framing\npage.screencast;\n");
    expect(checkDemoMedia({ root, manifest: data, probeMedia: probe })).toEqual([
      expect.stringMatching(/source hash is stale/),
    ]);
  });

  it("hashes shared sources and encoding settings", () => {
    const root = fixture();
    const data = manifest();
    const original = calculateSourceHash(root, data, data.clips[0]);

    write(root, "scripts/demo-media.mjs", "export const recorder = 'changed';\n");
    expect(calculateSourceHash(root, data, data.clips[0])).not.toBe(original);

    const changedEncoding = manifest();
    changedEncoding.clips[0].artifacts[0].maxBytes++;
    expect(calculateSourceHash(root, changedEncoding, changedEncoding.clips[0])).not.toBe(original);
  });

  it.each([
    ["codec", { codec: "h264" }, /codec.*vp9/i],
    ["dimensions", { width: 1279 }, /dimensions.*1280x800/i],
    ["duration", { durationSeconds: 31 }, /duration.*30/i],
  ])("rejects media with the wrong %s", (_name, probed, message) => {
    const root = fixture();
    const data = manifest();
    data.clips[0].sourceHash = calculateSourceHash(root, data, data.clips[0]);
    const errors = checkDemoMedia({
      root,
      manifest: data,
      probeMedia: () => ({ ...probe(), ...probed }),
    });
    expect(errors).toEqual([expect.stringMatching(message)]);
  });

  it("rejects artifacts over their byte budget", () => {
    const root = fixture();
    const data = manifest();
    data.clips[0].artifacts[0].maxBytes = 4;
    data.clips[0].sourceHash = calculateSourceHash(root, data, data.clips[0]);
    expect(checkDemoMedia({ root, manifest: data, probeMedia: probe })).toEqual([
      expect.stringMatching(/byte budget/),
    ]);
  });

  it("requires every declared publication reference", () => {
    const root = fixture();
    const data = manifest();
    data.clips[0].sourceHash = calculateSourceHash(root, data, data.clips[0]);
    write(root, "site/index.html", "<main>No clip here</main>\n");
    expect(checkDemoMedia({ root, manifest: data, probeMedia: probe })).toEqual([
      expect.stringMatching(/site\/index\.html.*does not reference/),
    ]);
  });

  it("enforces H.264 yuv420p faststart and the single gifski overview fallback", () => {
    const data = manifest();
    data.clips[0].artifacts = [
      {
        type: "video",
        path: "docs/assets/demos/overview.mp4",
        container: "mp4",
        codec: "h264",
        pixelFormat: "yuv420p",
        fastStart: true,
        width: 1280,
        height: 800,
        maxBytes: 1000,
        maxDurationSeconds: 30,
        references: [{ file: "README.md", target: "overview.mp4" }],
      },
      {
        type: "fallback",
        path: "docs/assets/demos/overview.gif",
        codec: "gif",
        encoder: "gifski",
        width: 1280,
        height: 800,
        maxBytes: 1000,
        maxDurationSeconds: 30,
        references: [{ file: "README.md", target: "overview.gif" }],
      },
    ];
    expect(validateManifest(data)).toEqual([]);

    data.clips[0].artifacts[0].pixelFormat = "yuv444p";
    data.clips.push({ ...data.clips[0], id: "second" });
    expect(validateManifest(data)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/yuv420p/),
        expect.stringMatching(/only one GIF fallback/),
      ]),
    );
  });

  it("retires a legacy GIF as soon as its replacement is recorded", () => {
    const root = fixture();
    write(root, "docs/assets/workstreams-demo.gif", "legacy");
    const data = manifest({
      retiredGifs: [
        {
          path: "docs/assets/workstreams-demo.gif",
          replacementClipId: "overview",
          references: [
            { file: "README.md", target: "docs/assets/workstreams-demo.gif" },
          ],
        },
      ],
    });
    data.clips[0].sourceHash = calculateSourceHash(root, data, data.clips[0]);
    write(root, "README.md", "docs/assets/workstreams-demo.gif\ndocs/assets/demos/overview.webm\n");
    expect(checkDemoMedia({ root, manifest: data, probeMedia: probe })).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/retired GIF still exists/),
        expect.stringMatching(/still references retired GIF/),
      ]),
    );
  });

  it("--check logic never mutates fixture files", () => {
    const root = fixture();
    const data = manifest();
    data.clips[0].sourceHash = calculateSourceHash(root, data, data.clips[0]);
    const before = snapshot(root);
    expect(checkDemoMedia({ root, manifest: data, probeMedia: probe })).toEqual([]);
    expect(snapshot(root)).toEqual(before);
  });
});

function snapshot(root) {
  const result = {};
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else result[path.relative(root, absolute)] = fs.readFileSync(absolute).toString("hex");
    }
  }
  visit(root);
  return result;
}
