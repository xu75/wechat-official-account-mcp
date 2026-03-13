# Browser Publisher Command Adapter

`WECHAT_AGENT_BROWSER_PUBLISH_CMD` 需要指向一个可执行命令，Agent 会追加一个参数：`payload-json-path`。

调用形式：

```bash
<WECHAT_AGENT_BROWSER_PUBLISH_CMD> <payload-json-path>
```

## 输入

- `payload-json-path`: Agent 生成的发布请求 JSON 文件路径

## 输出（stdout，JSON）

成功：

```json
{"ok": true, "publish_url": "https://mp.weixin.qq.com/s/...", "message": "..."}
```

失败：

```json
{"ok": false, "error_code": "BROWSER_PUBLISH_FAILED", "error_message": "..."}
```

## 真实自动发布命令（本仓库，CDP attach 模式）

```bash
node /Users/xujinsong/VSCode/SynologyDrive/wechat-official-account-mcp/scripts/browser-publisher/playwright-cdp-wechat-publish.mjs
```

前置：

1. 安装 Playwright：`npm install -D playwright`
2. 确保本机有 Chrome（默认 `WECHAT_BROWSER_CHANNEL=chrome`）
3. `npm run agent:start:prod` 会自动自检并启动 CDP（若 9222 未监听）
4. 未登录时由 `/publish` 返回 `waiting_login`，再通过 login-session 接口取二维码完成扫码

关键环境变量：

1. `WECHAT_BROWSER_SUBMIT_MODE=draft|publish`（推荐先 `draft`）
2. `WECHAT_BROWSER_USER_DATA_DIR=~/.wechat-agent/pw-profile`
3. `WECHAT_BROWSER_CDP_PORT=9222`
4. `WECHAT_BROWSER_CDP_URL=http://127.0.0.1:9222`
5. `WECHAT_BROWSER_DEBUG_DIR=/tmp/wechat-agent-browser-debug`
6. `WECHAT_BROWSER_DRY_RUN=true`（仅联调时跳过浏览器操作）
7. `WECHAT_BROWSER_HUMAN_DELAY_BASE_MS=700`（每步基础停顿）
8. `WECHAT_BROWSER_HUMAN_DELAY_JITTER_MS=500`（每步随机抖动）
9. `WECHAT_BROWSER_TYPE_DELAY_MIN_MS=45`
10. `WECHAT_BROWSER_TYPE_DELAY_MAX_MS=120`
11. `WECHAT_BROWSER_PUBLISH_LOGIN_TIMEOUT_MS=30000`（发布时若未登录，快速失败超时）
12. `WECHAT_BROWSER_RETURN_LOGIN_QR=true|false`（未登录返回时是否附带二维码 PNG Base64）
13. `WECHAT_BROWSER_LOGIN_STABLE_ROUNDS=1`（登录校验连续成功次数）
14. `WECHAT_BROWSER_VERBOSE=true`（输出登录轮询调试日志到 stderr）

正文与封面规则（当前实现）：

1. 不再支持“删除正文图片”模式，正文 HTML 会按原样注入编辑器。
2. 若正文含图片，发布器会尝试点击“从正文选择封面”并选第一张图作为封面（best effort）。
3. 若正文无图，则不设置封面图，继续保存草稿流程。
4. 封面选择结果会写入结构化字段：`cover_from_content_applied` / `cover_from_content_reason`。
5. 微信编辑器若改写图片 URL（常见），不会判定为失败；仅当“实际图片数量 < 输入图片数量”才报 `BROWSER_IMAGE_INSERT_FAILED`。
6. 若输入包含超链接而编辑器中链接数量减少，会返回 `BROWSER_LINK_INSERT_FAILED`。

## waiting_login 解耦调用

当 `/publish` 返回 `status=waiting_login` 时，使用独立接口/脚本获取二维码，不需要在发布接口里阻塞等待。

命令行：

```bash
# 通过 task_id + idempotency_key 查询，并保存二维码到本地文件
npm run agent:login:session -- by-request <task_id> <idempotency_key> --qr-file /tmp/wechat-login-qr.png

# 或直接按 session_id 查询
npm run agent:login:session -- by-session <login_session_id> --qr-file /tmp/wechat-login-qr.png
```

HTTP 接口：

1. `GET /agent/login-session/:sessionId`
2. `GET /agent/login-session/:sessionId/qr`
3. `GET /agent/login-session/by-request/:taskId/:idempotencyKey`

调试产物：

1. 失败时会写入 `WECHAT_BROWSER_DEBUG_DIR`：
2. `*.png` 页面截图（不含浏览器地址栏）
3. `*.html` 当前页面 HTML
4. `*.meta.json`（包含 `page_url`、`page_title`、`main_frame_url`、`frame_urls`）

快速验证（含图正文）：

```bash
npm run agent:publish:browser:image
```

## mock 命令（仅联调）

```bash
node /Users/xujinsong/VSCode/SynologyDrive/wechat-official-account-mcp/scripts/browser-publisher/mock-success.mjs
```

这个示例不会真实发文，可通过环境变量强制失败：

`MOCK_BROWSER_PUBLISH_FORCE_FAIL=true`
