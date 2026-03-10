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
3. 需先启动可被附着的 Chrome CDP 会话（推荐命令：`npm run agent:browser:login:confirm`）

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
13. `WECHAT_BROWSER_LOGIN_ONLY_HOLD_MS=8000`（login-only 成功后保持窗口可见时长）
14. `WECHAT_BROWSER_LOGIN_STABLE_ROUNDS=1`（登录校验连续成功次数）
15. `WECHAT_BROWSER_IMAGE_MODE=skip|strict`（默认 `skip`：图片标签先剥离，先走纯文本正文）
16. `WECHAT_BROWSER_VERBOSE=true`（输出登录轮询调试日志到 stderr）

## Manual Login Confirm (Recommended when auto login check is unstable)

Run:

```bash
npm run agent:browser:login:confirm
```

Behavior:

1. 启动或复用 Chrome（带 `--remote-debugging-port`，且使用 `WECHAT_BROWSER_USER_DATA_DIR`）
2. You scan QR and confirm login manually
3. In terminal, type `OK` to finish（Chrome 保持打开供发布附着）
4. Then run publish command in next step

Notes:

1. 发布阶段会通过 CDP 连接已有 Chrome，不再重复新起独立浏览器会话。
2. 若要彻底结束会话，手动关闭该 Chrome 窗口即可。

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

## mock 命令（仅联调）

```bash
node /Users/xujinsong/VSCode/SynologyDrive/wechat-official-account-mcp/scripts/browser-publisher/mock-success.mjs
```

这个示例不会真实发文，可通过环境变量强制失败：

`MOCK_BROWSER_PUBLISH_FORCE_FAIL=true`
