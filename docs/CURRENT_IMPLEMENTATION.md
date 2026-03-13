# 当前分支实现说明（保留原架构 + 新增 Agent/Browser 链路）

本文档用于说明本仓库在当前分支的“实际可用方案”，避免与原始 release 仅官方 API 的认知混淆。

## 1. 为什么有这份说明

原始 `wechat-official-account-mcp` 的核心是微信公众号官方 API 工具集，这部分在本仓库仍然保留。

但在实际落地中，存在“个人主体/未认证账号无法使用官方发布接口”的场景，因此当前分支新增了：

- 本地 `wechat-publisher-agent`（HTTP 接口）
- Browser 发布通道（`manual`/`command`）
- `waiting_login` 扫码中间态与登录会话机制
- ECS/OpenClaw 侧联调脚本与状态机约束

结论：当前仓库是“双轨并存”，不是替换关系。

## 2. 两条能力如何分工

### A. 原始官方 MCP 能力（保留）

- 入口：`src/mcp-tool/*`、`src/wechat/api-client.ts`
- 典型用途：已认证账号、具备对应接口权限时，走官方 API 完成素材/草稿/发布
- 运行方式：`npx wechat-official-account-mcp mcp ...` 或 `wechat-mcp ...`

### B. 当前推荐联调链路（新增）

- 入口：`api/` + `scripts/agent-*` + `scripts/browser-publisher/*`
- 典型用途：个人号/无官方发布权限时，走 Browser 通道完成“写入编辑器 -> 保存草稿”
- 运行方式：`npm run agent:start:prod` + `npm run agent:publish:browser`

## 3. 端到端架构（当前实际落地）

1. OpenClaw/业务侧提交发布请求到 ECS Gateway
2. Gateway 做签名、审核校验、幂等与状态机
3. Gateway 调 Agent（本地 `4273`，通常通过 FRP 映射到 ECS `14273`）
4. Agent 根据策略走 `official` 或 `browser`
5. Browser 模式下可能返回 `waiting_login`，扫码后再触发继续发布

> 推荐职责边界：
> - 内容编排与 Markdown 预处理放在 Gateway/ECS
> - Agent 专注执行发布动作与回传结构化状态

## 4. 当前关键接口（Agent）

路由定义在 `api/routes/agent.ts`：

- `GET /health`
- `POST /agent/config/init`
- `POST /agent/config-check`
- `POST /publish`
- `POST /callback`
- `GET /agent/login-session/:sessionId`
- `GET /agent/login-session/:sessionId/qr`
- `GET /agent/login-session/by-request/:taskId/:idempotencyKey`

核心行为：

- `status=accepted`：已进入成功路径（含 browser 成功执行）
- `status=waiting_login`：登录中间态（不应写入终态幂等）
- `status=publish_failed`：发布失败（应返回明确 `error_code`）

## 5. 状态机约定（建议作为联调基线）

主链路：

`drafted -> waiting_review -> approved -> publishing -> published`

失败链路：

`publishing -> publish_failed -> manual_intervention`

登录中间态：

`publishing -> waiting_login -> publishing -> (published | publish_failed)`

注意：

- `waiting_login` 是中间态，不应当作终态成功/失败。
- 同一 `idempotency_key` 只允许一个终态结果。

## 6. 当前推荐启动方式（Browser 场景）

```bash
cd /Users/xujinsong/VSCode/SynologyDrive/wechat-official-account-mcp
npm install
npm run build:prod
cp .env.agent.example .env.agent
npm run agent:start:prod
```

说明：

- `agent:start:prod` 会在启动 Agent 前自动检查 CDP（`WECHAT_BROWSER_CDP_URL`，默认 `127.0.0.1:9222`）。
- 若 CDP 未监听，会自动拉起 Chrome（使用 `WECHAT_BROWSER_USER_DATA_DIR`）。

另开终端：

```bash
npm run agent:health
npm run agent:config:check:browser
npm run agent:review:token -- scripts/agent-templates/publish-browser.json --write --timestamp-title
npm run agent:publish:browser
npm run agent:regression:browser
```

如果触发登录态：

- 接收 `waiting_login`
- 调用 `GET /agent/login-session/:sessionId` 或 `GET /agent/login-session/:sessionId/qr` 获取二维码
- 人工扫码后，单次重试 `/publish`
- 不建议轮询高频重试

回归脚本说明：

- `npm run agent:regression:browser` 会执行 `health -> publish -> 同 key 重放 publish`
- 第二次请求必须 `dedup_hit=true`，用于验证幂等未退化

## 7. 文档阅读顺序（建议）

1. 本文档：`docs/CURRENT_IMPLEMENTATION.md`
2. 联调细节：`docs/AGENT_PHASE_B.md`
3. 执行 checklist：`docs/AGENT_NEXT_STEPS.md`
4. 原始 MCP 工具总览：`FEATURES_OVERVIEW.md`

## 8. 迁移与维护建议

为减少长期混淆，后续可考虑拆仓：

- 仓库 A：纯 MCP 官方 API 能力（对齐上游）
- 仓库 B：Agent + Browser 发布执行面（本地自动化）
- Gateway（ECS）独立仓库维护编排和状态机

在拆仓前，本仓库维持“双轨并存”策略即可：

- README 顶部明确告知双轨模式
- 所有新增功能优先在 `docs/CURRENT_IMPLEMENTATION.md` 更新
