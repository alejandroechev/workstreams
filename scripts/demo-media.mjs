#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT), "..");
const DEFAULT_MANIFEST = "demos/manifest.json";
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TYPES = new Set(["video", "poster", "fallback"]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function repoPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function allowedKeys(value, allowed, where, errors) {
  if (!plainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${where}: unknown field '${key}'`);
  }
}

function validateReference(reference, where, errors) {
  if (!plainObject(reference)) {
    errors.push(`${where} must be an object`);
    return;
  }
  allowedKeys(reference, new Set(["file", "target"]), where, errors);
  if (!repoPath(reference.file)) errors.push(`${where}.file must be a repository-relative path`);
  if (typeof reference.target !== "string" || !reference.target) {
    errors.push(`${where}.target must be a non-empty string`);
  }
}

function validateArtifact(artifact, clipId, index, errors) {
  const where = `clip '${clipId}' artifact ${index}`;
  if (!plainObject(artifact)) {
    errors.push(`${where} must be an object`);
    return;
  }
  allowedKeys(
    artifact,
    new Set([
      "type",
      "path",
      "container",
      "codec",
      "pixelFormat",
      "fastStart",
      "encoder",
      "width",
      "height",
      "maxBytes",
      "maxDurationSeconds",
      "references",
    ]),
    where,
    errors,
  );
  if (!TYPES.has(artifact.type)) errors.push(`${where}.type must be video, poster, or fallback`);
  if (!repoPath(artifact.path)) errors.push(`${where}.path must be a repository-relative path`);
  for (const field of ["width", "height", "maxBytes"]) {
    if (!positiveInteger(artifact[field])) errors.push(`${where}.${field} must be a positive integer`);
  }
  if (artifact.width !== 1280 || artifact.height !== 800) {
    errors.push(`${where} dimensions must be exactly 1280x800`);
  }
  if (artifact.type !== "poster" && !(artifact.maxDurationSeconds > 0)) {
    errors.push(`${where}.maxDurationSeconds must be positive`);
  }
  if (!Array.isArray(artifact.references) || artifact.references.length === 0) {
    errors.push(`${where}.references must be a non-empty array`);
  } else {
    artifact.references.forEach((reference, i) =>
      validateReference(reference, `${where}.references[${i}]`, errors),
    );
  }

  const extension = path.extname(artifact.path ?? "").toLowerCase();
  if (artifact.type === "video" && artifact.container === "webm") {
    if (extension !== ".webm") errors.push(`${where}: WebM output must use .webm`);
    if (artifact.codec !== "vp9") errors.push(`${where}: WebM codec must be vp9`);
  } else if (artifact.type === "video" && artifact.container === "mp4") {
    if (extension !== ".mp4") errors.push(`${where}: MP4 output must use .mp4`);
    if (artifact.codec !== "h264") errors.push(`${where}: MP4 codec must be h264`);
    if (artifact.pixelFormat !== "yuv420p") errors.push(`${where}: MP4 pixelFormat must be yuv420p`);
    if (artifact.fastStart !== true) errors.push(`${where}: MP4 fastStart must be true`);
  } else if (artifact.type === "poster") {
    if (extension !== ".png" || artifact.codec !== "png") {
      errors.push(`${where}: poster must be a PNG`);
    }
  } else if (artifact.type === "fallback") {
    if (extension !== ".gif" || artifact.codec !== "gif" || artifact.encoder !== "gifski") {
      errors.push(`${where}: GIF fallback must use the gifski encoder`);
    }
    if (clipId !== "overview") errors.push(`${where}: GIF fallback is reserved for the overview clip`);
  } else if (artifact.type === "video") {
    errors.push(`${where}.container must be webm or mp4`);
  }
}

export function validateManifest(manifest, { allowMissingSourceHash = false } = {}) {
  const errors = [];
  if (!plainObject(manifest)) return ["manifest must be a JSON object"];
  allowedKeys(manifest, new Set(["version", "sharedSources", "clips", "retiredGifs"]), "manifest", errors);
  if (manifest.version !== 1) errors.push("manifest.version must be 1");
  if (!Array.isArray(manifest.sharedSources)) {
    errors.push("manifest.sharedSources must be an array");
  } else if (manifest.sharedSources.some((source) => !repoPath(source))) {
    errors.push("manifest.sharedSources must contain only repository-relative paths");
  }
  if (!Array.isArray(manifest.retiredGifs)) {
    errors.push("manifest.retiredGifs must be an array");
  } else {
    manifest.retiredGifs.forEach((retired, i) => {
      const where = `retiredGifs[${i}]`;
      if (!plainObject(retired)) {
        errors.push(`${where} must be an object`);
        return;
      }
      allowedKeys(retired, new Set(["path", "replacementClipId", "references"]), where, errors);
      if (!repoPath(retired.path) || path.extname(retired.path).toLowerCase() !== ".gif") {
        errors.push(`${where}.path must be a repository-relative GIF path`);
      }
      if (!ID_RE.test(retired.replacementClipId ?? "")) {
        errors.push(`${where}.replacementClipId must be a kebab-case clip id`);
      }
      if (!Array.isArray(retired.references)) {
        errors.push(`${where}.references must be an array`);
      } else {
        retired.references.forEach((reference, j) =>
          validateReference(reference, `${where}.references[${j}]`, errors),
        );
      }
    });
  }
  if (!Array.isArray(manifest.clips)) {
    errors.push("manifest.clips must be an array");
    return errors;
  }

  const ids = new Set();
  let gifCount = 0;
  const artifactPaths = new Set();
  for (const [index, clip] of manifest.clips.entries()) {
    const where = `clips[${index}]`;
    if (!plainObject(clip)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    allowedKeys(
      clip,
      new Set(["id", "scenario", "sources", "viewport", "theme", "sourceHash", "artifacts"]),
      where,
      errors,
    );
    if (!ID_RE.test(clip.id ?? "")) errors.push(`${where}.id must be kebab-case`);
    else if (ids.has(clip.id)) errors.push(`${where}.id duplicates '${clip.id}'`);
    else ids.add(clip.id);
    if (!repoPath(clip.scenario)) errors.push(`${where}.scenario must be a repository-relative path`);
    if (!Array.isArray(clip.sources) || !clip.sources.includes(clip.scenario)) {
      errors.push(`${where}.sources must include the scenario`);
    } else if (clip.sources.some((source) => !repoPath(source))) {
      errors.push(`${where}.sources must contain only repository-relative paths`);
    }
    if (clip.viewport?.width !== 1280 || clip.viewport?.height !== 800) {
      errors.push(`${where}.viewport must be exactly 1280x800`);
    }
    if (clip.theme !== "dark") errors.push(`${where}.theme must be dark`);
    if (!allowMissingSourceHash && !HASH_RE.test(clip.sourceHash ?? "")) {
      errors.push(`${where}.sourceHash must be a lowercase SHA-256 hash`);
    }
    if (!Array.isArray(clip.artifacts) || clip.artifacts.length === 0) {
      errors.push(`${where}.artifacts must be a non-empty array`);
    } else {
      clip.artifacts.forEach((artifact, i) => {
        validateArtifact(artifact, clip.id, i, errors);
        if (artifact?.type === "fallback") gifCount++;
        if (repoPath(artifact?.path)) {
          if (artifactPaths.has(artifact.path)) {
            errors.push(`${where}.artifacts[${i}].path duplicates '${artifact.path}'`);
          }
          artifactPaths.add(artifact.path);
        }
      });
    }
  }
  if (gifCount > 1) errors.push("manifest may declare only one GIF fallback");
  return errors;
}

function hashConfig(clip) {
  const { sourceHash: _sourceHash, ...config } = clip;
  return config;
}

export function calculateSourceHash(root, manifest, clip) {
  const hash = createHash("sha256");
  hash.update("workstreams-demo-media-v1\0");
  hash.update(JSON.stringify(hashConfig(clip)));
  const sources = [...new Set([...(manifest.sharedSources ?? []), ...(clip.sources ?? [])])].sort();
  for (const source of sources) {
    const absolute = path.resolve(root, source);
    hash.update(`\0${source}\0`);
    hash.update(fs.readFileSync(absolute));
  }
  return hash.digest("hex");
}

function defaultProbeMedia(file) {
  let output;
  try {
    output = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=codec_name,width,height,pix_fmt:format=duration", "-of", "json", file],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("ffprobe is required to validate recorded demo media");
    }
    throw new Error(`ffprobe failed for ${file}: ${String(error.stderr ?? error.message).trim()}`);
  }
  const parsed = JSON.parse(output);
  const stream = parsed.streams?.find((candidate) => candidate.width && candidate.height) ?? parsed.streams?.[0];
  const bytes = fs.readFileSync(file);
  const moov = bytes.indexOf(Buffer.from("moov"));
  const mdat = bytes.indexOf(Buffer.from("mdat"));
  return {
    codec: stream?.codec_name ?? null,
    width: stream?.width ?? null,
    height: stream?.height ?? null,
    durationSeconds: Number(parsed.format?.duration ?? 0),
    pixelFormat: stream?.pix_fmt ?? null,
    fastStart: moov !== -1 && mdat !== -1 ? moov < mdat : null,
  };
}

export function checkDemoMedia({ root = DEFAULT_ROOT, manifest, probeMedia = defaultProbeMedia }) {
  const errors = validateManifest(manifest);
  if (errors.length > 0) return errors;

  const clipIds = new Set(manifest.clips.map((clip) => clip.id));
  for (const retired of manifest.retiredGifs) {
    if (!clipIds.has(retired.replacementClipId)) continue;
    if (fs.existsSync(path.resolve(root, retired.path))) {
      errors.push(`retired GIF still exists: ${retired.path}`);
    }
    for (const reference of retired.references) {
      const file = path.resolve(root, reference.file);
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(reference.target)) {
        errors.push(`${reference.file} still references retired GIF ${reference.target}`);
      }
    }
  }

  for (const clip of manifest.clips) {
    const scenario = path.resolve(root, clip.scenario);
    const screencastSources = [
      ...(manifest.sharedSources ?? []),
      ...(clip.sources ?? []),
    ];
    if (!fs.existsSync(scenario) || !screencastSources.some((source) => {
      const file = path.resolve(root, source);
      return (
        /\.(?:ts|tsx)$/.test(source) &&
        fs.existsSync(file) &&
        /\bpage\s*\.\s*screencast\b/.test(fs.readFileSync(file, "utf8"))
      );
    })) {
      errors.push(`clip '${clip.id}' scenario must use Playwright page.screencast`);
    }
    try {
      const actualHash = calculateSourceHash(root, manifest, clip);
      if (actualHash !== clip.sourceHash) {
        errors.push(`clip '${clip.id}' source hash is stale; run npm run demos:record`);
      }
    } catch (error) {
      errors.push(`clip '${clip.id}' cannot hash sources: ${error.message}`);
    }

    for (const artifact of clip.artifacts) {
      const absolute = path.resolve(root, artifact.path);
      if (!fs.existsSync(absolute)) {
        errors.push(`clip '${clip.id}' is missing ${artifact.path}`);
        continue;
      }
      const size = fs.statSync(absolute).size;
      if (size > artifact.maxBytes) {
        errors.push(`clip '${clip.id}' ${artifact.path} exceeds byte budget ${artifact.maxBytes}`);
      }
      try {
        const actual = probeMedia(absolute);
        if (actual.codec !== artifact.codec) {
          errors.push(`clip '${clip.id}' ${artifact.path} codec is ${actual.codec}, expected ${artifact.codec}`);
        }
        if (actual.width !== artifact.width || actual.height !== artifact.height) {
          errors.push(
            `clip '${clip.id}' ${artifact.path} dimensions are ${actual.width}x${actual.height}, expected ${artifact.width}x${artifact.height}`,
          );
        }
        if (
          artifact.maxDurationSeconds !== undefined &&
          actual.durationSeconds > artifact.maxDurationSeconds
        ) {
          errors.push(
            `clip '${clip.id}' ${artifact.path} duration ${actual.durationSeconds}s exceeds ${artifact.maxDurationSeconds}s`,
          );
        }
        if (artifact.pixelFormat && actual.pixelFormat !== artifact.pixelFormat) {
          errors.push(
            `clip '${clip.id}' ${artifact.path} pixel format is ${actual.pixelFormat}, expected ${artifact.pixelFormat}`,
          );
        }
        if (artifact.fastStart === true && actual.fastStart !== true) {
          errors.push(`clip '${clip.id}' ${artifact.path} is not MP4 faststart`);
        }
      } catch (error) {
        errors.push(`clip '${clip.id}' cannot be probed: ${error.message}`);
      }
      for (const reference of artifact.references) {
        const publication = path.resolve(root, reference.file);
        if (!fs.existsSync(publication)) {
          errors.push(`clip '${clip.id}' reference file is missing: ${reference.file}`);
        } else if (!fs.readFileSync(publication, "utf8").includes(reference.target)) {
          errors.push(
            `${reference.file} does not reference '${reference.target}' for clip '${clip.id}'`,
          );
        }
      }
    }
  }
  return errors;
}

function readManifest(root, relative) {
  const file = path.resolve(root, relative);
  return { file, data: JSON.parse(fs.readFileSync(file, "utf8")) };
}

export function recordingWorkspace(root, clipId) {
  return path.join(root, ".dev", "demo-media", clipId);
}

export function assertRecordingTools(clip, probe = spawnSync) {
  const tools = ["ffmpeg", "ffprobe"];
  if (clip.artifacts.some((artifact) => artifact.type === "fallback")) {
    tools.push("gifski");
  }
  for (const tool of tools) {
    const versionArgs = tool === "gifski" ? ["--version"] : ["-version"];
    const result = probe(tool, versionArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error?.code === "ENOENT") {
      const hint =
        tool === "gifski"
          ? "install gifski and ensure it is on PATH"
          : `install ${tool} and ensure it is on PATH`;
      throw new Error(`${tool} is required to record demo media; ${hint}`);
    }
    if (result.error || result.status !== 0) {
      const detail = String(
        result.error?.message ?? result.stderr ?? `exit ${result.status}`,
      ).trim();
      throw new Error(`${tool} is not usable for demo recording: ${detail}`);
    }
  }
}

function runEncoder(command, args, artifactPath) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error?.code === "ENOENT") {
    throw new Error(
      `${command} is required to encode ${artifactPath}; install ${command} and ensure it is on PATH`,
    );
  }
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed while encoding ${artifactPath}`);
  }
}

