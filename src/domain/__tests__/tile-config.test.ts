import { describe, it, expect } from "vitest";
import { createTerminalConfig, parseTerminalConfig, detectLanguage } from "../tile-config";

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
    expect(detectLanguage("component.tsx")).toBe("typescriptreact");
  });

  it("detects JavaScript", () => {
    expect(detectLanguage("index.js")).toBe("javascript");
    expect(detectLanguage("App.jsx")).toBe("javascriptreact");
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
  });

  it("detects PowerShell", () => {
    expect(detectLanguage("script.ps1")).toBe("powershell");
  });

  it("returns plaintext for unknown extensions", () => {
    expect(detectLanguage("file.xyz")).toBe("plaintext");
    expect(detectLanguage("file")).toBe("plaintext");
  });

  it("is case-insensitive", () => {
    expect(detectLanguage("file.TS")).toBe("typescript");
    expect(detectLanguage("file.JSON")).toBe("json");
  });

  it("handles paths with multiple dots", () => {
    expect(detectLanguage("my.component.test.tsx")).toBe("typescriptreact");
  });
});
