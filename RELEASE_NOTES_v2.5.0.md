# Release Notes - v2.5.0

发布日期：2026-03-15

## 本版本重点

v2.5.0 以“公众号发布执行链路可稳定运行”为目标，重点收敛在 Agent + Browser 正式流程，适配个人号/无官方发布权限场景。

## 主要更新

1. 启动流程一体化
- `npm run agent:start:prod` 现在会：
- 先构建产物
- 检查 CDP 端口（默认 `127.0.0.1:9222`）
- 必要时自动拉起 Chrome CDP
- 最后启动 Agent 服务

2. 登录流程统一
- 正式流程统一为：`waiting_login + login-session`。
- 移除本地 `login-confirm` 与 `login-only` MVP 分支，减少分叉路径。

3. 发布校验增强
- 保持“正文非空才可成功”约束。
- 链接被清洗时，自动将 URL 作为可见文本补到对应锚文本后，降低信息丢失风险。
- 图片/链接/正文失败错误码继续区分，便于 Gateway 状态机处理。

4. 可观测性增强
- Agent 日志新增 post-submit 链接降级和回退字段，排障更直接。

## 影响与兼容性

1. 兼容
- `/publish`、`/health`、`/callback` 与 `login-session` 接口契约保持兼容。

2. 需要注意
- 如果你之前依赖本地 confirm-login 命令，需要改为 `waiting_login` 后调用 login-session 接口取二维码。

## 推荐启动与联调

```bash
npm install
npm run agent:start:prod
npm run agent:health
npm run agent:config:check:browser
npm run agent:publish:browser
```

## 相关文档

- `docs/CURRENT_IMPLEMENTATION.md`
- `docs/AGENT_PHASE_B.md`
- `docs/AGENT_NEXT_STEPS.md`
- `scripts/browser-publisher/README.md`
