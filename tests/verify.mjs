// 校验管线测试片：编码参数、逐帧条码（无丢帧/重帧/旧帧）、白闪 vs 滴答的音画偏差、响度
import { execFileSync } from 'node:child_process';

const file = process.argv[2] ?? 'out/test.mp4';
const sh = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { maxBuffer: 1 << 30, ...opts });

const probe = JSON.parse(sh('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
const v = probe.streams.find((s) => s.codec_type === 'video');
const a = probe.streams.find((s) => s.codec_type === 'audio');
const [num, den] = v.r_frame_rate.split('/').map(Number);
const fps = num / den, W = v.width, H = v.height;
console.log(`video  ${v.codec_name} ${v.profile} ${v.pix_fmt} ${W}×${H} ${fps}fps  frames=${v.nb_frames}  color=${v.color_space}/${v.color_primaries}/${v.color_transfer}/${v.color_range}`);
console.log(`audio  ${a ? `${a.codec_name} ${a.sample_rate}Hz ${a.channels}ch` : 'none'}  duration=${probe.format.duration}s`);

// 逐帧条码
const raw = sh('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
const fsz = W * H, n = raw.length / fsz, s = W / 1920;
let bad = 0, flashFrame = -1, flashLum = 0;
for (let f = 0; f < n; f++) {
  const base = f * fsz;
  let ms = 0;
  for (let i = 0; i < 12; i++) ms = (ms << 1) | (raw[base + Math.round(1050 * s) * W + Math.round((30 + i * 60) * s)] > 128 ? 1 : 0);
  const want = Math.round((f / fps) * 1000);
  if (ms !== want) { bad++; if (bad <= 5) console.log(`  frame ${f}: barcode ${ms}ms, expected ${want}ms`); }
  let sum = 0;
  for (let y = 0; y < Math.round(1000 * s); y += 8) for (let x = 0; x < W; x += 8) sum += raw[base + y * W + x];
  if (sum > flashLum) { flashLum = sum; flashFrame = f; }
}
console.log(`frames ${n} decoded, ${bad === 0 ? 'all barcodes match (no dropped / duplicated / stale frames)' : `${bad} MISMATCHED`}`);
const flashT = flashFrame / fps;
console.log(`flash  frame ${flashFrame} → ${(flashT * 1000).toFixed(1)} ms`);

if (a) {
  const pcm = sh('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
  const x = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
  // 一阶差分当高通，找 0.3 s 之后第一个超过峰值 30% 的样本 = 滴答起点
  let peak = 0;
  for (let i = 1; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i] - x[i - 1]));
  let onset = -1;
  for (let i = Math.round(0.3 * 48000); i < x.length; i++) if (Math.abs(x[i] - x[i - 1]) > 0.3 * peak) { onset = i; break; }
  const tickT = onset / 48000;
  console.log(`tick   ${(tickT * 1000).toFixed(1)} ms  → A/V offset ${((tickT - flashT) * 1000).toFixed(1)} ms (audio ${tickT >= flashT ? 'after' : 'before'} video)`);
  const log = execFileSync('sh', ['-c', `ffmpeg -hide_banner -nostats -i "${file}" -map 0:a -af ebur128=peak=true -f null - 2>&1 | tail -12`]).toString();
  const I = log.match(/I:\s+(-?[\d.]+) LUFS/), TP = log.match(/Peak:\s+(-?[\d.]+) dBFS/);
  console.log(`loud   integrated ${I?.[1]} LUFS, true peak ${TP?.[1]} dBFS`);
}
