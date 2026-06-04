import { useEffect, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import {
  getAppSettings,
  setAppSettings,
  subscribeAppSettings,
  SCROLL_SPEED_MIN,
  SCROLL_SPEED_MAX,
  MERMAID_FONT_SIZE_MIN,
  MERMAID_FONT_SIZE_MAX,
  DEFAULT_SETTINGS,
  type AppSettings,
} from "../domain/app-settings";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsModal({ open, onClose }: Props) {
  const [settings, setSettings] = useState<AppSettings>(() => getAppSettings());

  useEffect(() => subscribeAppSettings(setSettings), []);

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
          minWidth: 440,
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
          <label htmlFor="scroll-speed" style={{ display: "block", marginBottom: 6 }}>
            Terminal scroll speed:{" "}
            <span style={{ color: "#a6e3a1" }}>
              {settings.terminalScrollSpeed.toFixed(2)}×
            </span>
          </label>
          <input
            id="scroll-speed"
            data-testid="settings-scroll-speed"
            type="range"
            min={SCROLL_SPEED_MIN}
            max={SCROLL_SPEED_MAX}
            step={0.05}
            value={settings.terminalScrollSpeed}
            onChange={(e) =>
              setAppSettings({ terminalScrollSpeed: parseFloat(e.target.value) })
            }
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
            terminal and Copilot session tiles. Lower values give finer
            control; higher values move faster through long output.
          </div>

          <div style={{ height: 1, background: "#313244", margin: "18px 0 14px" }} />

          <label htmlFor="mermaid-font" style={{ display: "block", marginBottom: 6 }}>
            Mermaid font size:{" "}
            <span style={{ color: "#a6e3a1" }}>{settings.mermaidFontSize}px</span>
          </label>
          <input
            id="mermaid-font"
            data-testid="settings-mermaid-font"
            type="range"
            min={MERMAID_FONT_SIZE_MIN}
            max={MERMAID_FONT_SIZE_MAX}
            step={1}
            value={settings.mermaidFontSize}
            onChange={(e) =>
              setAppSettings({ mermaidFontSize: parseInt(e.target.value, 10) })
            }
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
            <span>{MERMAID_FONT_SIZE_MIN}px</span>
            <span>{MERMAID_FONT_SIZE_MAX}px</span>
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: "#6c7086" }}>
            Text size inside rendered mermaid diagrams. Diagrams also fit to
            their container on initial render; you can still scroll-zoom.
          </div>

          <div style={{ height: 1, background: "#313244", margin: "18px 0 14px" }} />

          <label
            htmlFor="no-verify-blocking"
            style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}
          >
            <input
              id="no-verify-blocking"
              data-testid="settings-no-verify-blocking"
              type="checkbox"
              checked={settings.noVerifyBlockingEnabled}
              onChange={(e) =>
                setAppSettings({ noVerifyBlockingEnabled: e.target.checked })
              }
            />
            <span>Block <code>git --no-verify</code> in agent sessions</span>
          </label>
          <div style={{ fontSize: 11, color: "#6c7086" }}>
            When enabled (default), terminals and Copilot sessions launched
            from Workstreams refuse <code>git commit --no-verify</code> /
            <code>git push --no-verify</code> and surface a message asking
            the agent to consult you before bypassing pre-commit / pre-push
            hooks. Turn off if you don't want this safety net.
          </div>

          <div style={{ marginTop: 14, textAlign: "right" }}>
            <button
              data-testid="settings-reset"
              onClick={() => setAppSettings({ ...DEFAULT_SETTINGS })}
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
