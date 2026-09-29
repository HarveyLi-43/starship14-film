#!/usr/bin/env node
// 按时刻抽帧检查：node scripts/stills.mjs [--w 960] [--h 540] [--cols 4] [--out out/stills] 0.5 3 5.2 ...
// 每个时刻存一张 PNG，并拼一张总览 sheet.png（每张下方标注不了文字，按文件名顺序排列）
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2), opt = { w: 960, h: 540, cols: 4, out: 'out/stills', page: 'index.html' }, times = [];
for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i]; else times.push(+argv[i]); }
fs.rmSync(opt.out, { recursive: true, force: true }); fs.mkdirSync(opt.out, { recursive: true });
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb'] });
const page = await (await browser.newContext({ viewport: { width: +opt.w, height: +opt.h }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
await page.goto(`${pathToFileURL(path.resolve(opt.page))}?w=${opt.w}&h=${opt.h}`);
await page.evaluate(() => window.ready);
for (const [i, t] of times.entries()) {
  const t0 = Date.now();
  const url = await page.evaluate((t) => { window.seek(t); return document.querySelector('canvas').toDataURL('image/png'); }, t);
  const shot = await page.evaluate(() => window.SHOT);
  fs.writeFileSync(path.join(opt.out, `${String(i).padStart(3, '0')}.png`), Buffer.from(url.split(',')[1], 'base64'));
  console.log(`t=${t.toFixed(2)}  ${shot}  ${Date.now() - t0} ms`);
}
await browser.close();
const rows = Math.ceil(times.length / +opt.cols);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(opt.out, '%03d.png'), '-vf', `scale=480:-1,tile=${opt.cols}x${rows}:padding=4`, '-frames:v', '1', path.join(opt.out, 'sheet.png')]);
console.log(`sheet → ${path.join(opt.out, 'sheet.png')}`);
