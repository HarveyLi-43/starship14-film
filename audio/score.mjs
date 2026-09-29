#!/usr/bin/env node
/**
 * audio/score.mjs — 《不回头》的配乐与音效，全部代码合成，和 index.html 共用同一条时间线（秒）。
 * 输出 out/score.wav（48 kHz / 24-bit / 立体声）：响度归一到 −14 LUFS（BS.1770），真峰值 ≤ −1 dBTP。
 *
 *   node audio/score.mjs            # 合成并打印每个镜头的短时响度
 *
 * 声音设计见 docs/style_guide.md §9、docs/shotlist.md「音画同步点」：
 *   六声部和弦 = 六台发动机；17.2 s RVac 熄火时和弦掉掉三音（F），直到 57.6 s 以大三度（F#）回来；
 *   20.0–20.8 s 绝对安静；26 个钟琴音 = 26 颗卫星；53.6 s 起渐慢，和画面上尾焰闪烁变慢同步。
 * 旋律原创：主题 = 上行五度 + 级进下行（D–A–G–F–E–D），D 多利亚 → 结尾 D 大调。
 */
import { writeWav } from './wav.mjs';

const SR = 48000, DUR = 60, N = SR * DUR, TAU = Math.PI * 2;

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rng = mulberry32(1409);
const noise = () => rng() * 2 - 1;
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const idx = (t) => Math.max(0, Math.min(N, Math.round(t * SR)));
const panLR = (p) => [Math.cos(((clamp(p, -1, 1) + 1) * Math.PI) / 4), Math.sin(((clamp(p, -1, 1) + 1) * Math.PI) / 4)];
const buf = () => [new Float32Array(N), new Float32Array(N)];
const BUS = { mus: buf(), sfx: buf(), dry: buf() };   // 音乐（大混响）/ 音效（小混响）/ 干声

// ------------------------------------------------------------------ 滤波器
function biquad(type, f, q = 0.707) {
  const w0 = (TAU * f) / SR, cw = Math.cos(w0), al = Math.sin(w0) / (2 * q);
  let b0, b1, b2;
  if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; } else if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; } else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
  const a0 = 1 + al, a1 = (-2 * cw) / a0, a2 = (1 - al) / a0; b0 /= a0; b1 /= a0; b2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => { const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}
// 时变状态变量滤波器（TPT），mode：0 低通 1 带通 2 高通
function svf(mode) {
  let ic1 = 0, ic2 = 0;
  return (x, fc, q) => {
    const g = Math.tan((Math.PI * Math.min(fc, SR * 0.45)) / SR), k = 1 / q, a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    return mode === 0 ? v2 : mode === 1 ? v1 : x - k * v1 - v2;
  };
}
function env(t, dur, att, rel) {
  if (t < 0) return 0;
  const a = t < att ? Math.sin((0.5 * Math.PI * t) / att) : 1;
  return t < dur ? a : a * Math.exp(-(t - dur) / rel);
}

