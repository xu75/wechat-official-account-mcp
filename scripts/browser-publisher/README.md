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

## 示例命令（本仓库）

```bash
node /Users/xujinsong/VSCode/SynologyDrive/wechat-official-account-mcp/scripts/browser-publisher/mock-success.mjs
```

这个示例仅用于联调，不会真实发文。可通过环境变量强制失败：

```bash
MOCK_BROWSER_PUBLISH_FORCE_FAIL=true
```
