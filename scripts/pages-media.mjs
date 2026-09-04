#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const MEDIA_TAG_RE = /<(img|video|source)\b([^>]*)>/gis;
const ATTRIBUTE_RE =
  /(?:^|\s)(src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

function isLocalReference(value) {
  return (
    value.length > 0 &&
    !value.startsWith("#") &&
    !value.startsWith("//") &&
    !/^[a-z][a-z\d+.-]*:/i.test(value)
  );
}

export function extractLocalMediaReferences(html) {
  const references = [];
  for (const tagMatch of String(html ?? "").matchAll(MEDIA_TAG_RE)) {
    const tag = tagMatch[1].toLowerCase();
    for (const attributeMatch of tagMatch[2].matchAll(ATTRIBUTE_RE)) {
      const attribute = attributeMatch[1].toLowerCase();
      if (attribute === "poster" && tag !== "video") continue;
      const value =
        attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4] ?? "";
      if (isLocalReference(value)) {
        references.push({ tag, attribute, value });
      }
    }
  }
  return references;
}

function htmlFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".html") {
        files.push(absolute);
      }
    }
  };
  visit(root);
  return files.sort();
}

function resolveReference(root, htmlFile, reference) {
  const pathname = reference.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  return decoded.startsWith("/")
    ? path.resolve(root, `.${decoded}`)
    : path.resolve(path.dirname(htmlFile), decoded);
}

function relativePath(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

export function checkPagesMedia(root) {
  const absoluteRoot = path.resolve(root);
  const missing = [];
  for (const htmlFile of htmlFiles(absoluteRoot)) {
    const html = fs.readFileSync(htmlFile, "utf8");
    for (const { value } of extractLocalMediaReferences(html)) {
      const resolved = resolveReference(absoluteRoot, htmlFile, value);
      const relative = relativePath(absoluteRoot, resolved);
      const outsideRoot = relative === ".." || relative.startsWith("../");
      if (outsideRoot || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        missing.push({
          file: relativePath(absoluteRoot, htmlFile),
          reference: value,
          resolvedPath: relative,
        });
      }
    }
  }
  return missing;
}

function main(argv) {
  const root = path.resolve(argv[2] ?? "site");
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`pages-media: publish root is not a directory: ${root}`);
    return 2;
  }
  const missing = checkPagesMedia(root);
  for (const item of missing) {
    const file = relativePath(process.cwd(), path.join(root, item.file));
    console.error(
      `::error file=${file}::missing staged media referenced as '${item.reference}'`,
    );
  }
  if (missing.length > 0) return 1;
  console.log("pages-media: all local media references resolve to staged files.");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  process.exitCode = main(process.argv);
}