// ------------------------------------------------------------------ 乐器
const REG = {   // 管风琴音栓：[泛音倍数, 振幅]
  full: [[0.5, 0.3], [1, 1], [2, 0.6], [3, 0.3], [4, 0.32], [5, 0.12], [6, 0.16], [8, 0.12], [10, 0.05], [12, 0.06]],
  principal: [[1, 1], [2, 0.45], [3, 0.12], [4, 0.18], [6, 0.05]],
  flute: [[1, 1], [2, 0.22], [3, 0.05]],
};
function organ(t0, dur, m, vel, o = {}) {
  const bus = o.bus ?? BUS.mus, reg = REG[o.reg ?? 'principal'], att = o.att ?? 0.07, rel = o.rel ?? 0.3, [pl, pr] = panLR(o.pan ?? 0);
  const f = mtof(m), parts = reg.filter(([h]) => f * h < 15000 && f * h > 20);
  const norm = 1.6 / parts.reduce((s, [, a]) => s + a, 0);
  const i0 = idx(t0), i1 = idx(t0 + dur + rel * 7);
  const ph = parts.map(() => rng() * TAU), w = parts.map(([h], k) => (TAU * f * h * (1 + ((k % 3) - 1) * 0.0008)) / SR);
  const chiff = biquad('bp', Math.min(f * 4, 6000), 2.5);
  for (let i = i0; i < i1; i++) {
    const n = i - i0, t = n / SR, e = env(t, dur, att, rel) * vel;
    let s = 0;
    for (let k = 0; k < parts.length; k++) s += parts[k][1] * Math.sin(ph[k] + w[k] * n);
    const ch = t < 0.08 ? chiff(noise()) * Math.exp(-t / 0.018) * 0.6 : 0;   // 起音的一小口气
    const v = (s * norm * (1 + 0.012 * Math.sin(TAU * 0.4 * t)) + ch) * e;
    bus[0][i] += v * pl; bus[1][i] += v * pr;
  }
}
function polyblep(t, dt) { if (t < dt) { t /= dt; return t + t - t * t - 1; } if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; } return 0; }
function strings(t0, dur, m, vel, o = {}) {
  const bus = o.bus ?? BUS.mus, att = o.att ?? 0.5, rel = o.rel ?? 0.9, f = mtof(m);
  const i0 = idx(t0), i1 = idx(t0 + dur + rel * 7);
  const vs = [-9, -3.5, 0, 3.5, 9].map((c, k) => ({ inc: (f * Math.pow(2, c / 1200)) / SR, p: rng(), pan: panLR(((k - 2) / 2) * 0.7 + (o.pan ?? 0)), vp: rng() * TAU }));
  const fl = svf(0), fr = svf(0), fc = Math.min(9000, f * (2.5 + 5 * (o.bright ?? 0.5)));
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR, e = env(t, dur, att, rel) * vel * 0.2;
    let l = 0, r = 0;
    for (const v of vs) {
      const inc = v.inc * (1 + 0.0028 * Math.sin(TAU * 5.3 * t + v.vp) * smooth(0.15, 0.7, t));
      v.p += inc; if (v.p >= 1) v.p -= 1;
      const s = 2 * v.p - 1 - polyblep(v.p, inc);
      l += s * v.pan[0]; r += s * v.pan[1];
    }
    bus[0][i] += fl(l, fc, 0.7) * e; bus[1][i] += fr(r, fc, 0.7) * e;
  }
}
function bell(t0, m, vel, pan = 0) {   // FM 钟琴
  const f = mtof(m), i0 = idx(t0), i1 = idx(t0 + 3), [pl, pr] = panLR(pan);
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR, I = 3.0 * Math.exp(-t / 0.16);
    const s = Math.sin(TAU * f * t + I * Math.sin(TAU * f * 3.5 * t)) * Math.exp(-t / 0.85) * Math.min(1, t / 0.002) * vel;
    BUS.mus[0][i] += s * pl; BUS.mus[1][i] += s * pr;
  }
}
function tone(t0, dur, f, vel, o = {}) {   // 正弦：踏板低音、小提琴泛音
  const bus = o.bus ?? BUS.mus, att = o.att ?? 0.3, rel = o.rel ?? 0.5, [pl, pr] = panLR(o.pan ?? 0);
  for (let i = idx(t0), i1 = idx(t0 + dur + rel * 7), i0 = i; i < i1; i++) {
    const t = (i - i0) / SR, vib = (o.vib ?? 0) * Math.sin(TAU * 5 * t) * smooth(0.3, 1, t);
    const v = Math.sin(TAU * f * t * (1 + vib) + 0.3 * Math.sin(TAU * f * 2 * t) * (o.edge ?? 0)) * env(t, dur, att, rel) * vel;
    bus[0][i] += v * pl; bus[1][i] += v * pr;
  }
}

