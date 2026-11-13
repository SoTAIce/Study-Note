#!/usr/bin/env bash
# 标准启动 / 验证路径：每个会话开工前先跑它，基线不绿就先修基线。
#   ./init.sh                 安装依赖 + 类型检查 + 单元测试 + 构建 + E2E
#   SKIP_E2E=1 ./init.sh      跳过浏览器端到端测试（没装 Playwright 的机器）
#   RUN_START_COMMAND=1 ./init.sh   验证通过后直接启动应用
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
echo "==> 工作目录：$PWD"

# —— Node ≥ 24（运行 .ts 源码与 node --test --test-isolation 都需要）——
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 24 ] && [ -x /opt/node24/bin/node ]; then
  export PATH="/opt/node24/bin:$PATH"   # 云端容器里自带 Node 24，默认的是 22
fi
if [ "$(node_major)" -lt 24 ]; then
  echo "✖ 需要 Node 24 或更高版本，当前是 $(node -v 2>/dev/null || echo '未安装')。" >&2
  echo "  怎么修：安装 Node 24（https://nodejs.org/），或 nvm install 24 && nvm use 24" >&2
  exit 1
fi
echo "==> Node $(node -v)"

# —— 依赖 ——
if command -v pnpm >/dev/null 2>&1; then
  echo "==> 安装依赖（pnpm，按锁文件）"
  pnpm install --frozen-lockfile --silent
  RUN=(pnpm)
else
  echo "==> 没有 pnpm，用 npm 安装依赖"
  npm install --no-audit --no-fund --silent
  RUN=(npm run)
fi

echo "==> 类型检查"
"${RUN[@]}" typecheck
echo "==> 单元 / 接口测试"
"${RUN[@]}" test
echo "==> 构建前端"
"${RUN[@]}" build

if [ "${SKIP_E2E:-0}" = "1" ]; then
  echo "==> 跳过 E2E（SKIP_E2E=1）——这次验证不完整，请在进度日志里写明"
else
  echo "==> 端到端冒烟测试"
  "${RUN[@]}" e2e
fi

echo "==> 基线验证全部通过"
echo "    启动应用：pnpm start   （http://127.0.0.1:7777）"
if [ "${RUN_START_COMMAND:-0}" = "1" ]; then
  exec "${RUN[@]}" start
fi
