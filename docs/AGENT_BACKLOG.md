# Agent Backlog (Post-MVP)

本文档记录当前已识别但可后置的问题，优先保障“基本功能跑通”。

## P0

1. Browser 发布串行锁
- 目标：同一时刻仅允许一个 browser publish 任务执行，避免多窗口并发互相干扰。
- 验收：并发触发两个任务时，后发任务进入明确排队/拒绝状态，不再误判 success。

2. CDP 预检与自愈
- 目标：发布前检测 `127.0.0.1:9222` 可用，不可用时返回明确错误并可选自动拉起 CDP Chrome。
- 验收：不再出现模糊 `manual_intervention`，错误原因可直接定位为 CDP 未就绪。

3. 幂等持久化
- 目标：将 idempotency 存储从内存迁移到持久化存储（sqlite/file kv）。
- 验收：Agent 重启后，同一 `idempotency_key` 仍返回同一终态，不重复发文。

## P1

4. 全链路 trace_id
- 目标：请求、浏览器脚本、回包、审计日志统一 trace_id。
- 验收：任一失败可按 trace_id 一键定位完整链路。

5. Debug 快照索引
- 目标：为 `/tmp/wechat-agent-browser-debug` 生成任务级索引，快速定位 `task_id -> png/html/meta`。
- 验收：排查无需手工 grep 文件名。

6. waiting_login 事件化
- 目标：从“轮询重试”升级为“事件回调/主动通知”。
- 验收：Gateway 在收到登录完成事件后再触发 resume，避免高频请求。

## P2

7. 登录后 resume 当前任务
- 目标：支持基于 `login_session_id` 恢复当前任务，而不是重新创建新任务。
- 验收：同一任务从 `waiting_login -> publishing -> published/publish_failed` 闭环。

8. 开机自启动与巡检
- 目标：开机自动拉起 Agent + CDP Chrome，并提供健康巡检脚本。
- 验收：机器重启后无需人工干预即可恢复发布能力。

## Deferred

9. 图片严格模式（上传后插入）
- 目标：在纯文本稳定后，补齐图片上传与正文插入一致性。
- 验收：图片失败不影响正文，且错误码可区分为 `BROWSER_IMAGE_INSERT_FAILED`。