// ------------------------------------------------------------------ 音效
function rumble(t0, t1, amp, cut, seed = 1, bus = BUS.sfx) {   // 棕噪隆隆声，截止频率随时间变化
  const r = mulberry32(seed); let bl = 0, br = 0, l1 = 0, l2 = 0, r1 = 0, r2 = 0;
  for (let i = idx(t0); i < idx(t1); i++) {
    const t = i / SR; bl = 0.996 * bl + (r() * 2 - 1) * 0.09; br = 0.996 * br + (r() * 2 - 1) * 0.09;
    const a = 1 - Math.exp((-TAU * cut(t)) / SR);
    l1 += a * (bl - l1); l2 += a * (l1 - l2); r1 += a * (br - r1); r2 += a * (r1 - r2);
    const g = amp(t) * 2.2; bus[0][i] += l2 * g; bus[1][i] += r2 * g;
  }
}
function crackle(t0, t1, rate, amp, seed = 2, fc = 2600) {   // 猛禽的「爆裂声」：泊松脉冲 + 带通
  const r = mulberry32(seed), i0 = idx(t0), i1 = idx(t1), L = new Float32Array(i1 - i0 + 400), R = new Float32Array(i1 - i0 + 400);
  let t = t0;
  for (;;) {
    t += -Math.log(1 - r()) / Math.max(1, rate(t)); if (t >= t1) break;
    const i = idx(t) - i0, a = amp(t) * Math.min(3, 0.25 / Math.pow(r() + 0.03, 0.8)), len = 24 + Math.floor(r() * 140), p = r();
    for (let k = 0; k < len; k++) { const v = a * (r() * 2 - 1) * Math.exp(-k / (len * 0.3)); L[i + k] += v * (1 - p); R[i + k] += v * p; }
  }
  const bl = biquad('bp', fc, 0.7), br = biquad('bp', fc, 0.7);
  for (let i = i0; i < i1; i++) { BUS.sfx[0][i] += bl(L[i - i0]); BUS.sfx[1][i] += br(R[i - i0]); }
}
function thump(t0, f0, f1, dur, gain, bus = BUS.sfx) {   // 低频冲击：下滑正弦 + 一声短噪
  const i0 = idx(t0), i1 = idx(t0 + dur * 3); let ph = 0;
  const lp = biquad('lp', 900, 0.7);
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR, f = f1 + (f0 - f1) * Math.exp(-t / 0.09);
    ph += (TAU * f) / SR;
    const v = (Math.sin(ph) * Math.exp(-t / (dur * 0.4)) + (t < 0.012 ? lp(noise()) * 1.5 * (1 - t / 0.012) : 0)) * Math.min(1, t / 0.003) * gain;
    bus[0][i] += v; bus[1][i] += v;
  }
}
function boom(t0, gain) {   // 音爆：N 波
  const i0 = idx(t0), i1 = idx(t0 + 1.2), lp = biquad('lp', 650, 0.8), W = 0.16;
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR, n = t < W ? 1 - (2 * t) / W : 0;
    const v = lp(n) * gain; BUS.sfx[0][i] += v; BUS.sfx[1][i] += v * 0.96;
  }
  thump(t0, 55, 36, 1.2, gain * 0.5);
}
function hiss(t0, t1, amp, fc, q = 0.8, mode = 1, seed = 3) {
  const r = mulberry32(seed), fl = svf(mode), fr = svf(mode);
  for (let i = idx(t0); i < idx(t1); i++) { const t = i / SR, a = amp(t), f = typeof fc === 'function' ? fc(t) : fc; BUS.sfx[0][i] += fl(r() * 2 - 1, f, q) * a; BUS.sfx[1][i] += fr(r() * 2 - 1, f, q) * a; }
}
function metal(t0, fr, dec, gain) {
  const i0 = idx(t0), i1 = idx(t0 + Math.max(...dec) * 5);
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR; let v = 0;
    fr.forEach((f, k) => { v += Math.sin(TAU * f * t + k) * Math.exp(-t / dec[k]) / (k + 1); });
    v *= gain * Math.min(1, t / 0.002); BUS.sfx[0][i] += v; BUS.sfx[1][i] += v * 0.9;
  }
}
function glide(t0, dur, f0, f1, gain) {   // 涡轮泵降速
  let ph = 0;
  for (let i = idx(t0), i1 = idx(t0 + dur), i0 = i; i < i1; i++) {
    const x = (i - i0) / (i1 - i0), f = f0 * Math.pow(f1 / f0, Math.pow(x, 0.7));
    ph += (TAU * f) / SR;
    const v = (Math.sin(ph) + 0.3 * Math.sin(2 * ph) + 0.12 * Math.sin(3.01 * ph)) * Math.pow(1 - x, 1.5) * Math.min(1, x * 40) * gain;
    BUS.sfx[0][i] += v; BUS.sfx[1][i] += v;
  }
}
function whoosh(t0, dur, fa, fb, gain, q = 2.5, seed = 5) {
  const r = mulberry32(seed), fl = svf(1), fr = svf(1);
  for (let i = idx(t0), i1 = idx(t0 + dur), i0 = i; i < i1; i++) {
    const x = (i - i0) / (i1 - i0), f = fa * Math.pow(fb / fa, x), e = Math.pow(Math.sin(Math.PI * x), 1.5) * gain;
    BUS.sfx[0][i] += fl(r() * 2 - 1, f, q) * e; BUS.sfx[1][i] += fr(r() * 2 - 1, f, q) * e;
  }
}
function swell(t0, dur, gain, fc = 2500, seed = 6) {   // 反向膨胀音：越来越响，然后戛然而止
  const r = mulberry32(seed), fl = svf(2), fr = svf(2);
  for (let i = idx(t0), i1 = idx(t0 + dur), i0 = i; i < i1; i++) {
    const x = (i - i0) / (i1 - i0), e = Math.pow(x, 3) * Math.min(1, (1 - x) * 200) * gain;
    BUS.sfx[0][i] += fl(r() * 2 - 1, fc, 0.7) * e; BUS.sfx[1][i] += fr(r() * 2 - 1, fc, 0.7) * e;
  }
}
function tick(t0, gain) {   // 打字声
  const hp = biquad('hp', 2500, 0.7);
  for (let i = idx(t0), i1 = idx(t0 + 0.006), i0 = i; i < i1; i++) { const v = hp(noise()) * gain * (1 - (i - i0) / (i1 - i0)); BUS.dry[0][i] += v; BUS.dry[1][i] += v; }
}
function typeTicks(str, t0, dt, gain, byWord = false) {
  const units = byWord ? str.split(/(?<= )/) : [...str];
  units.forEach((u, i) => { if (u.trim()) tick(t0 + i * dt, gain * (0.8 + 0.4 * rng())); });
}