function publishRecording(root, clip, workspace) {
  const raw = path.join(workspace, `${clip.id}.raw.webm`);
  if (!fs.existsSync(raw)) {
    throw new Error(`recording scenario '${clip.id}' did not produce ${path.basename(raw)}`);
  }
  const pending = [];
  let framesDirectory;
  try {
    for (const [index, artifact] of clip.artifacts.entries()) {
      const extension = path.extname(artifact.path);
      const temporary = path.join(workspace, `artifact-${index}${extension}`);
      if (artifact.type === "video" && artifact.container === "webm") {
        runEncoder(
          "ffmpeg",
          [
            "-y", "-i", raw, "-an", "-c:v", "libvpx-vp9", "-crf", "34",
            "-b:v", "0", "-deadline", "good", "-cpu-used", "2",
            "-pix_fmt", "yuv420p", temporary,
          ],
          artifact.path,
        );
      } else if (artifact.type === "video" && artifact.container === "mp4") {
        runEncoder(
          "ffmpeg",
          [
            "-y", "-i", raw, "-an", "-c:v", "libx264", "-crf", "23",
            "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags",
            "+faststart", temporary,
          ],
          artifact.path,
        );
      } else if (artifact.type === "poster") {
        runEncoder(
          "ffmpeg",
          ["-y", "-i", raw, "-frames:v", "1", temporary],
          artifact.path,
        );
      } else if (artifact.type === "fallback") {
        framesDirectory = path.join(workspace, "gif-frames");
        fs.mkdirSync(framesDirectory, { recursive: true });
        runEncoder(
          "ffmpeg",
          [
            "-y", "-i", raw, "-vf", "fps=12",
            path.join(framesDirectory, "frame-%05d.png"),
          ],
          artifact.path,
        );
        const frames = fs
          .readdirSync(framesDirectory)
          .filter((file) => file.endsWith(".png"))
          .sort()
          .map((file) => path.join(framesDirectory, file));
        runEncoder(
          "gifski",
          [
            "--fps", "12", "--quality", "80", "--width", "1280",
            "--output", temporary, ...frames,
          ],
          artifact.path,
        );
      }
      pending.push({ temporary, destination: path.resolve(root, artifact.path) });
    }
    for (const item of pending) {
      fs.mkdirSync(path.dirname(item.destination), { recursive: true });
      fs.copyFileSync(item.temporary, item.destination);
    }
  } finally {
    if (framesDirectory) {
      fs.rmSync(framesDirectory, { recursive: true, force: true });
    }
  }
}

