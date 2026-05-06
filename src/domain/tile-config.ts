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
 * On first create: uses --name to name the session.
 * On resume by name: uses --resume "name"
 * On resume by ID: uses --resume=<id>
 */
export function buildCopilotCommand(config: CopilotSessionConfig, isResume: boolean): string {
  // If we have a specific session ID to resume, use that (most reliable)
  const configAny = config as unknown as Record<string, unknown>;
  if (isResume && configAny.resume_by_id) {
    return `${config.command_template} --resume=${configAny.resume_by_id}`;
  }
  const flag = isResume ? `--resume "${config.session_name}"` : `--name "${config.session_name}"`;
  return `${config.command_template} ${flag}`;
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