// ------------------------------------------------------------------ 和声 / 节奏
const CH = {
  D6: [38, 45, 50, 53, 57, 64],     // 六声部 = 六台发动机（D2 A2 D3 F3 A3 E4）
  D5: [38, 45, 50, 57, 64],         // 掉了三音之后的空五度
  DMAJ: [38, 45, 50, 54, 57, 64],   // 片尾：三音以大三度 F# 回来
  BB: [46, 53, 58, 62], C: [48, 55, 60, 64], AM: [45, 52, 57, 60], A: [45, 52, 57, 61, 64], DSUS: [38, 45, 50, 55, 57],
};
const OST = [0, 7, 12, 14, 12, 7, 14, 19];   // 八分音符琶音（每小节 8 个，0.4 s 一个）
// 44.8 s 之后的速度图：53.6 s 起渐慢到 45%，和画面上尾焰闪烁变慢同步
const RIT = (t) => 1 - 0.55 * smooth(53.6, 57.6, t);
const TMAP = (() => { const a = []; let b = 0; for (let t = 44.8; t <= 60.001; t += 0.001) { a.push([b, t]); b += (RIT(t) * 0.001) / 0.8; } return a; })();
const realOf = (beat) => { const k = TMAP.findIndex(([b]) => b >= beat); return k < 0 ? 60 : TMAP[k][1]; };

// ================================================================== 时间线
// ---- S1 点火环 0.0–2.4：次声重击、三圈点火、轰鸣张开，2.4 硬切
thump(0.0, 60, 34, 1.8, 0.9);
[0.4, 0.8, 1.2].forEach((t, k) => thump(t, 70 - k * 6, 40, 0.8, 0.45));
rumble(0, 2.4, (t) => smooth(0, 1.2, t) * (1 - smooth(2.395, 2.4, t)) * 0.9, (t) => 150 + 1900 * smooth(0.2, 2.0, t), 11);
crackle(0.3, 2.4, (t) => 40 + 420 * smooth(0.3, 1.6, t), (t) => 0.4 * (1 - smooth(2.39, 2.4, t)), 12);
hiss(1.9, 2.4, (t) => 0.35 * smooth(1.9, 2.39, t) * (1 - smooth(2.395, 2.4, t)), 3000, 0.5, 2, 13);

// ---- S2 凌日 2.4–6.4：几乎无声 → 打字声 → 4.8 声浪到达
hiss(2.4, 6.4, (t) => 0.02 * smooth(2.4, 3.0, t), 500, 0.6, 0, 21);   // 远处海风
tone(2.45, 7.2, mtof(26), 0.10, { att: 1.5, rel: 1.2, bus: BUS.mus });  // D1 踏板
organ(2.45, 7.2, 38, 0.05, { reg: 'flute', att: 1.8, rel: 1.2 });
typeTicks('STARSHIP FLIGHT 14', 3.2, 0.04, 0.05);
typeTicks('2026.09.28 · 12:48 UTC', 3.6, 0.035, 0.045);
typeTicks('星舰第 14 次试飞 · 北京时间 20:48', 4.0, 0.05, 0.05);
rumble(4.8, 9.6, (t) => smooth(4.8, 5.1, t) * (0.75 - 0.35 * smooth(9.2, 10.4, t)), () => 900, 22);
crackle(4.8, 10.2, (t) => 380 * smooth(4.8, 5.0, t), (t) => 0.32 * (1 - smooth(9.6, 10.2, t)), 23);

// ---- S3 声障 6.4–9.6：五度垫底，8.0 最大动压闷响
organ(6.4, 3.2, 45, 0.05, { reg: 'flute', att: 1.2, rel: 0.6 });
thump(8.0, 46, 28, 2.2, 0.5);

// ---- S4 热分离 9.6–12.8：轰鸣变薄 → 10.4 脆裂 + 金属共鸣 → 飞船发动机的新音色
rumble(9.6, 10.45, (t) => 0.45 * (1 - smooth(10.35, 10.45, t)), (t) => 900 - 620 * smooth(9.6, 10.4, t), 31);
thump(10.4, 90, 45, 0.9, 0.6);
hiss(10.4, 10.5, (t) => 0.5 * (1 - smooth(10.4, 10.5, t)), 4000, 0.4, 1, 32);
metal(10.4, [410, 1127, 2170, 3380], [1.1, 0.7, 0.45, 0.3], 0.28);
whoosh(10.4, 1.3, 3200, 500, 0.3);
hiss(10.45, 12.8, (t) => 0.09 * smooth(10.45, 10.8, t) * (1 - smooth(12.78, 12.8, t)), 420, 1.4, 1, 33);
tone(10.45, 2.3, 110, 0.03, { bus: BUS.sfx, att: 0.2, rel: 0.02, edge: 0.6 });

