# 不回头 · Starship Flight 14

一部 60 秒、画面和声音全部由代码生成的短片：2026-09-28 星舰第 14 次试飞首次入轨——然后，有一艘没有回头，一路飞进了《星际穿越》。

- 成片：`out/final.mp4`（1920×1080，60 fps，H.264 + AAC，−14 LUFS）
- 封面：`out/poster.png`（49.6 s，星舰剪影横穿卡冈图雅的透镜光弧）
- 总览：`out/contact.png`（每秒 2 帧，12×10，每行 6 秒）
- 分镜与风格：[`docs/shotlist.md`](docs/shotlist.md)、[`docs/style_guide.md`](docs/style_guide.md)

## 目录

| 路径 | 作用 |
|---|---|
| `index.html` | 整部片子：一个 canvas，`window.seek(t)` 无状态地画出任意时刻的一帧 |
| `audio/score.mjs` | 配乐与音效合成器（管风琴、弦乐、钟琴、全部音效、混响、响度与限幅），输出 `out/score.wav` |
| `render.mjs` | 逐帧渲染：无头 Chromium 调 `seek(t)` → PNG → ffmpeg；按 2 秒分段编码，可只重渲某几秒 |
| `scripts/setup.sh` | 安装依赖（Playwright 1.56.1 + Chromium、ffmpeg） |
| `scripts/fonts.py` | 把屏幕文字用到的字符子集化成 woff2 并内嵌进 `index.html` |
| `scripts/stills.mjs` | 按时刻抽帧检查，拼一张总览图 |
| `fonts/` | 思源宋体（Noto Serif SC）400/600、IBM Plex Mono 的子集，附 OFL 许可证 |
| `tests/` | 管线测试：逐帧条码、音画同步、响度校验 |

## 1. 准备环境

```bash
bash scripts/setup.sh          # Node ≥ 18、Playwright Chromium、ffmpeg
```

## 2. 实时预览

用 Chrome 直接打开 `index.html`，自动循环播放。

- 先运行一次 `node audio/score.mjs` 生成 `out/score.wav`，然后**点一下页面**就会带声播放（画面跟着音轨走）
- 空格：暂停 / 继续；← / →：前后一拍（0.8 s）
- `index.html?t=49.6`：定格在某一时刻；`?w=960&h=540`：改渲染分辨率

## 3. 重新渲染

```bash
node audio/score.mjs                                   # 合成音轨 → out/score.wav（约 1 分钟）
node render.mjs --preset animatic                      # 960×540 30fps 预览 → out/animatic.mp4
node render.mjs --preset final --audio out/score.wav --maxrate 12M --out out/final.mp4
```

- 画面按 2 秒一段编码成 CRF 16 的母版分段（`out/segs/`）；拼接时 `--maxrate 12M` 按 CRF 16 + 12 Mbps 上限重编码，
  保证成片 < 100 MB（GitHub 单文件上限），也更适合抖音 / X 上传。不加 `--maxrate` 则无损拷贝母版分段。
- **只重渲改过的几秒**：`--ranges 16-19.2,44.8-51.2`（自动换算成受影响的分段，再重新拼接）
- 断点续渲：`--skip-existing`（跳过比 `index.html` 新的分段）
- 并行：`--workers 4`；参考耗时（云端 4 核、软件 WebGL）：animatic 约 14 分钟，1080p60 成片约 75 分钟

## 4. 封面与总览

```bash
node scripts/stills.mjs --w 1920 --h 1080 49.6 && cp out/stills/000.png out/poster.png
ffmpeg -i out/final.mp4 -vf "fps=2,scale=270:-1,tile=12x10" -frames:v 1 out/contact.png
```

## 5. 改屏幕文字

文字都在 `index.html` 的 `/*TEXT:BEGIN*/ … /*TEXT:END*/` 里。改完运行 `python3 scripts/fonts.py`（需要 `pip install fonttools brotli`），
它会重新子集化字体并内嵌进页面，保证云端和本地渲染一模一样。

## 6. 管线自检

```bash
node tests/tone.mjs && node render.mjs --page tests/pipeline.html --preset test --audio out/test-tone.wav --out out/test.mp4
node tests/verify.mjs out/test.mp4        # 逐帧条码（无丢帧/重帧）、音画偏差、响度
```

## 技术要点

- **无状态渲染**：`seek(t)` 只依赖 t；随机数全部用 `mulberry32` 种子；运动用闭式弹簧和「弹簧跟随」卷积，任意跳帧结果一致。
- **画面**：2D canvas 画前景（飞行器、火焰、云、文字）+ WebGL2「太空着色器」画背景（地球、月球、土星与虫洞、隧道、卡冈图雅），
  再过一层统一的后期（泛光、热浪、色差、暗角、颗粒兼抖动）。
- **卡冈图雅**：史瓦西度规下的光子轨道 u'' + u = 3u²，每帧按相机距离预积分一张「偏折表」，着色器查表求光线与吸积盘的每一次相交，
  得到真实的引力透镜光弧、光子环和背景星的扭曲。
- **声音**：六声部和弦 = 飞船六台发动机，17.2 s 一台 RVac 熄火时和弦掉三音，57.6 s 以大三度回来；26 个钟琴音 = 26 颗卫星；
  53.6 s 起渐慢，与画面上尾焰闪烁变慢同步。BS.1770 响度测量 + 4 倍插值的前瞻式真峰值限幅。
- **首尾闭环**：片尾卡冈图雅的光子环与开场 33 台发动机的外环同心同径（`RING_PX`），平台循环播放时首尾咬合。

## 事实与版权

- 前半段按 2026-09-28 星舰第 14 次试飞的公开事实：12:48 UTC 从星舰基地 Pad B 发射（当地 07:48，朝阳在东）；助推器海上降落（片中不出现发射塔筷子）；
  上升段一台真空猛禽提前关机；S41 入轨后释放 26 颗 Starlink V3；约 3 小时后离轨、再入、北太平洋溅落。后半段是虚构的致敬。
- 未使用《星际穿越》任何画面、声音或海报；配乐旋律原创；只引用一句台词（「不要温和地走进那个良夜」，10 字）。
- 字体：Noto Serif SC、IBM Plex Mono，均为 SIL Open Font License 1.1（见 `fonts/OFL-*.txt`）。
