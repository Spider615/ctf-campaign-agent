# Final review race fix report

日期：2026-09-17
基线：`a072ed4`

## 结论

final review 指出的停止、对账和提交竞态已经收口。浏览器现在为每个受控回合租用 `clientTurnId`；停止或网络结果不确定时，同一请求重试复用该 ID，收到成功 Snapshot 或完成 409 对账后才清除。服务端以“确定性首消息主键 + 请求摘要”作为原子幂等栅栏，不增加表、草稿版本或迁移。

## 关键实现

- `Conversation` 在成功取得本地回合锁后租用 ID，所有 `interpret`、`text`、`edit`、`dismiss`、`undo`、`rollback` 请求都携带该 ID。不同 body 不复用；成功后再次发送同文案会得到新 ID。
- `postTurn` / `postTurnStream` 在调用方未传 ID 时用 `crypto.randomUUID()` 补齐，因此 WebMCP 等非聊天调用也不会发送匿名新回合。
- 服务端校验 UUID，把排除 `expectedSeq`、`clientTurnId` 的 canonical body 做 SHA-256；摘要不保存用户原文。
- 回合凭据只附在首条 `StoredMessage`，首消息 ID 由 session ID 和 client turn ID 确定。D1 复用既有 `message.id` 主键和 `db.batch` 原子性；MemoryStore 补齐同样的全局消息主键、整批预检语义。
- 同 ID、同 body 已提交时先于 `expectedSeq` 返回现有 Snapshot；同 ID、不同 body 返回 400，且顺序重试不会再次调用 Agent。并发同 ID 最多一批提交成功，冲突方读取胜者。
- `commitAndLoad` 是所有回合提交的共同线性化入口：每次 `store.commit` 前最后检查取消，调用提交后不再把取消伪装成未提交；成功与失败的仅消息提交均覆盖。
- 409 对账 GET 接收同一 `AbortSignal`。本地等待会在停止时立刻结束、释放发送锁并移除监听；底层迟到 resolve/reject 都有 rejection handler 消费，不会污染新回合。
- 旧消息没有 `turn` 字段仍可正常解码；旧客户端没有 `clientTurnId` 仍走原有兼容路径。

## 竞态与设计取舍

- 不引入 active-turn 表或新数据库表。已有 message 主键已经是 D1 与内存实现都能共享的原子唯一约束，凭据随业务消息同 batch 提交，不会出现“收据已写、业务未写”的半状态。
- 并发相同请求仍可能都已进入 Agent；幂等边界保证最多一次持久化，冲突方返回胜出结果。若在 Agent 前增加分布式锁会扩大存储协议和失败面，本次不采用。
- 真正的 stale-seq 仍使用 409 + Snapshot 对账；停止后是否提交不再靠猜测 409，而由同一 `clientTurnId` 的下一次同体重试确定性判断。
- 请求哈希可随 Snapshot 读取，但只包含固定长度 SHA-256 摘要，不暴露受控请求正文。

## 测试覆盖

- 客户端租约：六类 TurnBody、停止/网络不确定复用、成功清除、同文案成功后新 ID、不同 body 隔离、迟到完成不清新租约。
- API：非聊天 `postTurn` 自动生成 ID；流式调用保留租约 ID 并传递取消信号；快照 GET 传递取消信号。
- 服务端：text/interpret 的成功与失败仅消息幂等、顺序重试、不同 body 400 且不重跑 Agent、仅消息与新版本并发胜者、停止/提交竞态、旧调用兼容、消息编解码兼容、MemoryStore 主键原子性。
- 取消提交：失败轨迹回调停止不落错误消息；成功和失败的仅消息提交在 commit 调用后发生停止仍返回完整 Snapshot。
- 409 GET：正常/取消移除监听，挂起读取可立刻停止，迟到 resolve/reject 均被消费。

## 最终验证

- focused：`node --test --experimental-strip-types tests/turn-idempotency.test.ts tests/client-turn-ownership.test.ts tests/client-stream.test.ts tests/conversation.test.ts`
- 全量：`npm test`，353/353 通过。
- lint：`npm run lint`，0 errors / 0 warnings。
- 页面类型：`npx tsc --noEmit`，通过。
- Agent 类型：`npx tsc -p agent/tsconfig.json`，通过。
- 构建：`npm run build`，通过。
- diff：`git diff --check`，通过。

未启动或操作 dev 服务，未安装依赖，未修改 lockfile、Campaign/1811/Skill 业务规则、总时限或 `maxTurns = 12`。

## Final 4 Important 跟进

独立复审补出了跨标签顺序：A 已提交但当前标签结果不确定，另一标签再提交 B，当前标签用 A 的同一 `clientTurnId` 重试后会得到包含 A 与 B 的最新 Snapshot。旧客户端只比较最新用户文案，因此会把已经提交的 A 错误恢复到输入框。

修复后，`send` 返回 Snapshot 及本次 `clientTurnId` 的提交判定；判定会扫描所有消息的持久化 receipt，不再要求 A 是最后一句。只有完全没有 receipt 的旧 Snapshot 才保留末句文案 fallback；只要已有其他 receipt，即使文案相同也不能冒充 A。输入恢复另受本地 submit 代次保护，迟到旧 send 既不能清除新租约，也不能覆盖新草稿。行为测试用真实 `runTurn`、客户端租约和 A→B→重试 A 顺序覆盖该边界，并覆盖无 A receipt 恢复、同文案其他 receipt 隔离、成功后同文案使用新 ID。

本轮未修改服务端幂等协议、业务规则、依赖或 lockfile，也未启动或操作 dev 服务。

### 跟进验证

- focused：92/92 通过（`campaign-ui`、`client-stream`、`client-turn-ownership`、`conversation`、`turn-idempotency`）。
- 全量：`npm test`，356/356 通过。
- lint：0 errors / 0 warnings。
- 页面与 Agent 两套 TypeScript 检查通过。
- 生产构建通过；`git diff --check` 通过。
