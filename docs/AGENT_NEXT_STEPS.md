# Wechat Publisher Agent 下一步完整执行清单

目标：在“个人主体、无法走官方发布接口”的前提下，先把 `browser` 通道跑成可持续联调链路，并保留后续迁移到 `official` 的接口兼容性。

## A. 一次性准备

1. 拉取最新代码并构建
2. 复制本地配置模板
3. 启动 Agent
4. 验证健康检查

```bash
cd /Users/xujinsong/VSCode/SynologyDrive/wechat-official-account-mcp
git pull
npm install
npm run build:prod
cp .env.agent.example .env.agent
npm run agent:start
```

另开终端：

```bash
cd /Users/xujinsong/VSCode/SynologyDrive/wechat-official-account-mcp
npm run agent:health
```

验收：`/health` 返回 `status=200`。

## B. Browser 主通道（当前可执行）

1. 在 `.env.agent` 配置 browser 模式（建议先 `manual`）
2. 执行 browser 配置校验
3. 提交发布请求
4. 处理发布结果

```bash
npm run agent:config:check:browser
npm run agent:review:token -- scripts/agent-templates/publish-browser.json --write --timestamp-title
npm run agent:publish:browser
```

验收：

1. `config-check` 返回 `publish_check.ok=true`
2. `publish` 至少进入 browser 流程（manual 模式下会返回任务目录）
3. 任务目录下有 `publish-task.json`、`article-content.html`、`README.txt`

## C. 自动化 browser（推荐下一步）

1. 将 `.env.agent` 切到 command 模式
2. 配置 `WECHAT_AGENT_BROWSER_PUBLISH_CMD`
3. 发布命令实现标准 JSON 输出
4. 首次扫码登录后复用本地浏览器 profile

推荐命令：

`scripts/browser-publisher/playwright-wechat-publish.mjs`

推荐参数：

1. `WECHAT_BROWSER_SUBMIT_MODE=draft`（先验证自动化流程）
2. `WECHAT_BROWSER_HEADLESS=false`
3. `WECHAT_BROWSER_USER_DATA_DIR=~/.wechat-agent/browser-profile`

要求输出：

```json
{"ok": true, "publish_url": "https://mp.weixin.qq.com/s/..."}
```

失败输出：

```json
{"ok": false, "error_code": "BROWSER_PUBLISH_FAILED", "error_message": "..."}
```

验收：`npm run agent:publish:browser` 返回 `status=accepted` 且 `channel=browser`。

## D. ECS 联调（保持现有接口不变）

ECS 调用顺序：

1. `GET /health`
2. `POST /agent/config-check`
3. `POST /publish`
4. 根据结果进入重试或人工

建议策略：

1. 重试节奏：`1m -> 5m -> 30m`
2. 幂等键：每次业务任务稳定映射同一 `idempotency_key`
3. 失败转人工：`manual_intervention`

验收：

1. 重复请求不重复发文（`dedup_hit=true`）
2. 任一失败都能在 `/tmp/wechat-agent.log` 与 ECS 审计里追溯

## E. 未来切换回 Official

当主体认证完成且接口权限开通后：

1. `preferred_channel` 切回 `official`
2. 发布模板补 `thumb_media_id`
3. 保留 browser 作为兜底

这样不需要改 ECS 接口契约，只改策略开关即可。
