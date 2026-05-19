// @test-skip: Canvas + WebAudio rendering; behaviour validated by CDP visual proof.
/**
 * AudioWaveform — decodes audio bytes with WebAudio and paints a thin
 * waveform thumbnail onto a canvas. Click anywhere on the canvas to seek
 * the host audio element to that position.
 *
 * Decoding is async; until it finishes we show a slim placeholder bar.
 * If decode fails (codec not supported by WebAudio), we render nothing
 * and the host AudioPlayer carries on with the native controls only.
 *
 * Performance:
 *   - We downsample to BUCKETS peak amplitudes (one canvas pixel column
 *     per ~CANVAS_WIDTH/BUCKETS pixels). For a 5-minute song at 44.1 kHz
 *     this is ~13 million samples → 512 peaks → trivially fast.
 *   - decodeAudioData is called once per mount; the resulting buffer is
 *     kept in component state only long enough to compute peaks, then
 *     released.
 */
import { useEffect, useRef, useState } from "react";

interface Props {
  bytes: ArrayBuffer;
  onSeek: (sec: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
}

const BUCKETS = 512;
const CANVAS_HEIGHT = 64;

export function AudioWaveform({ bytes, onSeek, getCurrentTime, getDuration }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [failed, setFailed] = useState(false);

  // Decode → peaks
  useEffect(() => {
    let cancelled = false;
    const AC: typeof AudioContext | undefined = (window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!AC) {
      setFailed(true);
      return;
    }
    const ctx = new AC();
    // decodeAudioData detaches the ArrayBuffer; pass a copy so callers can
    // still feed the same bytes to <audio>.
    const copy = bytes.slice(0);
    ctx.decodeAudioData(copy)
      .then((buf) => {
        if (cancelled) return;
        const channel = buf.getChannelData(0);
        const bucketSize = Math.max(1, Math.floor(channel.length / BUCKETS));
        const out = new Float32Array(BUCKETS);
        for (let i = 0; i < BUCKETS; i++) {
          let peak = 0;
          const start = i * bucketSize;
          const end = Math.min(channel.length, start + bucketSize);
          for (let j = start; j < end; j++) {
            const v = Math.abs(channel[j]);
            if (v > peak) peak = v;
          }
          out[i] = peak;
        }
        setPeaks(out);
      })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { ctx.close().catch(() => {}); });
    return () => { cancelled = true; };
  }, [bytes]);

  // Paint + cursor animation
  useEffect(() => {
    if (!peaks || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    canvas.width = cssW * dpr;
    canvas.height = CANVAS_HEIGHT * dpr;
    ctx.scale(dpr, dpr);

    const drawBars = () => {
      ctx.clearRect(0, 0, cssW, CANVAS_HEIGHT);
      ctx.fillStyle = "#45475a";
      const midY = CANVAS_HEIGHT / 2;
      const barW = cssW / BUCKETS;
      for (let i = 0; i < BUCKETS; i++) {
        const h = Math.max(1, peaks[i] * (CANVAS_HEIGHT * 0.95));
        const x = i * barW;
        ctx.fillRect(x, midY - h / 2, Math.max(1, barW - 0.5), h);
      }
    };
    const drawCursor = () => {
      const dur = getDuration();
      if (!Number.isFinite(dur) || dur <= 0) return;
      const t = getCurrentTime();
      const x = (t / dur) * cssW;
      ctx.fillStyle = "#f9e2af";
      ctx.fillRect(x - 1, 0, 2, CANVAS_HEIGHT);
    };

    let raf = 0;
    const tick = () => {
      drawBars();
      drawCursor();
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { cancelAnimationFrame(raf); };
  }, [peaks, getCurrentTime, getDuration]);

  if (failed) return null;

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const dur = getDuration();
    if (Number.isFinite(dur) && dur > 0) onSeek(ratio * dur);
  };

  return (
    <canvas
      ref={canvasRef}
      data-testid="audio-waveform"
      onClick={handleClick}
      style={{
        width: "100%",
        height: CANVAS_HEIGHT,
        background: "#181825",
        borderRadius: 4,
        cursor: "pointer",
        display: peaks ? "block" : "none",
      }}
    />
  );
}
