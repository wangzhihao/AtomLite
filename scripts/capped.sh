#!/usr/bin/env bash
# 在有内存上限的 cgroup 里运行命令：这台机器上还跑着其他服务，构建 / 测试超限时只杀自己，不殃及别人。
# 用法：scripts/capped.sh [MemoryMax，默认 1400M] -- 命令...
set -euo pipefail
MAX=1400M
if [ "${1:-}" != "--" ]; then MAX=$1; shift; fi
[ "${1:-}" = "--" ] && shift
exec sudo systemd-run --quiet --scope -p MemoryMax="$MAX" -p MemorySwapMax=0 \
  --uid="$(id -u)" --gid="$(id -g)" --setenv=HOME="$HOME" --setenv=PATH="$PATH" --working-directory="$PWD" -- "$@"
