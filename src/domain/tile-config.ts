import type { TerminalConfig } from "./types";

/**
 * Create a JSON config string for a terminal tile.
 */
export function createTerminalConfig(cwd: string, command?: string): string {
  const config: TerminalConfig = {
    cwd,
    command: command ?? "pwsh.exe",
    process_status: "spawning",
  };
  return JSON.stringify(config);
}

/**
 * Parse a JSON config string into a TerminalConfig object.
 * Returns a default config if the string is empty or invalid.
 */
export function parseTerminalConfig(configJson: string): TerminalConfig {
  if (!configJson || configJson.trim() === "") {
    return { cwd: "C:\\", command: "pwsh.exe" };
  }
  try {
    return JSON.parse(configJson) as TerminalConfig;
  } catch {
    return { cwd: "C:\\", command: "pwsh.exe" };
  }
}

const LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  rs: "rust",
  py: "python",
  go: "go",
  json: "json",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  css: "css",
  html: "html",
  sql: "sql",
  sh: "shell",
  ps1: "powershell",
  xml: "xml",
  csv: "plaintext",
  txt: "plaintext",
};

/**
 * Detect the programming language from a file path extension.
 * Returns a Monaco editor-compatible language identifier.
 */
export function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return LANGUAGE_MAP[ext] || "plaintext";
}
