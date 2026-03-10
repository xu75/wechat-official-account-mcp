# Wechat Publisher Agent（Phase B）联调指南

> 先读总览：[`docs/CURRENT_IMPLEMENTATION.md`](./CURRENT_IMPLEMENTATION.md)  
> 本文聚焦 Phase B 联调细节与命令，不重复解释双轨架构背景。

本文档用于 ECS 与本地 Mac `wechat-publisher-agent` 联调，目标是跑通：

1. 配置初始化
2. 发布前校验
3. 官方通道发布（assist）
4. 浏览器通道发布（个人号/无官方发布权限场景）

## 1. 启动本地 Agent

```bash
npm run agent:start
```

> 生产建议通过 FRP 暴露 `remote:14273 -> 127.0.0.1:4273`。

## 2. 环境变量

- `WECHAT_AGENT_SIGNING_SECRET`: ECS 与 Agent 共享的 HMAC 密钥（必需）
- `WECHAT_AGENT_REQUIRE_REVIEW_TOKEN`: 是否强制校验审核令牌（默认 `true`）
- `WECHAT_AGENT_REVIEW_TOKEN_SECRET`: 审核令牌密钥（为空时回退到 `WECHAT_AGENT_SIGNING_SECRET`）
- `WECHAT_AGENT_REVIEW_TOKEN_ISSUER`: 审核令牌发行方（默认 `ecs-review`）
- `WECHAT_AGENT_REVIEW_TOKEN_TTL_SECONDS`: 审核令牌有效期（默认 `600` 秒）
- `WECHAT_AGENT_ENABLE_BROWSER_FALLBACK`: `true/false`，Phase B 可先保持 `false`
- `WECHAT_AGENT_LOG_FILE`: 本地日志文件（默认 `/tmp/wechat-agent.log`）
- `WECHAT_AGENT_BROWSER_PUBLISH_MODE`: `manual` 或 `command`
- `WECHAT_AGENT_BROWSER_PUBLISH_CMD`: 当模式是 `command` 时执行的发布命令
- `WECHAT_AGENT_MANUAL_TASK_DIR`: manual 模式下任务文件输出目录

推荐做法：复制 `.env.agent.example` 为本地 `.env.agent`，后续命令会自动读取，不需要每次手输。

```bash
cp .env.agent.example .env.agent
```

## 3. 通用签名请求脚本

脚本路径：`scripts/agent-request.mjs`

```bash
npm run agent:req -- GET /health
```

```bash
npm run agent:req -- POST /agent/config-check scripts/agent-templates/config-check.json
```

也可使用快捷命令：

```bash
npm run agent:health
npm run agent:config:init
npm run agent:config:check
npm run agent:config:check:browser
npm run agent:publish:official
npm run agent:publish:browser
npm run agent:e2e:browser
npm run agent:e2e:official
npm run agent:review:token -- scripts/agent-templates/publish-browser.json --write --timestamp-title
```

## 4. 配置初始化（POST /agent/config/init）

样例文件：`scripts/agent-templates/config-init.json`

```bash
npm run agent:req -- POST /agent/config/init scripts/agent-templates/config-init.json
```

成功后会将公众号配置写入本地存储（SQLite）。

## 5. 发布前校验（POST /agent/config-check）

样例文件：`scripts/agent-templates/config-check.json`

```bash
npm run agent:req -- POST /agent/config-check scripts/agent-templates/config-check.json
```

返回包含：

- `configured`: 本地是否已配置 `app_id/app_secret`
- `token_check`: Token 可用性检查结果
- `publish_check`: 发布参数是否满足 assist/official 要求

## 6. 官方发布（POST /publish）

样例文件：`scripts/agent-templates/publish-official.json`

```bash
npm run agent:req -- POST /publish scripts/agent-templates/publish-official.json
```

注意：

1. `review_approved` 必须为 `true`
2. 官方通道必须提供 `thumb_media_id`
3. 同一 `idempotency_key` 重复调用会返回历史结果（`dedup_hit: true`）

## 7. 浏览器发布（POST /publish, preferred_channel=browser）

样例文件：`scripts/agent-templates/publish-browser.json`

```bash
npm run agent:config:check:browser
npm run agent:publish:browser
```

`manual` 模式行为：

1. Agent 会在 `WECHAT_AGENT_MANUAL_TASK_DIR` 下生成任务目录
2. 返回 `publish_failed` + `error_code=BROWSER_MANUAL_REQUIRED`
3. 任务目录包含 `publish-task.json`、`article-content.html`、`README.txt`
4. 人工在公众号后台发布后，再通过业务回调流程更新 ECS 状态

`command` 模式行为：

1. Agent 执行 `WECHAT_AGENT_BROWSER_PUBLISH_CMD <payload-json-path>`
2. 命令需输出 JSON，最少包含 `ok` 字段（`true/false`）
3. `ok=true` 时 Agent 返回 `accepted(channel=browser)`，可带 `publish_url`

仓库内提供了真实自动发布命令（Playwright）：

`scripts/browser-publisher/playwright-wechat-publish.mjs`

前置：

1. `npm install -D playwright`
2. `WECHAT_AGENT_BROWSER_PUBLISH_CMD` 指向上面的脚本
3. 首次会打开公众号后台，扫码登录；登录态保存在 `WECHAT_BROWSER_USER_DATA_DIR`

建议先设置：

1. `WECHAT_BROWSER_SUBMIT_MODE=draft`
2. `WECHAT_BROWSER_HEADLESS=false`

确认稳定后再切到 `WECHAT_BROWSER_SUBMIT_MODE=publish`。

仓库也保留了 mock 命令：

`scripts/browser-publisher/mock-success.mjs`

用于打通链路（不真实发文），便于回归测试。

## 8. 审核令牌（新增）

`/publish` 现在会校验 `review_approval_token` 与请求内容哈希一致（默认强制开启）。

本地生成测试 token：

```bash
npm run agent:review:token -- scripts/agent-templates/publish-browser.json --write --timestamp-title
```

然后再执行：

```bash
npm run agent:publish:browser
```

## 9. 关键接口汇总

- `GET /health`
- `POST /agent/config/init`
- `POST /agent/config-check`
- `POST /publish`
- `POST /callback`