// ---- S5 海上 12.8–16.0：两声音爆、着陆点火、水汽嘶声
boom(12.8, 0.8); boom(12.94, 0.6);
thump(13.6, 55, 36, 1.0, 0.45);
rumble(13.6, 15.26, (t) => smooth(13.6, 13.66, t) * (0.85 - 0.3 * smooth(14.3, 14.5, t)) * (1 - smooth(15.2, 15.26, t)), () => 1300, 41);
crackle(13.6, 15.25, () => 320, (t) => 0.3 * (1 - smooth(15.2, 15.25, t)), 42);
hiss(14.1, 16.0, (t) => 0.2 * smooth(14.1, 14.6, t) * (1 - 0.5 * smooth(15.2, 16, t)), 2200, 0.5, 2, 43);
hiss(12.8, 16.0, (t) => 0.045 * (0.7 + 0.3 * Math.sin(TAU * 0.3 * t)), 380, 0.6, 0, 44);   // 海浪

// ---- S6 少了一台 16.0–19.2：六声部和弦；17.2 掉一个声部 + 涡轮泵降速
hiss(16.0, 19.6, (t) => 0.06 * smooth(16, 16.3, t) * (1 - smooth(19.58, 19.6, t)) * (1 - 0.5 * smooth(17.2, 17.3, t)), 140, 1.2, 1, 51);
tone(16.0, 3.6, 55, 0.03, { bus: BUS.sfx, att: 0.3, rel: 0.02, edge: 0.4 });
CH.D6.forEach((m, k) => {
  const end = m === 53 ? 17.2 : 20.0;
  organ(16.0, end - 16.0, m, 0.075, { reg: 'principal', att: 0.6, rel: m === 53 ? 0.12 : 0.02, pan: (k - 2.5) * 0.2 });
  strings(16.0, end - 16.0, m + 12, 0.08, { att: 0.8, rel: m === 53 ? 0.15 : 0.02, pan: (2.5 - k) * 0.15 });
});
[16.85, 16.95, 17.08].forEach((t) => hiss(t, t + 0.05, () => 0.05, 180, 1, 1, 52));   // 熄火前抖了两下
glide(17.2, 1.5, 900, 170, 0.12);
metal(17.2, [178, 466, 887], [0.9, 0.5, 0.3], 0.22);

// ---- S7 入轨 19.2–23.2：19.6 关机 → 20.0–20.8 绝对安静 → 20.8 管风琴第一次完整进入
thump(19.6, 95, 48, 0.4, 0.3);
metal(19.6, [240, 610], [0.25, 0.15], 0.08);
[26, 38, 45, 50, 57, 62, 64, 69].forEach((m, k) => organ(20.8, 2.4, m, m < 30 ? 0.13 : 0.11, { reg: m < 30 ? 'principal' : 'full', att: 0.14, rel: 1.0, pan: (k - 3.5) * 0.12 }));
[50, 57, 64].forEach((m, k) => strings(20.8, 6.4, m, 0.09, { att: 1.2, rel: 1.5, pan: (k - 1) * 0.4 }));

// ---- S8 二十六 23.2–27.2：舱门 + 26 个钟琴音（每颗卫星一个）
thump(23.2, 120, 70, 0.3, 0.18); metal(23.2, [320, 760, 1450], [0.3, 0.2, 0.12], 0.08);
const BELLS = [62, 65, 67, 69, 72, 74, 77, 79, 81, 84, 86, 89, 91, 89, 86, 84, 81, 79, 77, 74, 72, 69, 67, 65, 62, 74];
BELLS.forEach((m, i) => { const t = 23.6 + i * 0.1333; bell(t, m, 0.07 + 0.03 * Math.sin((Math.PI * i) / 25), i % 2 ? 0.35 : -0.35); tick(t, 0.02); });
CH.BB.forEach((m) => strings(24.8, 2.4, m, 0.07, { att: 0.8, rel: 1.0 }));

// ---- S9 分岔 27.2–33.6：两次日出 → 夜面 → 离轨 → 等离子体 → 静默 → 点火，主题第一次出现
swell(27.05, 0.3, 0.14); swell(27.45, 0.3, 0.14);
CH.C.forEach((m) => strings(27.2, 1.0, m, 0.05, { att: 0.2, rel: 0.6 }));
CH.AM.forEach((m) => strings(28.0, 2.3, m - 12, 0.06, { att: 0.6, rel: 0.5 }));
[28.15, 28.3, 28.45].forEach((t) => hiss(t, t + 0.07, () => 0.05, 3500, 0.7, 1, 61));   // 调头的反作用力推进器
rumble(28.8, 29.75, (t) => 0.3 * smooth(28.8, 28.9, t) * (1 - smooth(29.6, 29.75, t)), () => 420, 62);
whoosh(29.85, 1.3, 2800, 350, 0.28, 2.0, 63);
crackle(29.9, 30.9, () => 160, (t) => 0.1 * Math.sin(Math.PI * clamp((t - 29.9) / 1.0)), 64, 1800);
thump(30.95, 70, 45, 0.5, 0.06);
tone(30.3, 2.2, mtof(86), 0.03, { att: 0.5, rel: 0.8, vib: 0.004 });   // 静默里一根小提琴泛音
thump(31.55, 60, 38, 1.4, 0.5);
rumble(31.55, 33.6, (t) => 0.28 * smooth(31.55, 31.7, t) * (1 - smooth(33.55, 33.6, t)), () => 500, 65);
typeTicks("But one didn't turn back.", 31.6, 0.13, 0.04, true);
typeTicks('但有一艘，没有回头。', 32.2, 0.07, 0.04);
const THEME1 = [[31.6, 0.8, 62], [32.4, 1.2, 69], [33.6, 0.4, 67], [34.0, 0.4, 65], [34.4, 0.8, 64], [35.2, 1.6, 62]];
THEME1.forEach(([t, d, m]) => { organ(t, d, m, 0.1, { reg: 'principal', att: 0.05, rel: 0.25 }); strings(t, d, m, 0.1, { att: 0.12, rel: 0.4, bright: 0.7 }); });
[[31.6, CH.D5], [33.6, CH.BB], [35.2, CH.C]].forEach(([t, ch]) => ch.forEach((m) => organ(t, 1.6, m - 12, 0.045, { reg: 'flute', att: 0.3, rel: 0.4 })));

