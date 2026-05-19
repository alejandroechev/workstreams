/**
 * AudioPlayer — renders an HTML5 native `<audio>` element for a Blob URL,
 * plus a small custom toolbar for playback speed and loop. Designed to
 * live inside the Repo Explorer tile when the user opens an audio file.
 *
 * The parent component is responsible for:
 *   - Creating the object URL (via URL.createObjectURL with a typed Blob).
 *   - Passing the path so we can show a friendly filename.
 *   - Unmounting us when the user navigates away (we revoke the URL).
 *
 * Keyboard shortcuts (when `isFocused`):
 *   Space        → toggle play/pause
 *   ArrowLeft    → seek back 5 s
 *   ArrowRight   → seek forward 5 s
 *
 * Decode failures (codec not supported) surface via the `<audio>` element's
 * `error` event; we render a small notice and an "Open in system player"
 * button using `tauri-plugin-opener`'s `openPath`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MusicalNoteIcon,
  ArrowUturnLeftIcon,
  ForwardIcon,
} from "@heroicons/react/24/outline";
import { openPath } from "@tauri-apps/plugin-opener";
import { AudioWaveform } from "./AudioWaveform";

interface Props {
  /** Object URL (or any URL the WebView can fetch) for the audio bytes. */
  url: string;
  /** Absolute path used for the friendly filename + system-player fallback. */
  path: string;
  /** File size in bytes (for the header and the "too large" guard). */
  sizeBytes: number;
  /** Raw decoded bytes for the waveform thumbnail. Optional. */
  audioBytes?: ArrayBuffer | null;
  /** Whether the host tile is focused (gates keyboard shortcuts). */
  isFocused?: boolean;
}

const PLAYBACK_RATES = [1, 1.5, 2];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

export default function AudioPlayer({
  url,
  path,
  sizeBytes,
  audioBytes = null,
  isFocused = false,
}: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [rateIdx, setRateIdx] = useState(0);
  const [loop, setLoop] = useState(false);
  const [decodeError, setDecodeError] = useState(false);

  const rate = PLAYBACK_RATES[rateIdx];

  // Apply playback rate when it changes.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  // Apply loop attribute when it toggles.
  useEffect(() => {
    if (audioRef.current) audioRef.current.loop = loop;
  }, [loop]);

  // Keyboard shortcuts.
  useEffect(() => {
    if (!isFocused) return;
    const onKey = (e: KeyboardEvent) => {
      const a = audioRef.current;
      if (!a) return;
      // Don't hijack when typing in an input/textarea.
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        if (a.paused) a.play().catch(() => {});
        else a.pause();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        a.currentTime = Math.max(0, a.currentTime - 5);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        a.currentTime = Math.min(a.duration || a.currentTime + 5, a.currentTime + 5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFocused]);

  const name = useMemo(() => basename(path), [path]);

  const cycleSpeed = () => setRateIdx((i) => (i + 1) % PLAYBACK_RATES.length);

  const openInSystem = () => {
    openPath(path).catch(() => {});
  };

  const handleSeek = (sec: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.min(Math.max(0, sec), a.duration || sec);
  };

  return (
    <div
      data-testid="audio-player"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 16,
        height: "100%",
        background: "#1e1e2e",
        color: "#cdd6f4",
        overflow: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <MusicalNoteIcon style={{ width: 18, height: 18, color: "#cba6f7", flexShrink: 0 }} />
        <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}
        </span>
        <span style={{ color: "#6c7086", fontSize: 11 }} data-testid="audio-size">{formatSize(sizeBytes)}</span>
      </div>

      {audioBytes && !decodeError && (
        <AudioWaveform
          bytes={audioBytes}
          onSeek={handleSeek}
          getCurrentTime={() => audioRef.current?.currentTime ?? 0}
          getDuration={() => audioRef.current?.duration ?? 0}
        />
      )}

      <audio
        ref={audioRef}
        src={url}
        controls
        data-testid="audio-element"
        onError={() => setDecodeError(true)}
        style={{ width: "100%" }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
        <button
          onClick={cycleSpeed}
          data-testid="audio-speed-btn"
          style={toolbarBtnStyle}
          title="Cycle playback speed"
        >
          <ForwardIcon style={{ width: 12, height: 12 }} />
          {rate}x
        </button>
        <button
          onClick={() => setLoop((v) => !v)}
          data-testid="audio-loop-btn"
          aria-pressed={loop}
          style={{ ...toolbarBtnStyle, color: loop ? "#a6e3a1" : "#a6adc8" }}
          title="Loop"
        >
          <ArrowUturnLeftIcon style={{ width: 12, height: 12 }} />
          Loop {loop ? "on" : "off"}
        </button>
        <div style={{ flex: 1 }} />
        {decodeError && (
          <>
            <span style={{ color: "#f9e2af", fontSize: 11 }} data-testid="audio-decode-error">
              Browser cannot decode this format.
            </span>
            <button onClick={openInSystem} style={toolbarBtnStyle} data-testid="audio-open-system">
              Open in system player
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const toolbarBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  background: "#313244",
  border: "1px solid #45475a",
  borderRadius: 4,
  color: "#a6adc8",
  cursor: "pointer",
  fontSize: 11,
  padding: "3px 8px",
};
