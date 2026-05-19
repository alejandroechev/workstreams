import type { TerminalConfig, CopilotSessionConfig } from "./types";

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

/**
 * Create a JSON config string for a copilot session tile.
 */
export function createCopilotSessionConfig(
  sessionName: string,
  cwd: string,
  commandTemplate: string = "agency copilot --yolo",
): string {
  const config: CopilotSessionConfig = {
    session_name: sessionName,
    command_template: commandTemplate,
    cwd,
    is_resumed: false,
    created_at: new Date().toISOString(),
  };
  return JSON.stringify(config);
}

/**
 * Parse a copilot session config from JSON.
 */
export function parseCopilotSessionConfig(configJson: string): CopilotSessionConfig {
  try {
    return JSON.parse(configJson) as CopilotSessionConfig;
  } catch {
    return {
      session_name: "unknown",
      command_template: "agency copilot --yolo",
      cwd: "C:\\",
      is_resumed: false,
      created_at: new Date().toISOString(),
    };
  }
}

/**
 * Build the shell command to launch a copilot session.
 * New session: just runs the command template (no --name flag)
 * Resume by ID: uses --resume=<id>
 */
export function buildCopilotCommand(config: CopilotSessionConfig, isResume: boolean): string {
  const configAny = config as unknown as Record<string, unknown>;
  if (isResume && configAny.resume_by_id) {
    return `${config.command_template} --resume=${configAny.resume_by_id}`;
  }
  if (isResume && config.copilot_session_id) {
    return `${config.command_template} --resume=${config.copilot_session_id}`;
  }
  // New session — no flags, just launch
  return config.command_template;
}

const LANGUAGE_MAP: Record<string, string> = {
  // TS / JS
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  // Systems
  rs: "rust",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cs: "csharp",
  csx: "csharp",
  go: "go",
  // JVM
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  groovy: "groovy",
  // Scripting
  py: "python",
  rb: "ruby",
  php: "php",
  pl: "perl",
  lua: "lua",
  r: "r",
  dart: "dart",
  swift: "swift",
  // Shells / configs
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  psm1: "powershell",
  bat: "bat",
  cmd: "bat",
  dockerfile: "dockerfile",
  // Markup / data
  json: "json",
  jsonc: "json",
  json5: "json",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  // Plain text
  csv: "plaintext",
  txt: "plaintext",
  log: "plaintext",
  ini: "ini",
  conf: "ini",
};

/**
 * Detect the programming language from a file path extension.
 * Returns a Monaco editor-compatible language identifier.
 */
export function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return LANGUAGE_MAP[ext] || "plaintext";
}
