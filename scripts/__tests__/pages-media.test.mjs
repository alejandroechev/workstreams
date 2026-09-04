import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkPagesMedia,
  extractLocalMediaReferences,
} from "../pages-media.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("extractLocalMediaReferences", () => {
  it("extracts img, video, and source src attributes plus video posters", () => {
    const html = `
      <img alt="Overview" src="assets/overview.png">
      <video src='assets/demo.mp4' poster="assets/poster.png"></video>
      <video poster=assets/second-poster.png>
        <source type="video/webm" src="assets/demo.webm">
      </video>
      <script src="downloads.js"></script>
    `;

    expect(extractLocalMediaReferences(html)).toEqual([
      { tag: "img", attribute: "src", value: "assets/overview.png" },
      { tag: "video", attribute: "src", value: "assets/demo.mp4" },
      { tag: "video", attribute: "poster", value: "assets/poster.png" },
      {
        tag: "video",
        attribute: "poster",
        value: "assets/second-poster.png",
      },
      { tag: "source", attribute: "src", value: "assets/demo.webm" },
    ]);
  });

  it("ignores remote, embedded, and fragment-only media", () => {
    const html = `
      <img src="https://example.test/remote.png">
      <img src="//cdn.example.test/remote.png">
      <img src="data:image/png;base64,AAAA">
      <video poster="#poster"></video>
      <source src="assets/local.webm?version=2#clip">
    `;

    expect(extractLocalMediaReferences(html)).toEqual([
      {
        tag: "source",
        attribute: "src",
        value: "assets/local.webm?version=2#clip",
      },
    ]);
  });

  it("ignores media tags inside HTML comments", () => {
    const html = `
      <!-- <img src="assets/commented-out.png"> -->
      <img src="assets/visible.png">
    `;

    expect(extractLocalMediaReferences(html)).toEqual([
      { tag: "img", attribute: "src", value: "assets/visible.png" },
    ]);
  });

  it("does not parse attribute-like text inside another attribute", () => {
    const html =
      '<img alt="example src=assets/ghost.png" src="assets/real.png">';

    expect(extractLocalMediaReferences(html)).toEqual([
      { tag: "img", attribute: "src", value: "assets/real.png" },
    ]);
  });

  it("requires an exact raw-text closing tag name", () => {
    const html =
      '<script>const x="</scripture><img src=assets/ghost.png>";</script>' +
      '<img src="assets/visible.png">';

    expect(extractLocalMediaReferences(html)).toEqual([
      { tag: "img", attribute: "src", value: "assets/visible.png" },
    ]);
  });
});

describe("checkPagesMedia", () => {
  it("checks local media in every HTML file relative to that page", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workstreams-pages-media-"));
    roots.push(root);
    write(root, "index.html", '<img src="/assets/hero.png">\n');
    write(
      root,
      "guides/index.html",
      '<video poster="../assets/poster.png"><source src="../assets/demo.webm"></video>\n',
    );
    write(root, "assets/hero.png", "hero");
    write(root, "assets/poster.png", "poster");
    write(root, "assets/demo.webm", "video");

    expect(checkPagesMedia(root)).toEqual([]);
  });

  it("reports each missing staged media reference without writing files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workstreams-pages-media-"));
    roots.push(root);
    write(
      root,
      "index.html",
      '<img src="assets/missing.png"><video poster="assets/missing-poster.png"></video>\n',
    );
    const before = snapshot(root);

    expect(checkPagesMedia(root)).toEqual([
      {
        file: "index.html",
        reference: "assets/missing.png",
        resolvedPath: "assets/missing.png",
      },
      {
        file: "index.html",
        reference: "assets/missing-poster.png",
        resolvedPath: "assets/missing-poster.png",
      },
    ]);
    expect(snapshot(root)).toEqual(before);
  });
});

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function snapshot(root) {
  return Object.fromEntries(
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const relative = path.join(entry.parentPath.slice(root.length + 1), entry.name);
        return [relative, fs.readFileSync(path.join(root, relative)).toString("hex")];
      }),
  );
}
