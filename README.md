# AtomLite

This repo implements the design described in the [AtomLite design doc](https://claude.ai/artifact/3P5Q53KdYVJgWu9Qq3cDSQ#0ed7ef0a-5fed) (public).

Atoms Lite（迷你 Atoms）：用一句话需求驱动 AI Agent 团队生成 Web 应用，实时预览，多轮迭代、回滚和发布。运行在自有的 EC2 服务器上：一个常驻的 Next.js 进程，账号和数据存在本机，生成的应用只在浏览器沙箱里运行。

设计文档是唯一的规格来源，本 README 与它保持一致；每项能力的完成状态见设计文档第 2 节的“状态”列和第 11 节的任务清单。

## 进度

| 范围（设计文档第 2 节） | 状态 | 端到端验收 |
| --- | --- | --- |
| Must：账号（邮箱 + 游客）、项目管理、对话驱动生成 + 流式输出、沙箱预览（桌面 / 手机）、持久化、多轮迭代 | 全部完成 | `e2e/must.spec.ts` |
| Should：多 Agent 流水线、运行时错误自愈、版本回滚、质量与成本度量、角色注册表 + 设计师、建议者、需求澄清、一键发布 | 全部完成 | `e2e/should.spec.ts` |
| Could：验收 QA Agent、团队配置面板、代码查看与 zip 下载、Discover 广场 + Remix | 完成 | `e2e/could.spec.ts` |
| Could：附件（图片 / PDF / 文本给团队看，图片可直接用进应用） | 完成 | `e2e/attachments.spec.ts` |
| Could：App Cloud | 未开始 | — |

尚未完成的交付项（设计文档第 11 节）：Caddy + 自定义域名启用 HTTPS 并在国内网络实测、个人博客用例验收、20 条评测需求、预置演示项目、数据目录每日备份与磁盘告警。

## 快速开始

```bash
npm install          # postinstall 会把预览用的白名单库（React、ReactDOM、Babel、Tailwind）复制到 public/vendor/
npm run dev          # http://localhost:3000
```

不配置任何环境变量也能完整跑通：数据存在 `.data/db.json`，LLM 使用确定性的 **Mock**（每个角色都有固定输出：生成一个可交互的清单应用，修改轮次识别颜色关键词），端到端测试也用它。配置 `ANTHROPIC_API_KEY` 后切换为真实的 Claude。

### 环境变量（见 `.env.example`）

| 变量 | 作用 |
| --- | --- |
| `ANTHROPIC_API_KEY` | 配置后使用 Claude；留空使用 Mock LLM |
| `ATOMS_STRONG_MODEL` | Engineer / Fixer / QA 使用，默认 `claude-opus-5-5` |
| `ATOMS_FAST_MODEL` | Planner / Designer / Advisor 使用，默认 `claude-haiku-5-5` |
| `ATOMS_EFFORT` | 强模型的 effort：`low` / `medium` / `high` …，默认 `medium` |
| `ATOMS_PRICE_IN` / `ATOMS_PRICE_OUT` / `ATOMS_PRICE_CACHE_READ` | 强模型每百万 token 美元单价，用于成本统计 |
| `ATOMS_FAST_PRICE_IN` / `ATOMS_FAST_PRICE_OUT` / `ATOMS_FAST_PRICE_CACHE_READ` | 快速模型单价 |
| `AUTH_SECRET` | 会话 Cookie 的签名密钥 |
| `ATOMS_DATA_DIR` | 数据目录，默认 `.data` |
| `ATOMS_INSECURE_COOKIE` | 设为 `1` 时会话 Cookie 不加 Secure（尚未启用 HTTPS 时需要） |
| `ATOMS_SUPPORT_EMAIL` | 模型额度用完时提示用户联系充值的邮箱，默认 `accept.acm@gmail.com` |
| `ATOMS_AGENT_<ID>` | 设为 `0` 全局关闭某个可选角色（`PLANNER`、`DESIGNER`、`ADVISOR`、`QA`） |

## 部署（EC2）

`deploy/deploy-ec2.sh` 把 Next.js standalone 产物放到 `/home/ubuntu/atomlite/releases/<sha>`，切换 `current` 软链并重启 systemd 服务，健康检查失败自动回滚到上一版。产物可以在本机构建，也可以用 CI 构建好的 `atomlite-standalone` artifact。

```bash
sudo cp deploy/atomlite.service /etc/systemd/system/   # 首次：安装服务
deploy/deploy-ec2.sh --local    # 本机构建并部署（最快）
deploy/deploy-ec2.sh            # 或：部署当前分支最近一次成功的 CI（也可传入 run id）
sudo journalctl -u atomlite -f  # 查看日志
```

- 配置在 `/home/ubuntu/atomlite/atomlite.env`（权限 600），数据在 `/home/ubuntu/atomlite/data`。
- 服务内存上限 600 MB；本机的构建和测试通过 `scripts/capped.sh` 放进有内存上限的 cgroup，超限只会杀掉自己，不影响同机其他服务。
- 目前通过 `http://<服务器 IP>:3001` 访问；启用 HTTPS（Caddy + 自定义域名）后去掉 `ATOMS_INSECURE_COOKIE`，反向代理需对 SSE 关闭缓冲、读超时不少于 5 分钟。

## 测试

```bash
npm run typecheck
npm run test:unit    # 标签解析器（任意分块一致性）、预览组装器、SSE、zip、指标公式
npm run build && npm run test:e2e   # Playwright，自动以 Mock LLM + 独立数据目录启动 next start
scripts/check-local.sh              # 以上全部，在内存受限的 cgroup 里按 CI 的顺序跑一遍
```

CI（`.github/workflows/ci.yml`）在每次推送时跑完上述全部步骤，上传截图（`screens/`）、Playwright 报告和 standalone 产物。

## 代码结构

```
src/
  app/                        页面（/、/login、/projects、/projects/[id]、/s/[slug]、/discover、/stats）与 API 路由
    api/projects/[id]/generate     SSE 生成接口
  components/
    Preview.tsx               沙箱预览：srcdoc、消息校验、存储垫片持久化
    workspace/                时间线、代码 / 版本 / 发布面板、团队配置、QA 执行器
  lib/shared/                 前后端共用的纯函数：标签协议解析器、预览组装器、SSE、zip、指标公式、类型
  lib/server/
    orchestrator.ts           代码编排器：新建 / 修改 / 修复三条路径、修复回路、预算、建议
    agents.ts                 Agent 角色注册表
    prompts.ts                各角色系统提示（稳定前缀）与上下文组装
    check.ts                  服务端语法检查
    qa.ts                     验收测试生成
    llm.ts / mock-llm.ts      Claude（Anthropic SDK，快速 / 强两档，prompt caching）/ 确定性 Mock
    auth.ts                   游客与邮箱登录：HMAC 签名的 httpOnly Cookie、scrypt 密码哈希
    store.ts / local-db.ts    数据访问层（每次读写检查归属）与本机数据存储
    public-store.ts           发布页、Remix、广场的只读访问
    uploads.ts                附件存储（按内容识别类型、归属校验、发给模型的内容）
deploy/                       systemd 服务与部署脚本
scripts/                      vendor 复制、内存受限运行、本机完整检查
```
