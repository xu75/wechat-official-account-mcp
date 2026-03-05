# Wechat Publisher Agent（Phase B）联调指南

本文档用于 ECS 与本地 Mac `wechat-publisher-agent` 联调，目标是跑通：

1. 配置初始化
2. 发布前校验
3. 官方通道发布（assist）

## 1. 启动本地 Agent

```bash
PORT=4273 node dist/api/server.js
```

> 生产建议通过 FRP 暴露 `remote:13001 -> 127.0.0.1:4273`。

## 2. 环境变量

- `WECHAT_AGENT_SIGNING_SECRET`: ECS 与 Agent 共享的 HMAC 密钥（必需）
- `WECHAT_AGENT_ENABLE_BROWSER_FALLBACK`: `true/false`，Phase B 可先保持 `false`
- `WECHAT_AGENT_LOG_FILE`: 本地日志文件（默认 `/tmp/wechat-agent.log`）

## 3. 通用签名请求脚本

脚本路径：`scripts/agent-request.mjs`

```bash
AGENT_BASE_URL=http://127.0.0.1:4273 \
WECHAT_AGENT_SIGNING_SECRET='replace-with-secret' \
npm run agent:req -- GET /health
```

```bash
AGENT_BASE_URL=http://127.0.0.1:4273 \
WECHAT_AGENT_SIGNING_SECRET='replace-with-secret' \
npm run agent:req -- POST /agent/config-check scripts/agent-templates/config-check.json
```

## 4. 配置初始化（POST /agent/config/init）

样例文件：`scripts/agent-templates/config-init.json`

```bash
AGENT_BASE_URL=http://127.0.0.1:4273 \
WECHAT_AGENT_SIGNING_SECRET='replace-with-secret' \
npm run agent:req -- POST /agent/config/init scripts/agent-templates/config-init.json
```

成功后会将公众号配置写入本地存储（SQLite）。

## 5. 发布前校验（POST /agent/config-check）

样例文件：`scripts/agent-templates/config-check.json`

```bash
AGENT_BASE_URL=http://127.0.0.1:4273 \
WECHAT_AGENT_SIGNING_SECRET='replace-with-secret' \
npm run agent:req -- POST /agent/config-check scripts/agent-templates/config-check.json
```

返回包含：

- `configured`: 本地是否已配置 `app_id/app_secret`
- `token_check`: Token 可用性检查结果
- `publish_check`: 发布参数是否满足 assist/official 要求

## 6. 官方发布（POST /publish）

样例文件：`scripts/agent-templates/publish-official.json`

```bash
AGENT_BASE_URL=http://127.0.0.1:4273 \
WECHAT_AGENT_SIGNING_SECRET='replace-with-secret' \
npm run agent:req -- POST /publish scripts/agent-templates/publish-official.json
```

注意：

1. `review_approved` 必须为 `true`
2. 官方通道必须提供 `thumb_media_id`
3. 同一 `idempotency_key` 重复调用会返回历史结果（`dedup_hit: true`）

## 7. 关键接口汇总

- `GET /health`
- `POST /agent/config/init`
- `POST /agent/config-check`
- `POST /publish`
- `POST /callback`

