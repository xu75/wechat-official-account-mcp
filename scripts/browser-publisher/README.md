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

## 真实自动发布命令（本仓库）

```bash
node /Users/xujinsong/VSCode/SynologyDrive/wechat-official-account-mcp/scripts/browser-publisher/playwright-wechat-publish.mjs
```

前置：

1. 安装 Playwright：`npm install -D playwright`
2. 确保本机有 Chrome（默认 `WECHAT_BROWSER_CHANNEL=chrome`）
3. 首次运行会打开公众号后台，扫码登录后登录态会持久化在 `WECHAT_BROWSER_USER_DATA_DIR`

关键环境变量：

1. `WECHAT_BROWSER_SUBMIT_MODE=draft|publish`（推荐先 `draft`）
2. `WECHAT_BROWSER_HEADLESS=false`（推荐先可视化）
3. `WECHAT_BROWSER_USER_DATA_DIR=~/.wechat-agent/browser-profile`
4. `WECHAT_BROWSER_DEBUG_DIR=/tmp/wechat-agent-browser-debug`
5. `WECHAT_BROWSER_DRY_RUN=true`（仅联调时跳过浏览器操作）

## mock 命令（仅联调）

```bash
node /Users/xujinsong/VSCode/SynologyDrive/wechat-official-account-mcp/scripts/browser-publisher/mock-success.mjs
```

这个示例不会真实发文，可通过环境变量强制失败：

`MOCK_BROWSER_PUBLISH_FORCE_FAIL=true`
