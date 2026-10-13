#!/usr/bin/env bash
# 后台落地一个 PR：等 CI 全部结束 → 全部通过才 merge → 同步 main → 本机部署 → 输出结果。
# 用法：scripts/land-pr.sh <PR 编号>
# 设计成在后台运行（Claude Code 里用 run_in_background），前台继续做别的事，完成时会收到通知。
# 注意：它会切到 main 并在当前工作区构建；运行期间不要在同一个工作区切分支或改文件。
set -uo pipefail
PR=$1
# 在调用处所在的仓库里运行（脚本本身可以放在任何地方）
cd "$(git rev-parse --show-toplevel)" || exit 1

# 检查可能还没出现：最多等 2 分钟
for _ in $(seq 1 24); do
  gh pr checks "$PR" >/dev/null 2>&1 && break
  [ -n "$(gh pr checks "$PR" 2>/dev/null)" ] && break
  sleep 5
done
# --watch 会一直等到所有检查结束；有失败时退出码非 0
if ! gh pr checks "$PR" --watch --interval 20 >/dev/null 2>&1; then
  gh pr checks "$PR" || true
  echo "✗ PR #$PR 的 CI 未通过，未合并"
  exit 1
fi
gh pr checks "$PR"
gh pr merge "$PR" --merge --delete-branch >/dev/null || { echo "✗ PR #$PR 合并失败"; exit 1; }
# 在 git worktree（并行开发用的第二个工作区）里只合并：main 已在主工作区检出，部署由主工作区负责
if [ "$(git rev-parse --git-common-dir)" != "$(git rev-parse --git-dir)" ]; then
  echo "✓ PR #$PR 已合并（worktree 中不部署，回到主工作区运行 deploy/deploy-ec2.sh --local）"
  exit 0
fi
git checkout -q main && git pull -q --ff-only
echo "✓ PR #$PR 已合并：$(git log --oneline -1)"
deploy/deploy-ec2.sh --local 2>&1 | grep -E "本机构建|✓ 服务|✗"
