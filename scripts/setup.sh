#!/usr/bin/env bash
# 云端 / 本地通用的环境准备：Node 依赖 + Playwright Chromium + ffmpeg
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f package.json ] || npm init -y >/dev/null
npm i -D playwright
npx playwright install --with-deps chromium || npx playwright install chromium

if ! command -v ffmpeg >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    (sudo apt-get update && sudo apt-get install -y ffmpeg) || apt-get install -y ffmpeg
  else
    echo "ffmpeg 未安装且无 apt-get，请手动安装" >&2
    exit 1
  fi
fi

node -v
ffmpeg -version | head -1
echo "setup ok"