// ---- S10–S12 33.6–44.8：八分音符琶音推进；38.4 虫洞低音簇；42.4 起隧道里音高扭曲
const OST_CHORDS = [[33.6, 50], [35.2, 46], [36.8, 48], [38.4, 50], [40.0, 46], [41.6, 48], [43.2, 45]];
for (let k = 0; k < 28; k++) {
  const t = 33.6 + k * 0.4, root = [...OST_CHORDS].reverse().find(([t0]) => t >= t0 - 1e-6)[1];
  const m = root + OST[k % 8], warp = t >= 42.4 ? Math.sin(TAU * 1.3 * (t - 42.4)) * 0.6 : 0;
  organ(t, 0.34, m + warp, 0.07 * (0.8 + 0.4 * smooth(33.6, 41.6, t)), { reg: 'flute', att: 0.01, rel: 0.12, pan: k % 2 ? 0.3 : -0.3 });
}
OST_CHORDS.forEach(([t, r]) => [r - 12, r - 5, r].forEach((m) => strings(t, 1.6, m, 0.06 + 0.05 * smooth(33.6, 41.6, t), { att: 0.4, rel: 0.5 })));
whoosh(34.9, 1.3, 700, 140, 0.3, 1.5, 71);                           // 月球掠过
[38, 39, 45, 51].forEach((m) => organ(38.4, 3.0, m, 0.06, { reg: 'principal', att: 1.0, rel: 0.6 }));   // 虫洞：低音簇
[2350, 3130, 3520].forEach((f, k) => tone(38.4, 3.2, f, 0.008, { att: 1.0, rel: 0.5, vib: 0.01, pan: k - 1 }));
swell(41.6, 0.8, 0.22, 1800, 72);
typeTicks('Do not go gentle into that good night.', 41.7, 0.1, 0.035, true);
typeTicks('不要温和地走进那个良夜', 42.55, 0.07, 0.035);
hiss(42.4, 44.8, (t) => 0.06 + 0.1 * smooth(42.4, 44.8, t), (t) => 600 + 2400 * (0.5 + 0.5 * Math.sin(TAU * 0.9 * t)), 3, 1, 73);
swell(43.2, 1.6, 0.35, 1200, 74);

