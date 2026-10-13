#!/usr/bin/env bash
# 本机完整检查：类型检查 → 单元测试 → 构建 → 端到端测试（都在有内存上限的 cgroup 里运行）。
# 与 CI 相同的步骤，迭代时不用等 push；CI 仍作为干净环境的最终把关。
set -euo pipefail
cd "$(dirname "$0")/.."
CAP=${ATOMS_CHECK_MEM:-2000M}
run() { echo "▶ $*"; scripts/capped.sh "$CAP" -- "$@"; }
run npm run typecheck
run npm run test:unit
run env NEXT_TELEMETRY_DISABLED=1 npm run build
run env CI= npx playwright test --reporter=line "$@"
