#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const MEDIA_TAGS = new Set(["img", "video", "source"]);
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);

function isLocalReference(value) {
  return (
    value.length > 0 &&
    !value.startsWith("#") &&
    !value.startsWith("//") &&
    !/^[a-z][a-z\d+.-]*:/i.test(value)
  );
}

export function extractLocalMediaReferences(html) {
  const source = String(html ?? "");
  const references = [];
  let cursor = 0;
  while (cursor < source.length) {
    const opening = source.indexOf("<", cursor);
    if (opening === -1) break;
    if (source.startsWith("<!--", opening)) {
      const commentEnd = source.indexOf("-->", opening + 4);
      if (commentEnd === -1) break;
      cursor = commentEnd + 3;
      continue;
    }

    const tagEnd = findTagEnd(source, opening + 1);
    if (tagEnd === -1) break;
    const tagSource = source.slice(opening + 1, tagEnd);
    const tagMatch = /^\s*([a-z][^\s/>]*)/i.exec(tagSource);
    cursor = tagEnd + 1;
    if (!tagMatch || tagSource.trimStart().startsWith("/")) continue;

    const tag = tagMatch[1].toLowerCase();
    if (RAW_TEXT_TAGS.has(tag)) {
      const closing = findRawTextClosingTag(source, tag, cursor);
      cursor = closing === -1 ? source.length : closing;
      continue;
    }
    if (!MEDIA_TAGS.has(tag)) continue;

    const attributes = parseAttributes(
      tagSource.slice(tagMatch.index + tagMatch[0].length),
    );
    for (const { name: attribute, value } of attributes) {
      if (attribute !== "src" && attribute !== "poster") continue;
      if (attribute === "poster" && tag !== "video") continue;
      if (value !== null && isLocalReference(value)) {
        references.push({ tag, attribute, value });
      }
    }
  }
  return references;
}

function findRawTextClosingTag(html, tag, start) {
  const lower = html.toLowerCase();
  const prefix = `</${tag}`;
  let cursor = start;
  while (cursor < html.length) {
    const closing = lower.indexOf(prefix, cursor);
    if (closing === -1) return -1;
    const boundary = lower[closing + prefix.length];
    if (boundary === undefined || /[\s/>]/.test(boundary)) return closing;
    cursor = closing + prefix.length;
  }
  return -1;
}

function findTagEnd(html, start) {
  let quote = null;
  for (let index = start; index < html.length; index++) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function parseAttributes(source) {
  const attributes = [];
  let cursor = 0;
  while (cursor < source.length) {
    while (cursor < source.length && /[\s/]/.test(source[cursor])) cursor++;
    if (cursor >= source.length) break;

    const nameStart = cursor;
    while (cursor < source.length && !/[\s=/>]/.test(source[cursor])) cursor++;
    const name = source.slice(nameStart, cursor).toLowerCase();
    while (cursor < source.length && /\s/.test(source[cursor])) cursor++;

    let value = null;
    if (source[cursor] === "=") {
      cursor++;
      while (cursor < source.length && /\s/.test(source[cursor])) cursor++;
      const quote =
        source[cursor] === '"' || source[cursor] === "'"
          ? source[cursor++]
          : null;
      const valueStart = cursor;
      if (quote) {
        while (cursor < source.length && source[cursor] !== quote) cursor++;
        value = source.slice(valueStart, cursor);
        if (source[cursor] === quote) cursor++;
      } else {
        while (cursor < source.length && !/\s/.test(source[cursor])) cursor++;
        value = source.slice(valueStart, cursor);
      }
    }
    attributes.push({ name, value });
  }
  return attributes;
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
