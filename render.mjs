#!/usr/bin/env node
/**
 * render.mjs — 逐帧离线渲染
 *
 * Playwright 无头 Chromium 打开页面，逐帧调用 window.seek(t)，截图（PNG）管道给 ffmpeg，
 * 编码 H.264 yuv420p（BT.709）。时间轴按 --seg 秒切段，每段独立编码成一个 mp4：
 * 改了哪几秒就只重渲染那几段，最后无损拼接并混入音轨（两遍 loudnorm 到 -14 LUFS，AAC）。
 *
 * 用法：
 *   node render.mjs                                  # final：1920×1080 60fps 全片 → out/final.mp4
 *   node render.mjs --preset animatic                # 960×540 30fps → out/animatic.mp4
 *   node render.mjs --start 12 --end 16              # 只重渲染 12–16 s 覆盖的段，再重新拼接
 *   node render.mjs --audio out/score.wav            # 混入音轨
 *   node render.mjs --page tests/pipeline.html --preset test --out out/test.mp4
 *
 * 选项：
 *   --preset final|animatic|test   分辨率/帧率预设（默认 final）
 *   --width --height --fps         覆盖预设
 *   --page <html>                  默认 index.html
 *   --start <s> --end <s>          要（重新）渲染的时间范围，默认整片
 *   --ranges 0-3.2,16-19.2         多段时间范围（覆盖 --start/--end）
 *   --seg <s>                      分段长度，默认 2
 *   --workers <n>                  并行浏览器页数，默认 min(4, CPU 数)
 *   --crf <n>                      默认 16
 *   --x264-preset <p>              默认 slow
 *   --audio <wav>                  混入的音轨
 *   --lufs <n>                     响度目标，默认 -14
 *   --skip-existing                跳过已存在且比页面文件新的分段（断点续渲）
 *   --no-concat                    只渲染分段，不拼接
 *   --out <mp4>                    默认 out/<preset>.mp4
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PRESETS = {
  final: { width: 1920, height: 1080, fps: 60 },
  animatic: { width: 960, height: 540, fps: 30 },
  test: { width: 1920, height: 1080, fps: 60 },
};

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) throw new Error(`unexpected argument: ${k}`);
    const key = k.slice(2);
    if (key.startsWith('no-')) a[key.slice(3)] = false;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) a[key] = argv[++i];
    else a[key] = true;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const presetName = args.preset ?? 'final';
const preset = PRESETS[presetName];
if (!preset) throw new Error(`unknown preset: ${presetName}`);
const W = +(args.width ?? preset.width);
const H = +(args.height ?? preset.height);
const FPS = +(args.fps ?? preset.fps);
const CRF = +(args.crf ?? 16);
const X264_PRESET = args['x264-preset'] ?? 'slow';
const SEG = +(args.seg ?? 2);
const LUFS = +(args.lufs ?? -14);
const pagePath = path.resolve(args.page ?? 'index.html');
const outPath = path.resolve(args.out ?? `out/${presetName}.mp4`);
const segDir = path.resolve('out/segs', `${path.basename(pagePath, '.html')}-${W}x${H}@${FPS}`);
fs.mkdirSync(segDir, { recursive: true });
fs.mkdirSync(path.dirname(outPath), { recursive: true });

// ---------------------------------------------------------------- helpers

function run(cmd, argv, { input, capture } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(capture ? err + out : out) : reject(new Error(`${cmd} exited ${code}\n${err}`))));
    if (input) input(p.stdin);
  });
}

const fmtTime = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${s.toFixed(1)}s`);

async function openPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error(`[page ${m.type()}] ${m.text()}`); });
  await page.goto(`${pathToFileURL(pagePath)}?w=${W}&h=${H}`);
  await page.evaluate(() => window.ready); // 字体、预计算等就绪
  if (errors.length) throw errors[0];
  // 直接读 canvas 的像素（toDataURL），不经过合成器：保证拿到的就是 seek(t) 刚画的那一帧
  const grab = async (t) => {
    const url = await page.evaluate((t) => { window.seek(t); return document.querySelector('canvas').toDataURL('image/png'); }, t);
    if (errors.length) throw errors[0];
    return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  };
  return { ctx, page, grab };
}

function encoderArgs(file) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    // canvas 是 sRGB → 用 BT.709 矩阵转 limited-range YUV，并写对色彩标签
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p',
    '-c:v', 'libx264', '-preset', X264_PRESET, '-crf', String(CRF), '-profile:v', 'high',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-video_track_timescale', String(FPS * 1000),
    file,
  ];
}

// ---------------------------------------------------------------- render

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb'],
});

const probe = await openPage(browser);
const info = await probe.page.evaluate(() => ({ duration: window.DURATION, info: window.PAGE_INFO ?? null }));
const DURATION = +info.duration;
if (!(DURATION > 0)) throw new Error('page must expose window.DURATION');
console.log(`page      ${path.relative(process.cwd(), pagePath)}  (${DURATION}s)${info.info ? '  ' + JSON.stringify(info.info) : ''}`);
console.log(`format    ${W}×${H} @ ${FPS}fps  crf ${CRF}  x264 ${X264_PRESET}  seg ${SEG}s`);

const totalFrames = Math.round(DURATION * FPS);
const segFrames = Math.round(SEG * FPS);
const nSeg = Math.ceil(totalFrames / segFrames);
const segFile = (k) => path.join(segDir, `seg_${String(k).padStart(4, '0')}.mp4`);

const ranges = args.ranges ? String(args.ranges).split(',').map((r) => r.split('-').map(Number)) : [[+(args.start ?? 0), +(args.end ?? DURATION)]];
const todo = [];
const pageMtime = fs.statSync(pagePath).mtimeMs;
for (const [a, b] of ranges) {
  const f0 = Math.max(0, Math.floor(a * FPS)), f1 = Math.min(totalFrames, Math.ceil(b * FPS));
  for (let k = Math.floor(f0 / segFrames); k * segFrames < f1; k++) {
    if (todo.includes(k)) continue;
    if (args['skip-existing'] && fs.existsSync(segFile(k)) && fs.statSync(segFile(k)).mtimeMs > pageMtime) continue;
    todo.push(k);
  }
}
todo.sort((x, y) => x - y);
if (!todo.length) console.log('render    nothing to do (all segments up to date)');

const nWorkers = Math.max(1, Math.min(+(args.workers ?? Math.min(4, os.cpus().length)), todo.length || 1));
const workers = [probe];
while (workers.length < nWorkers) workers.push(await openPage(browser));

const framesTodo = todo.reduce((n, k) => n + Math.min(segFrames, totalFrames - k * segFrames), 0);
if (todo.length) console.log(`render    ${todo.length} segments (${todo[0]}–${todo[todo.length - 1]} of ${nSeg}), ${framesTodo} frames, ${nWorkers} workers`);

let done = 0;
const t0 = Date.now();
const progress = () => {
  const el = (Date.now() - t0) / 1000;
  const rate = done / el;
  const line = `  ${done}/${framesTodo} frames  ${rate.toFixed(1)} fps  elapsed ${fmtTime(el)}  eta ${fmtTime((framesTodo - done) / Math.max(rate, 1e-6))}`;
  if (process.stdout.isTTY) process.stdout.write(`\r${line}   `);
  else if (done % (FPS * 2) === 0 || done === framesTodo) console.log(line);
};

let next = 0;
await Promise.all(workers.map(async (w) => {
  while (next < todo.length) {
    const k = todo[next++];
    const a = k * segFrames, b = Math.min(totalFrames, a + segFrames);
    const tmp = segFile(k) + '.part.mp4';
    await run('ffmpeg', encoderArgs(tmp), {
      input: async (stdin) => {
        try {
          for (let f = a; f < b; f++) {
            const png = await w.grab(f / FPS);
            if (!stdin.write(png)) await new Promise((r) => stdin.once('drain', r));
            done++;
            progress();
          }
        } finally {
          stdin.end();
        }
      },
    });
    fs.renameSync(tmp, segFile(k));
  }
}));
if (process.stdout.isTTY) process.stdout.write('\n');
await browser.close();
console.log(`frames    done in ${fmtTime((Date.now() - t0) / 1000)}`);

if (args.concat === false) process.exit(0);

// ---------------------------------------------------------------- concat + audio

const missing = [];
for (let k = 0; k < nSeg; k++) if (!fs.existsSync(segFile(k))) missing.push(k);
if (missing.length) {
  console.error(`cannot concat: missing segments ${missing.join(',')} (render them with --start/--end)`);
  process.exit(1);
}
const list = path.join(segDir, 'list.txt');
fs.writeFileSync(list, Array.from({ length: nSeg }, (_, k) => `file '${segFile(k)}'\n`).join(''));

const muxArgs = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list];
if (args.audio) {
  const audio = path.resolve(args.audio);
  // 两遍 loudnorm：先测量，再线性归一到目标响度
  const target = `I=${LUFS}:TP=-1.0:LRA=11`;
  const log = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', audio, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'], { capture: true });
  const m = JSON.parse(log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1));
  const af = `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`;
  console.log(`audio     ${path.relative(process.cwd(), audio)}  measured ${m.input_i} LUFS → ${LUFS} LUFS`);
  muxArgs.push('-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-af', af, '-c:a', 'aac', '-b:a', '256k', '-ar', '48000');
} else {
  muxArgs.push('-c:v', 'copy');
}
muxArgs.push('-t', String(DURATION), '-movflags', '+faststart', outPath);
await run('ffmpeg', muxArgs);
console.log(`output    ${path.relative(process.cwd(), outPath)}`);
