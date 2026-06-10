import { useEffect, useState, useRef } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { invoke } from "@tauri-apps/api/core";
import {
  getAppSettings,
  setAppSettings,
  resetAppSettings,
  subscribeAppSettings,
  SCROLL_SPEED_MIN,
  SCROLL_SPEED_MAX,
  TEXT_FONT_SIZE_MIN,
  TEXT_FONT_SIZE_MAX,
  MARKDOWN_FONT_SIZE_MIN,
  MARKDOWN_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_MAX,
  type AppSettings,
} from "../domain/app-settings";
import { debounce } from "../domain/debounce";

interface Props {
  open: boolean;
  onClose: () => void;
}

// Debounce slider drags into the underlying setAppSettings call. xterm and
// Monaco both repaint their atlases on font change; without this each pixel
// of drag would thrash them. UI value updates immediately for snappy feel.
const COMMIT_DEBOUNCE_MS = 300;

export default function SettingsModal({ open, onClose }: Props) {
  const [settings, setSettings] = useState<AppSettings>(() => getAppSettings());
  // Local optimistic copies so the sliders feel snappy while we debounce
  // the global commit.
  const [localValues, setLocalValues] = useState<AppSettings>(() => getAppSettings());
  const [confirmCloseEnabled, setConfirmCloseEnabled] = useState(true);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void invoke<string | null>("get_setting", { key: "app.confirm-close-disabled" })
      .then((raw) => { if (!cancelled) setConfirmCloseEnabled(raw !== "1"); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    return subscribeAppSettings((s) => {
      setSettings(s);
      setLocalValues(s);
    });
  }, []);

  const commitRef = useRef(
    debounce((patch: Partial<AppSettings>) => {
      setAppSettings(patch);
    }, COMMIT_DEBOUNCE_MS),
  );
  useEffect(() => {
    const commit = commitRef.current;
    return () => commit.cancel();
  }, []);

  function update(patch: Partial<AppSettings>) {
    setLocalValues((prev) => ({ ...prev, ...patch }));
    commitRef.current(patch);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      data-testid="settings-modal"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1e1e2e",
          color: "#cdd6f4",
          border: "1px solid #313244",
          borderRadius: 6,
          minWidth: 460,
          maxWidth: 560,
          padding: 0,
          fontFamily: "monospace",
          fontSize: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px",
            borderBottom: "1px solid #313244",
          }}
        >
          <span style={{ fontSize: 13, color: "#89b4fa" }}>Settings</span>
          <button
            data-testid="settings-modal-close"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "#6c7086",
              cursor: "pointer",
            }}
            aria-label="Close settings"
          >
            <XMarkIcon style={{ width: 16, height: 16 }} />
          </button>
        </div>

        <div style={{ padding: 14 }}>
          {/* Fonts section */}
          <div style={{ fontSize: 11, color: "#89b4fa", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Fonts
          </div>

          <FontInput
            label="Code editor font size"
            testid="settings-font-text"
            min={TEXT_FONT_SIZE_MIN}
            max={TEXT_FONT_SIZE_MAX}
            value={localValues.textFontSize}
            committed={settings.textFontSize}
            onChange={(v) => update({ textFontSize: v })}
            help="Applies to Monaco editors in Repo Explorer, Workbench, and Session Meta when viewing source / text files."
          />

          <FontInput
            label="Markdown font size"
            testid="settings-font-markdown"
            min={MARKDOWN_FONT_SIZE_MIN}
            max={MARKDOWN_FONT_SIZE_MAX}
            value={localValues.markdownFontSize}
            committed={settings.markdownFontSize}
            onChange={(v) => update({ markdownFontSize: v })}
            help="Applies to rendered markdown previews (README, .md files, plan tile, comments)."
          />

          <FontInput
            label="Terminal font size"
            testid="settings-font-terminal"
            min={TERMINAL_FONT_SIZE_MIN}
            max={TERMINAL_FONT_SIZE_MAX}
            value={localValues.terminalFontSize}
            committed={settings.terminalFontSize}
            onChange={(v) => update({ terminalFontSize: v })}
            help="Applies to xterm cell grid in Terminal and Copilot session tiles."
          />

          <div style={{ height: 1, background: "#313244", margin: "18px 0 14px" }} />

          <div style={{ fontSize: 11, color: "#89b4fa", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Terminal
          </div>

          {/* Terminal scroll speed */}
          <label htmlFor="scroll-speed" style={{ display: "block", marginBottom: 6 }}>
            Terminal scroll speed:{" "}
            <span style={{ color: "#a6e3a1" }}>
              {localValues.terminalScrollSpeed.toFixed(2)}×
            </span>
          </label>
          <input
            id="scroll-speed"
            data-testid="settings-scroll-speed"
            type="range"
            min={SCROLL_SPEED_MIN}
            max={SCROLL_SPEED_MAX}
            step={0.05}
            value={localValues.terminalScrollSpeed}
            onChange={(e) => update({ terminalScrollSpeed: parseFloat(e.target.value) })}
            style={{ width: "100%" }}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 10,
              color: "#6c7086",
              marginTop: 2,
            }}
          >
            <span>{SCROLL_SPEED_MIN}× (slow)</span>
            <span>1× (legacy)</span>
            <span>{SCROLL_SPEED_MAX}× (fast)</span>
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: "#6c7086" }}>
            Controls how many lines a single mouse-wheel tick scrolls in
            terminal and Copilot session tiles.
          </div>

          <div style={{ height: 1, background: "#313244", margin: "18px 0 14px" }} />

          <div style={{ fontSize: 11, color: "#89b4fa", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Copilot CLI
          </div>
          <label htmlFor="copilot-command" style={{ display: "block", marginBottom: 4 }}>
            Copilot command
            {localValues.copilotCommand !== settings.copilotCommand ? (
              <span style={{ color: "#f9e2af", marginLeft: 6, fontSize: 11 }}>(pending…)</span>
            ) : null}
          </label>
          <input
            id="copilot-command"
            data-testid="settings-copilot-command"
            type="text"
            value={localValues.copilotCommand}
            onChange={(e) => update({ copilotCommand: e.target.value })}
            spellCheck={false}
            style={{
              width: "100%",
              background: "#11111b",
              color: "#cdd6f4",
              border: "1px solid #313244",
              borderRadius: 3,
              padding: "4px 6px",
              fontFamily: "monospace",
              fontSize: 12,
              boxSizing: "border-box",
            }}
          />
          <div style={{ marginTop: 4, fontSize: 11, color: "#6c7086" }}>
            Command line spawned for new Copilot session tiles. Set to
            <code> copilot --yolo</code> to use the public GitHub Copilot
            CLI, or any compatible drop-in. The <code>--resume=&lt;id&gt;</code>
            flag is appended automatically when resuming. Takes effect on
            the next session tile you spawn.
          </div>

          <div style={{ height: 1, background: "#313244", margin: "18px 0 14px" }} />

          <div style={{ fontSize: 11, color: "#89b4fa", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
            App behavior
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <input
              type="checkbox"
              data-testid="settings-confirm-close"
              checked={confirmCloseEnabled}
              onChange={async (e) => {
                const next = e.target.checked;
                setConfirmCloseEnabled(next);
                try {
                  await invoke("set_setting", { key: "app.confirm-close-disabled", value: next ? "0" : "1" });
                } catch { /* swallow */ }
              }}
            />
            <span>Ask for confirmation before closing the app</span>
          </label>
          <div style={{ marginTop: 4, fontSize: 11, color: "#6c7086" }}>
            When off, the window closes immediately. Unsaved file changes
            always trigger a separate prompt regardless of this setting.
          </div>

          <div style={{ marginTop: 14, textAlign: "right" }}>
            <button
              data-testid="settings-reset"
              onClick={() => resetAppSettings()}
              style={{
                background: "#313244",
                color: "#cdd6f4",
                border: "1px solid #45475a",
                borderRadius: 4,
                padding: "4px 10px",
                cursor: "pointer",
                fontFamily: "monospace",
                fontSize: 11,
              }}
            >
              Reset defaults
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FontInput({
  label,
  testid,
  min,
  max,
  value,
  committed,
  onChange,
  help,
}: {
  label: string;
  testid: string;
  min: number;
  max: number;
  value: number;
  committed: number;
  onChange: (v: number) => void;
  help: string;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <span>{label}</span>
        <span style={{ color: "#a6e3a1", fontSize: 11 }}>
          {value}px
          {value !== committed ? <span style={{ color: "#f9e2af", marginLeft: 6 }}>(pending…)</span> : null}
        </span>
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="range"
          data-testid={`${testid}-range`}
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          style={{ flex: 1 }}
        />
        <input
          type="number"
          data-testid={`${testid}-number`}
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (Number.isFinite(n)) onChange(n);
          }}
          style={{
            width: 56,
            background: "#11111b",
            color: "#cdd6f4",
            border: "1px solid #313244",
            borderRadius: 3,
            padding: "2px 4px",
            fontFamily: "monospace",
            fontSize: 11,
          }}
        />
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: "#6c7086" }}>{help}</div>
    </div>
  );
}
