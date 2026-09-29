// 管线测试音轨：1 s 管风琴和弦（A2 E3 A3 C#4 加法合成）+ 0.500 s 处的滴答（对应画面白闪）
import { writeWav } from '../audio/wav.mjs';

const SR = 48000, N = SR * 1;
const L = new Float32Array(N), R = new Float32Array(N);
const notes = [110, 164.81, 220, 277.18];
const partials = [[1, 1], [2, 0.5], [3, 0.3], [4, 0.2], [6, 0.1], [8, 0.06]];
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const env = Math.min(1, t / 0.12) * Math.min(1, (1 - t) / 0.1);
  let l = 0, r = 0;
  notes.forEach((f, j) => {
    for (const [h, a] of partials) {
      const v = a * Math.sin(2 * Math.PI * f * h * t * (1 + 0.0007 * j));
      l += v * (0.6 + 0.1 * j); r += v * (0.9 - 0.1 * j);
    }
  });
  L[i] = 0.05 * env * l; R[i] = 0.05 * env * r;
}
// 滴答：2.4 kHz 衰减正弦，起点正好在 0.5 s
const s0 = SR * 0.5;
for (let i = 0; i < SR * 0.03; i++) {
  const v = 0.6 * Math.sin(2 * Math.PI * 2400 * i / SR) * Math.exp(-i / (SR * 0.006));
  L[s0 + i] += v; R[s0 + i] += v;
}
writeWav('out/test-tone.wav', [L, R], SR);
console.log('wrote out/test-tone.wav');