// ---- S13–S14 44.8–60：冲出 → 全奏；48.0 主题高潮；53.6 起渐慢；57.6 缺的声部以 F# 回来
thump(44.8, 55, 30, 2.6, 0.8);
hiss(44.8, 47.8, (t) => 0.22 * Math.exp(-(t - 44.8) / 0.7), 5000, 0.5, 2, 81);   // 类似镲片的余响
[26, 38, 45, 50, 57, 62, 64, 69].forEach((m, k) => organ(44.8, 3.2, m, m < 30 ? 0.12 : 0.09, { reg: m < 30 ? 'principal' : 'full', att: 0.04, rel: 0.8, pan: (k - 3.5) * 0.12 }));
const LATE = [[48.0, CH.BB], [49.6, CH.C], [51.2, CH.D5], [52.8, CH.A], [54.4, CH.BB], [56.0, CH.DSUS], [57.6, CH.DMAJ]];
LATE.forEach(([t, ch], j) => {
  const end = j + 1 < LATE.length ? LATE[j + 1][0] : 59.6;
  ch.forEach((m, k) => {
    organ(t, end - t, m, 0.08 * (j === LATE.length - 1 ? 1.25 : 1), { reg: j < 5 ? 'full' : 'principal', att: 0.08, rel: j === LATE.length - 1 ? 0.3 : 0.2, pan: (k - 2) * 0.18 });
    strings(t, end - t, m + 12, 0.08, { att: 0.3, rel: 0.4, pan: (2 - k) * 0.15 });
  });
});
tone(44.8, 14.8, mtof(26), 0.09, { att: 0.3, rel: 0.3 });   // D1 踏板贯穿
for (let b = 1; b < 18; b += 0.5) {                          // 琶音按速度图（渐慢）排布
  const t = realOf(b); if (t >= 57.6) break;
  const root = [...[[44.8, 50], ...LATE.map(([tt, ch]) => [tt, ch[0] + (ch[0] < 44 ? 12 : 0)])]].reverse().find(([t0]) => t >= t0 - 1e-6)[1];
  const m = root + OST[Math.round(b * 2) % 8];
  organ(t, 0.3 / RIT(t), m, 0.055, { reg: 'flute', att: 0.01, rel: 0.12, pan: Math.round(b * 2) % 2 ? 0.3 : -0.3 });
  strings(t, 0.22 / RIT(t), m + 12, 0.05, { att: 0.02, rel: 0.12, bright: 0.8 });
}
const THEME2 = [[4, 1, 74], [5, 1.5, 81], [6.5, 0.5, 79], [7, 0.5, 77], [7.5, 1, 76], [8.5, 0.5, 77], [9, 0.5, 79], [9.5, 1, 81], [10.5, 1, 84], [11.5, 0.5, 82], [12, 0.5, 81], [12.5, 0, 74]];
THEME2.forEach(([b, d, m], j) => {
  const t = realOf(b), end = j === THEME2.length - 1 ? 57.6 : realOf(b + d);
  organ(t, end - t, m, 0.13, { reg: 'full', att: 0.05, rel: 0.25 });
  organ(t, end - t, m - 12, 0.09, { reg: 'principal', att: 0.05, rel: 0.25 });
  strings(t, end - t, m, 0.15, { att: 0.1, rel: 0.35, bright: 0.8 });
});
organ(57.6, 2.0, 78, 0.11, { reg: 'full', att: 0.25, rel: 0.3 });      // 旋律落在 F#5：补回来的那一声
strings(57.6, 2.0, 78, 0.13, { att: 0.35, rel: 0.3, bright: 0.7 });

// ================================================================== 混响 + 母带
function fdn(inL, inR, { rt60, resets = [], damp = 5200, pre = 0.03, size = 2.1 }) {
  const lens = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116].map((l) => Math.round(l * size));
  const bufs = lens.map((l) => new Float32Array(l)), pos = lens.map(() => 0), lp = new Float32Array(8), y = new Float32Array(8);
  const g = lens.map((l) => Math.pow(10, (-3 * l) / (rt60 * SR))), da = 1 - Math.exp((-TAU * damp) / SR), preN = Math.round(pre * SR);
  const resetAt = new Set(resets.map(idx)), oL = new Float32Array(N), oR = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (resetAt.has(i)) { bufs.forEach((b) => b.fill(0)); lp.fill(0); }
    const j = i - preN, xl = j >= 0 && !resetAt.has(i) ? inL[j] : 0, xr = j >= 0 ? inR[j] : 0;
    let sum = 0;
    for (let k = 0; k < 8; k++) { lp[k] += da * (bufs[k][pos[k]] - lp[k]); y[k] = lp[k] * g[k]; sum += y[k]; }
    const h = sum * 0.25; let l = 0, r = 0;
    for (let k = 0; k < 8; k++) {
      bufs[k][pos[k]] = y[k] - h + (k & 1 ? xr : xl) * (k & 2 ? 0.5 : -0.5);
      pos[k] = pos[k] + 1 === lens[k] ? 0 : pos[k] + 1;
      l += (k & 1 ? -1 : 1) * y[k]; r += (k & 2 ? -1 : 1) * y[k];
    }
    oL[i] = l * 0.3; oR[i] = r * 0.3;
  }
  return [oL, oR];
}
// 硬切点把混响清零：2.4 s（S1→S2）、20.0 s（入轨前的绝对安静）
const CUTS = [2.4, 20.0];
const gateIn = (bus) => { for (const [a, b] of [[20.0, 20.8]]) for (let i = idx(a); i < idx(b); i++) { bus[0][i] = 0; bus[1][i] = 0; } };
[BUS.mus, BUS.sfx, BUS.dry].forEach(gateIn);
const revM = fdn(BUS.mus[0], BUS.mus[1], { rt60: 5.5, resets: CUTS });
const revS = fdn(BUS.sfx[0], BUS.sfx[1], { rt60: 1.6, resets: CUTS, size: 1.2, damp: 3500 });

const mix = [new Float32Array(N), new Float32Array(N)];
const hp = [biquad('hp', 22, 0.707), biquad('hp', 22, 0.707)];
for (let c = 0; c < 2; c++) {
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    let v = (BUS.mus[c][i] + revM[c][i] * 0.42) * 1.7 + (BUS.sfx[c][i] + revS[c][i] * 0.12) * 0.5 + BUS.dry[c][i] * 0.8;   // 音乐 +4.6 dB、音效 −6 dB
    if (t >= 20.0 && t < 20.8) v = 0;                                         // 绝对安静
    if (t >= 59.6) v *= Math.pow(10, (-60 * (t - 59.6)) / 0.4 / 20);         // 60.0 s 前落到 −60 dB（循环接缝）
    mix[c][i] = hp[c](v);
  }
}

