// Pure logic shared by the trace-tests CLI and its unit tests.
// Deliberately imports no Node built-ins so Vitest can run it in jsdom.

export function cargoBuildArgs(packageName) {
  const args = ["test", "--no-run", "--message-format=json"];
  if (packageName?.trim()) args.push("-p", packageName.trim());
  return args;
}

export function testListArgs(filter) {
  const args = ["--list"];
  if (filter?.trim()) args.push(filter.trim());
  return args;
}

export function parseTestList(stdout) {
  return String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith(": test"))
    .map((line) => line.slice(0, -": test".length));
}
