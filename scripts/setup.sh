#!/usr/bin/env bash
# 云端 / 本地通用的环境准备：Node 依赖 + Playwright Chromium + ffmpeg
set -euo pipefail
cd "$(dirname "$0")/.."

# 锁定 Playwright 版本：1.56.1 对应 Chromium build 1194（云端容器已预装在 $PLAYWRIGHT_BROWSERS_PATH）
PW_VERSION=1.56.1

[ -f package.json ] || npm init -y >/dev/null
npm i -D -E "playwright@${PW_VERSION}"

# 浏览器已存在就不再下载（云端预装 / 本地已装过）
if node -e "const fs=require('fs');const p=require('playwright').chromium.executablePath();process.exit(fs.existsSync(p)?0:1)"; then
  echo "chromium already installed: $(node -e "console.log(require('playwright').chromium.executablePath())")"
else
  npx playwright install --with-deps chromium || npx playwright install chromium
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    (sudo apt-get update && sudo apt-get install -y ffmpeg) || apt-get install -y ffmpeg
  elif command -v brew >/dev/null 2>&1; then
    brew install ffmpeg
  else
    echo "ffmpeg 未安装且无 apt-get / brew，请手动安装" >&2
    exit 1
  fi
fi

node -v
ffmpeg -version | head -1
echo "setup ok"
