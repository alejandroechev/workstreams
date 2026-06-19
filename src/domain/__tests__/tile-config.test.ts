import { describe, it, expect } from "vitest";
import {
  createTerminalConfig,
  parseTerminalConfig,
  detectLanguage,
  detectHookLanguage,
  createCopilotSessionConfig,
  parseCopilotSessionConfig,
  buildCopilotCommand,
} from "../tile-config";

describe("createTerminalConfig", () => {
  it("creates config with cwd and default command", () => {
    const json = createTerminalConfig("/home/user");
    const parsed = JSON.parse(json);
    expect(parsed.cwd).toBe("/home/user");
    expect(parsed.command).toBe("pwsh.exe");
    expect(parsed.process_status).toBe("spawning");
  });

  it("creates config with custom command", () => {
    const json = createTerminalConfig("C:\\projects", "bash");
    const parsed = JSON.parse(json);
    expect(parsed.cwd).toBe("C:\\projects");
    expect(parsed.command).toBe("bash");
  });

  it("outputs valid JSON", () => {
    const json = createTerminalConfig("C:\\");
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

describe("parseTerminalConfig", () => {
  it("parses valid JSON config", () => {
    const config = parseTerminalConfig('{"cwd":"C:\\\\test","command":"bash"}');
    expect(config.cwd).toBe("C:\\test");
    expect(config.command).toBe("bash");
  });

  it("returns default for empty string", () => {
    const config = parseTerminalConfig("");
    expect(config.cwd).toBe("C:\\");
    expect(config.command).toBe("pwsh.exe");
  });

  it("returns default for invalid JSON", () => {
    const config = parseTerminalConfig("{broken");
    expect(config.cwd).toBe("C:\\");
    expect(config.command).toBe("pwsh.exe");
  });

  it("returns default for whitespace-only string", () => {
    const config = parseTerminalConfig("   ");
    expect(config.cwd).toBe("C:\\");
  });

  it("round-trips with createTerminalConfig", () => {
    const json = createTerminalConfig("/app", "node");
    const config = parseTerminalConfig(json);
    expect(config.cwd).toBe("/app");
    expect(config.command).toBe("node");
    expect(config.process_status).toBe("spawning");
  });
});

describe("detectLanguage", () => {
  it("detects TypeScript", () => {
    expect(detectLanguage("src/app.ts")).toBe("typescript");
    expect(detectLanguage("component.tsx")).toBe("typescript");
  });

  it("detects JavaScript", () => {
    expect(detectLanguage("index.js")).toBe("javascript");
    expect(detectLanguage("App.jsx")).toBe("javascript");
  });

  it("detects Rust", () => {
    expect(detectLanguage("main.rs")).toBe("rust");
  });

  it("detects Python", () => {
    expect(detectLanguage("script.py")).toBe("python");
  });

  it("detects YAML variants", () => {
    expect(detectLanguage("config.yaml")).toBe("yaml");
    expect(detectLanguage("config.yml")).toBe("yaml");
  });

  it("detects Markdown", () => {
    expect(detectLanguage("README.md")).toBe("markdown");
    expect(detectLanguage("page.mdx")).toBe("markdown");
  });

  it("detects PowerShell", () => {
    expect(detectLanguage("script.ps1")).toBe("powershell");
  });

  it("detects C#", () => {
    expect(detectLanguage("Program.cs")).toBe("csharp");
  });

  it("detects C and C++", () => {
    expect(detectLanguage("main.c")).toBe("c");
    expect(detectLanguage("util.h")).toBe("c");
    expect(detectLanguage("widget.cpp")).toBe("cpp");
    expect(detectLanguage("widget.hpp")).toBe("cpp");
  });

  it("detects Java and Kotlin", () => {
    expect(detectLanguage("Main.java")).toBe("java");
    expect(detectLanguage("App.kt")).toBe("kotlin");
  });

  it("detects Go, Ruby, PHP, Swift, Dart", () => {
    expect(detectLanguage("main.go")).toBe("go");
    expect(detectLanguage("app.rb")).toBe("ruby");
    expect(detectLanguage("index.php")).toBe("php");
    expect(detectLanguage("View.swift")).toBe("swift");
    expect(detectLanguage("main.dart")).toBe("dart");
  });

  it("returns plaintext for unknown extensions", () => {
    expect(detectLanguage("file.xyz")).toBe("plaintext");
    expect(detectLanguage("file")).toBe("plaintext");
  });

  it("is case-insensitive", () => {
    expect(detectLanguage("file.TS")).toBe("typescript");
    expect(detectLanguage("file.JSON")).toBe("json");
    expect(detectLanguage("Program.CS")).toBe("csharp");
  });

  it("handles paths with multiple dots", () => {
    expect(detectLanguage("my.component.test.tsx")).toBe("typescript");
  });
});

describe("detectHookLanguage", () => {
  it("defaults extensionless hooks to shell", () => {
    expect(detectHookLanguage("pre-commit", "")).toBe("shell");
    expect(detectHookLanguage("pre-push", "echo hi")).toBe("shell");
  });

  it("honours a real extension when present", () => {
    expect(detectHookLanguage("pre-commit.ps1", "")).toBe("powershell");
    expect(detectHookLanguage("hook.py", "")).toBe("python");
  });

  it("reads the shebang for extensionless hooks", () => {
    expect(detectHookLanguage("pre-commit", "#!/usr/bin/env bash\n")).toBe("shell");
    expect(detectHookLanguage("pre-commit", "#!/bin/sh\n")).toBe("shell");
    expect(detectHookLanguage("pre-commit", "#!/usr/bin/env node\n")).toBe("javascript");
    expect(detectHookLanguage("pre-commit", "#!/usr/bin/python3\n")).toBe("python");
    expect(detectHookLanguage("pre-commit", "#!/usr/bin/pwsh\n")).toBe("powershell");
    expect(detectHookLanguage("pre-commit", "#!/usr/bin/env ruby\n")).toBe("ruby");
  });

  it("falls back to shell for unknown shebangs", () => {
    expect(detectHookLanguage("pre-commit", "#!/some/weird/thing\n")).toBe("shell");
  });
});

describe("createCopilotSessionConfig", () => {
  it("creates config with session name and cwd", () => {
    const json = createCopilotSessionConfig("session1", "C:\\repo");
    const parsed = JSON.parse(json);
    expect(parsed.session_name).toBe("session1");
    expect(parsed.cwd).toBe("C:\\repo");
    expect(parsed.command_template).toBe("agency copilot --yolo");
    expect(parsed.is_resumed).toBe(false);
    expect(parsed.created_at).toBeTruthy();
  });

  it("accepts custom command template", () => {
    const json = createCopilotSessionConfig("s", "/", "custom cmd");
    const parsed = JSON.parse(json);
    expect(parsed.command_template).toBe("custom cmd");
  });
});

describe("parseCopilotSessionConfig", () => {
  it("parses valid config", () => {
    const json = createCopilotSessionConfig("test", "/cwd");
    const cfg = parseCopilotSessionConfig(json);
    expect(cfg.session_name).toBe("test");
    expect(cfg.cwd).toBe("/cwd");
  });

  it("returns default for invalid JSON", () => {
    const cfg = parseCopilotSessionConfig("not-json");
    expect(cfg.session_name).toBe("unknown");
    expect(cfg.command_template).toBe("agency copilot --yolo");
    expect(cfg.is_resumed).toBe(false);
  });
});

describe("buildCopilotCommand", () => {
  it("returns command_template for new session", () => {
    const cfg = { session_name: "s", command_template: "agency copilot --yolo", cwd: "/", is_resumed: false, created_at: "" };
    expect(buildCopilotCommand(cfg, false)).toBe("agency copilot --yolo");
  });

  it("uses --resume with copilot_session_id", () => {
    const cfg = { session_name: "s", command_template: "agency copilot --yolo", cwd: "/", is_resumed: true, created_at: "", copilot_session_id: "abc-123" };
    expect(buildCopilotCommand(cfg, true)).toBe("agency copilot --yolo --resume=abc-123");
  });

  it("prefers resume_by_id over copilot_session_id", () => {
    const cfg = { session_name: "s", command_template: "agency copilot --yolo", cwd: "/", is_resumed: true, created_at: "", copilot_session_id: "id-1", resume_by_id: "id-2" } as Parameters<typeof buildCopilotCommand>[0];
    expect(buildCopilotCommand(cfg, true)).toBe("agency copilot --yolo --resume=id-2");
  });

  it("returns base command when isResume false even with session_id", () => {
    const cfg = { session_name: "s", command_template: "agency copilot --yolo", cwd: "/", is_resumed: false, created_at: "", copilot_session_id: "abc" };
    expect(buildCopilotCommand(cfg, false)).toBe("agency copilot --yolo");
  });
});
