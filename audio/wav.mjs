// 最小 WAV 写出：Float32 声道数组 → 24-bit PCM WAV（TPDF 抖动）
import fs from 'node:fs';
import path from 'node:path';

export function writeWav(file, channels, sampleRate = 48000) {
  const n = channels[0].length, nc = channels.length, bps = 3;
  const buf = Buffer.alloc(44 + n * nc * bps);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * nc * bps, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(nc, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * nc * bps, 28); buf.writeUInt16LE(nc * bps, 32); buf.writeUInt16LE(24, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * nc * bps, 40);
  let seed = 0x9e3779b9, o = 44;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      const x = channels[c][i] * 8388607 + (rnd() - rnd());
      buf.writeIntLE(Math.max(-8388608, Math.min(8388607, Math.round(x))), o, 3);
      o += 3;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}
