#!/usr/bin/env bash
# 把 CI 构建好的 standalone 产物部署到本机（不在本机构建，避免占用内存）。
# 用法：deploy/deploy-ec2.sh [CI run id]   不传则取当前分支最近一次成功的 CI。
# 前置：gh 已登录；/etc/systemd/system/atomlite.service 已安装（见 deploy/atomlite.service）；
#       /home/ubuntu/atomlite/atomlite.env 已配置（见 .env.example）。
set -euo pipefail

ROOT=/home/ubuntu/atomlite
REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"
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

PREV=$(readlink -f "$ROOT/current" 2>/dev/null || true)
ln -sfn "$REL" "$ROOT/current"
sudo systemctl daemon-reload
sudo systemctl enable atomlite >/dev/null 2>&1 || true
sudo systemctl restart atomlite

PORT=$(grep -E '^PORT=' "$ROOT/atomlite.env" | cut -d= -f2)
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT:-3001}/"; then
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
