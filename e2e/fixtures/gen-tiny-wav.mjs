// Generates a tiny synthetic WAV file used by the audio E2E specs.
import fs from "node:fs";
import path from "node:path";

const SR = 8000;
const SECONDS = 0.2;
const FREQ = 440;
const N = Math.floor(SR * SECONDS);

function writeAscii(buf, offset, s) { for (let i = 0; i < s.length; i++) buf[offset + i] = s.charCodeAt(i); }

const dataBytes = N * 2;
const buf = Buffer.alloc(44 + dataBytes);

writeAscii(buf, 0, "RIFF");
buf.writeUInt32LE(36 + dataBytes, 4);
writeAscii(buf, 8, "WAVE");
writeAscii(buf, 12, "fmt ");
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
writeAscii(buf, 36, "data");
buf.writeUInt32LE(dataBytes, 40);

for (let i = 0; i < N; i++) {
  const v = Math.round(Math.sin((2 * Math.PI * FREQ * i) / SR) * 16000);
  buf.writeInt16LE(v, 44 + i * 2);
}

const out = path.resolve(process.argv[2] || path.join(import.meta.dirname || ".", "tiny.wav"));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buf);
console.log(`wrote ${out} (${buf.length} bytes)`);
