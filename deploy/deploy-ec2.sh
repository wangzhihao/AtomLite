#!/usr/bin/env bash
# 部署到本机 systemd 服务（atomlite.service）。两种来源：
#   deploy/deploy-ec2.sh --local       在本机构建（内存受限的 cgroup 中）并部署，迭代最快
#   deploy/deploy-ec2.sh [CI run id]   下载 CI 构建好的 standalone 产物；不传则取当前分支最近一次成功的 CI
# 前置：/etc/systemd/system/atomlite.service 已安装（见 deploy/atomlite.service）；
#       /home/ubuntu/atomlite/atomlite.env 已配置（见 .env.example）；CI 模式需要 gh 已登录。
set -euo pipefail

ROOT=/home/ubuntu/atomlite
REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"

if [ "${1:-}" = "--local" ]; then
  SHA=$(git rev-parse HEAD)
  TAG="${SHA:0:12}$(git diff --quiet HEAD -- . ':!e2e' ':!tests' || echo -dirty)"
  REL="$ROOT/releases/$TAG"
  echo "本机构建并部署 $TAG → $REL"
  scripts/capped.sh "${ATOMS_BUILD_MEM:-1600M}" -- env NEXT_TELEMETRY_DISABLED=1 npm run build
  rm -rf "$REL" && mkdir -p "$REL"
  cp -r .next/standalone/. "$REL/"
  cp -r public "$REL/public"
  mkdir -p "$REL/.next" && cp -r .next/static "$REL/.next/static"
  rm -rf "$REL/.data" "$REL/.data-e2e"
else
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  RUN_ID=${1:-$(gh run list --branch "$BRANCH" --workflow CI --status success --limit 1 --json databaseId -q '.[0].databaseId')}
  [ -n "$RUN_ID" ] || { echo "没有找到成功的 CI run"; exit 1; }
  SHA=$(gh run view "$RUN_ID" --json headSha -q .headSha)
  REL="$ROOT/releases/${SHA:0:12}"
  echo "部署 CI run $RUN_ID（${SHA:0:12}）→ $REL"
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  gh run download "$RUN_ID" -n atomlite-standalone -D "$TMP"
  rm -rf "$REL" && mkdir -p "$REL"
  tar -xzf "$TMP/atomlite-standalone.tgz" -C "$REL"
fi

PREV=$(readlink -f "$ROOT/current" 2>/dev/null || true)
ln -sfn "$REL" "$ROOT/current"
sudo systemctl daemon-reload
sudo systemctl enable atomlite >/dev/null 2>&1 || true
sudo systemctl restart atomlite

PORT=$(grep -E '^PORT=' "$ROOT/atomlite.env" | cut -d= -f2)
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT:-3001}/" 2>/dev/null; then
    echo "✓ 服务已启动：http://127.0.0.1:${PORT:-3001}/"
    # 只保留最近 3 个版本
    ls -1dt "$ROOT"/releases/*/ | tail -n +4 | xargs -r rm -rf
    exit 0
  fi
  sleep 1
done

echo "✗ 健康检查失败，回滚"
sudo journalctl -u atomlite -n 30 --no-pager || true
if [ -n "$PREV" ] && [ "$PREV" != "$REL" ]; then
  ln -sfn "$PREV" "$ROOT/current"
  sudo systemctl restart atomlite
fi
exit 1