// ---- BS.1770 响度
function kw(x) {
  const s = (b, a) => { let x1 = 0, x2 = 0, y1 = 0, y2 = 0; return (v) => { const y = b[0] * v + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2; x2 = x1; x1 = v; y2 = y1; y1 = y; return y; }; };
  const f1 = s([1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]);
  const f2 = s([1, -2, 1], [1, -1.99004745483398, 0.99007225036621]);
  const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = f2(f1(x[i])); return y;
}
function loudness(L, R, t0 = 0, t1 = DUR) {
  const kl = kw(L), kr = kw(R), blk = 0.4 * SR, hop = 0.1 * SR, z = [];
  for (let s = idx(t0); s + blk <= idx(t1); s += hop) { let a = 0; for (let i = s; i < s + blk; i++) a += kl[i] * kl[i] + kr[i] * kr[i]; z.push(a / blk); }
  const lk = (v) => -0.691 + 10 * Math.log10(v + 1e-20);
  const abs = z.filter((v) => lk(v) > -70); if (!abs.length) return -Infinity;
  const rel = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const g = abs.filter((v) => lk(v) > rel);
  return lk(g.reduce((a, b) => a + b, 0) / g.length);
}
// ---- 前瞻式真峰值限幅：4 倍插值估计样本间峰值 → 滑动最小值 → 同长度盒式平滑（保证不过冲）→ 60 ms 释放
function limit(L, R, gain, ceilDb) {
  const ceil = Math.pow(10, ceilDb / 20), Wn = Math.round(0.005 * SR), req = new Float32Array(N);
  const cr = (a, b, c, d, t) => b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
  for (let i = 0; i < N; i++) {
    let pk = 0;
    for (const X of [L, R]) {
      const a = X[Math.max(0, i - 1)] * gain, b = X[i] * gain, c = X[Math.min(N - 1, i + 1)] * gain, d = X[Math.min(N - 1, i + 2)] * gain;
      pk = Math.max(pk, Math.abs(b), Math.abs(cr(a, b, c, d, 0.25)), Math.abs(cr(a, b, c, d, 0.5)), Math.abs(cr(a, b, c, d, 0.75)));
    }
    req[i] = pk > ceil ? ceil / pk : 1;
  }
  const g1 = new Float32Array(N);
  for (let i = 0; i < N; i++) { let m = 1; for (let k = 0; k < Wn && i + k < N; k++) m = Math.min(m, req[i + k]); g1[i] = m; }
  const g2 = new Float32Array(N); let acc = 0;
  for (let i = 0; i < N; i++) { acc += g1[i] - (i >= Wn ? g1[i - Wn] : 1); g2[i] = (acc + Wn) / Wn; }   // 窗口外按 1 计
  const rel = 1 - Math.exp(-1 / (0.06 * SR)), out = [new Float32Array(N), new Float32Array(N)];
  let gp = 1, red = 0;
  for (let i = 0; i < N; i++) {
    const gg = Math.min(g2[i], gp + (1 - gp) * rel); gp = gg; red = Math.max(red, 1 - gg);
    out[0][i] = L[i] * gain * gg; out[1][i] = R[i] * gain * gg;
  }
  return { out, maxRedDb: 20 * Math.log10(1 - red + 1e-9) };
}

const TARGET = -14;
let gain = Math.pow(10, (TARGET - loudness(mix[0], mix[1])) / 20), res;
for (let it = 0; it < 3; it++) {
  res = limit(mix[0], mix[1], gain, -1.2);
  const L = loudness(res.out[0], res.out[1]);
  if (Math.abs(L - TARGET) < 0.05) break;
  gain *= Math.pow(10, (TARGET - L) / 20);
}
const [OL, OR] = res.out;
writeWav('out/score.wav', [OL, OR], SR);

let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(OL[i]), Math.abs(OR[i]));
console.log(`wrote out/score.wav  integrated ${loudness(OL, OR).toFixed(2)} LUFS  sample peak ${(20 * Math.log10(peak)).toFixed(2)} dBFS  limiter max ${res.maxRedDb.toFixed(1)} dB`);
const SHOT_T = [['S1', 0, 2.4], ['S2', 2.4, 6.4], ['S3', 6.4, 9.6], ['S4', 9.6, 12.8], ['S5', 12.8, 16], ['S6', 16, 19.2], ['S7a', 19.2, 20], ['S7b', 20.8, 23.2], ['S8', 23.2, 27.2], ['S9', 27.2, 33.6], ['S10', 33.6, 36.8], ['S11', 36.8, 41.6], ['S12', 41.6, 44.8], ['S13', 44.8, 56], ['S14', 56, 59.6]];
console.log(SHOT_T.map(([n, a, b]) => `${n} ${loudness(OL, OR, a, b).toFixed(1)}`).join('  '));