export function runRecordingScenario({
  root,
  manifestFile,
  clip,
  spawn = spawnSync,
  checkTools = assertRecordingTools,
}) {
  const workspace = recordingWorkspace(root, clip.id);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  try {
    checkTools(clip);
  } catch (error) {
    fs.rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = [
    "exec",
    "playwright",
    "test",
    "--config",
    "playwright.demo.config.ts",
    clip.scenario,
  ];
  const result = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      WORKSTREAMS_DEMO_CLIP: clip.id,
      WORKSTREAMS_DEMO_MANIFEST: path.relative(root, manifestFile),
      WORKSTREAMS_DEMO_OUTPUT_DIR: workspace,
    },
  });
  if (result.error) {
    fs.rmSync(workspace, { recursive: true, force: true });
    if (result.error.code === "ENOENT" || /ffmpeg.*ENOENT/i.test(result.error.message)) {
      throw new Error(
        "Playwright recording tools are unavailable; run 'npx playwright install chromium ffmpeg'",
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    fs.rmSync(workspace, { recursive: true, force: true });
    throw new Error(`recording scenario '${clip.id}' failed`);
  }
  try {
    publishRecording(root, clip, workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function record(root, manifestFile, manifest) {
  const shapeErrors = validateManifest(manifest, { allowMissingSourceHash: true });
  if (shapeErrors.length > 0) throw new Error(shapeErrors.join("\n"));
  const clips = manifest.clips;
  if (clips.length === 0) {
    console.log("demo-media: no clips declared; nothing to record.");
    return;
  }
  for (const clip of clips) {
    runRecordingScenario({ root, manifestFile, clip });
    clip.sourceHash = calculateSourceHash(root, manifest, clip);
  }
  const errors = checkDemoMedia({ root, manifest });
  if (errors.length > 0) throw new Error(errors.join("\n"));
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = { check: false, root: DEFAULT_ROOT, manifest: DEFAULT_MANIFEST };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--check") args.check = true;
    else if (argv[i] === "--root") args.root = path.resolve(argv[++i]);
    else if (argv[i] === "--manifest") args.manifest = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { file, data } = readManifest(args.root, args.manifest);
    if (!args.check) {
      record(args.root, file, data);
      return;
    }
    const errors = checkDemoMedia({ root: args.root, manifest: data });
    if (errors.length > 0) {
      for (const error of errors) console.error(`demo-media: ${error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`demo-media: ${data.clips.length} clip(s) satisfy the manifest.`);
  } catch (error) {
    console.error(`demo-media: ${error.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) main();
