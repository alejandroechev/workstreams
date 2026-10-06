// Installs the agent skills Workstreams ships (skills/<name>/SKILL.md) into
// ~/.copilot/skills/<name>/, where Copilot CLI finds them. The repository copy
// is the source of truth; an installed copy is overwritten.
//
// Usage: node scripts/install-skills.mjs [--dest <dir>] [--check]
//   --check  exit 1 if any installed copy differs from the repository's
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "skills");

export function skillNames(source = SOURCE) {
  return fs.readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(source, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

export function install({ source = SOURCE, dest, check = false }) {
  const report = [];
  for (const name of skillNames(source)) {
    const from = path.join(source, name, "SKILL.md");
    const to = path.join(dest, name, "SKILL.md");
    const wanted = fs.readFileSync(from);
    const current = fs.existsSync(to) ? fs.readFileSync(to) : null;
    const same = current !== null && current.equals(wanted);
    if (!check && !same) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, wanted);
    }
    report.push({ name, path: to, status: same ? "up-to-date" : check ? "differs" : "installed" });
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const destIndex = args.indexOf("--dest");
  const dest = destIndex === -1 ? path.join(os.homedir(), ".copilot", "skills") : args[destIndex + 1];
  const check = args.includes("--check");
  const report = install({ dest, check });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (check && report.some((r) => r.status === "differs")) process.exit(1);
}
