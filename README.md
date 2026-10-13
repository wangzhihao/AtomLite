# AtomLite

This repo implements the design described in the [AtomLite design doc](https://claude.ai/artifact/3P5Q53KdYVJgWu9Qq3cDSQ).

Atoms Lite（迷你 Atoms）：用一句话需求驱动 AI Agent 生成 Web 应用，实时预览，多轮迭代。

## 当前进度：Must 范围已完成

| Must 能力（设计文档第 2 节） | 实现 | 端到端验收（`e2e/must.spec.ts`） |
| --- | --- | --- |
| 账号体系：邮箱登录 + 游客模式 | 首页一句话直接以游客身份开始；邮箱注册 / 登录 / 退出；游客可绑定邮箱，数据保留 | 游客流程、邮箱注册登录、错误密码、重复注册、游客绑定后换会话找回 |
| 项目管理：创建、列表、重命名、删除 | `/projects` 卡片网格；工作区顶栏也可重命名 | 创建 → 列表 → 两处重命名 → 刷新仍在 → 删除 |
| 对话驱动生成 + 流式输出 | `POST /api/projects/:id/generate` SSE；Agent 文字逐字显示、文件写入进度、可随时停止 | 时间线与文件进度可见；停止后不产生新版本，可继续下一轮 |
| 沙箱实时预览（桌面 / 手机宽度） | srcdoc + sandbox（无 allow-same-origin）；自托管 React / Babel / Tailwind；文件写完后防抖 500ms 刷新；错误桥接 + 存储垫片 | 应用可交互、沙箱隔离、手机宽度 375px、运行时报错条 + 一键修复 |
| 持久化：对话、代码、版本 | 每轮成功生成写入一个不可变版本；对话、run 用量一起落库 | 刷新后对话 / 版本 / 代码 / 应用数据完整；换浏览器会话登录仍在 |
| 多轮迭代修改 | 修改轮次只输出变更文件，与当前版本合并为新版本；历史版本可预览 | v1 → v2（改色）→ v3（只改 1 个文件），旧版本预览、刷新后保留 |

此外还顺手做了几项低成本的配套：输入限制（4000 字 / 200 KB）、限流（登录用户每小时 20 次、游客每天 10 次）、同一项目同时只允许一个 run、15 秒 SSE 心跳、每条 Agent 消息下的 token / 成本标签、预览错误条与“让 Agent 修复”、代码查看标签。

Should / Could 项（多 Agent 流水线、自动自愈回路、回滚、发布与 Remix、建议者等）尚未实现。

## 快速开始

```bash
npm install          # postinstall 会把预览用的白名单库复制到 public/vendor/
npm run dev          # http://localhost:3000
```

不配置任何环境变量也能完整跑通：数据存在本地 `.data/`，LLM 使用确定性的 **Mock**（生成一个可交互的清单应用，修改轮次识别颜色关键词）。配置 `ANTHROPIC_API_KEY` 后切换为真实的 Claude。

### 环境变量（见 `.env.example`）

| 变量 | 作用 |
| --- | --- |
| `ANTHROPIC_API_KEY` | 配置后使用 Claude 作为 Engineer；留空使用 Mock |
| `ATOMS_STRONG_MODEL` | 默认 `claude-opus-5-5` |
| `ATOMS_EFFORT` | `low` / `medium` / `high` …，默认 `medium` |
| `ATOMS_PRICE_IN` / `ATOMS_PRICE_OUT` / `ATOMS_PRICE_CACHE_READ` | 每百万 token 美元单价，用于成本统计 |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 配置后使用 Supabase Auth + Postgres + RLS；留空使用本地文件存储 |
| `AUTH_SECRET` / `ATOMS_DATA_DIR` | 仅本地模式：会话签名密钥、数据目录 |

### 上线（Vercel + Supabase）

1. 在 Supabase SQL Editor 执行 `supabase/migrations/0001_init.sql`，并在 Authentication → Providers 中开启 **Anonymous sign-ins** 和 Email。
2. Vercel 导入本仓库，配置上面的环境变量（线上必须配置 Supabase，本地文件存储在 Serverless 环境中不可持久化）。
3. 生成接口设置了 `maxDuration = 300`，请确认 Vercel 套餐允许的函数最长执行时长。

### 部署到自己的服务器（EC2）

本机只运行、不构建：CI 产出 Next.js standalone 产物（`atomlite-standalone` artifact），`deploy/deploy-ec2.sh` 下载后解压到 `/home/ubuntu/atomlite/releases/<sha>`，切换 `current` 软链并重启 systemd 服务，健康检查失败会自动回滚。

```bash
sudo cp deploy/atomlite.service /etc/systemd/system/   # 首次：安装服务（端口等配置在 /home/ubuntu/atomlite/atomlite.env）
deploy/deploy-ec2.sh            # 部署当前分支最近一次成功的 CI；也可传入 run id
sudo journalctl -u atomlite -f  # 查看日志
```

服务器上使用本地文件存储（`/home/ubuntu/atomlite/data`），服务内存上限 600 MB。

## 测试

```bash
npm run typecheck
npm run test:unit    # 标签解析器（任意分块一致性）、预览组装器、SSE 解析
npm run build && npm run test:e2e   # Playwright，自动以 Mock LLM + 本地存储启动 next start
```

CI（`.github/workflows/ci.yml`）在每次推送时跑完上述全部步骤，并上传截图（`screens/`）和 Playwright 报告。

## 架构速览

```
src/
  app/                      页面（/、/login、/projects、/projects/[id]）与 API 路由
    api/projects/[id]/generate   SSE 生成接口
  components/Preview.tsx    沙箱预览：srcdoc、消息校验、存储垫片持久化
  lib/shared/               前后端共用的纯函数：标签协议解析器、预览组装器、SSE、类型
  lib/server/
    orchestrator.ts         代码编排器：判定新建 / 修改 / 修复路径 → Engineer → 校验 → 落库
    llm.ts / mock-llm.ts    Claude（Anthropic SDK，prompt caching）/ 确定性 Mock
    prompts.ts              Engineer 系统提示（稳定前缀）与上下文组装
    store.ts                数据访问层：Supabase（RLS）与本地文件两种实现
    auth.ts                 Supabase Auth 或本地签名 Cookie
supabase/migrations/        建表与 RLS
```

## 与设计文档的差异

- **LLM 接入用官方 Anthropic SDK，而非 Vercel AI SDK。** 直接拿到 `cache_read_input_tokens` 等用量字段，便于第 10 节的成本统计；流式接口一样简单。未保留 OpenAI 兼容端点。
- **普通 CRUD 也走服务端 API 路由**（文档允许前端直连 Supabase）。这样本地存储与 Supabase 两种模式共用同一套前端代码，也便于在没有 Supabase 的 CI 中做端到端测试；Supabase 模式下服务端以用户身份访问，RLS 依旧生效。
- **UI 只用 Tailwind**，未引入 shadcn/ui 组件库。
- **代码查看用纯文本 `<pre>`**，未接 Shiki 高亮（Could 项）。
- **本地文件存储 + Mock LLM** 是额外增加的开发 / 测试模式，不影响线上架构。
