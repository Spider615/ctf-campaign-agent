# POC 共享工作空间实施计划

> 按本次用户已明确的简单 POC 范围在当前会话实施，不增加账号或配置步骤。

**目标：** 同一部署更换浏览器后仍可读取并继续使用已保存记录。

**架构：** 固定共享 UUID，由分析入口统一传给 D1 和 Agent。共享空间兼容读取既有归属，保留旧记录与附件原路径。

**技术：** TypeScript、Node 测试、D1 / SQLite、现有附件存储。

## 1. 先复现

- [x] 在 `tests/analytics-store.test.ts` 覆盖不同 Cookie 共用空间、无 Cookie 同源写入、旧快照和报告可读。
- [x] 在 `tests/conversation-threads.test.ts` 覆盖两个独立浏览器缓存读写同一服务端记录、历史副本去重、覆盖保存与删除、对话范围。
- [x] 在 `tests/attachments-http.test.ts` 覆盖共享空间读取、下载、删除旧归属的附件，以及跨对话拒绝。
- [x] 执行 `node --test --experimental-strip-types tests/analytics-store.test.ts tests/conversation-threads.test.ts tests/attachments-http.test.ts`，确认新增用例因现有浏览器隔离而失败。

## 2. 最小实现

- [x] 新建 `app/lib/poc-workspace.ts`，导出唯一固定 UUID；`analytics-access.ts` 返回该标识，保留同源检查。
- [x] `analytics-store.ts` 为该共享标识兼容读取全部旧归属；相同对话编号按更新时间选最新副本，保存沿用原行，删除覆盖历史副本。
- [x] 在原对话表用删除标记清除正文并阻止迟到保存；列表返回删除编号，浏览器据此清理旧缓存，覆盖删除早于首次保存的竞态。
- [x] `agent/attachments/store.ts` 在共享空间按对话查找现有附件目录，新上传仍写共享目录；合并列表和容量计算，不跟随旧归属或会话目录符号链接。
- [x] 同步 `README.md`、数据库注释、导入说明和相关入口注释，说明当前 POC 共享行为；原有本地指引文件保持不动，本次用户要求优先。

## 3. 验证

- [x] 重跑相关回归，并运行附件文件、上传和运行恢复测试。
- [x] 执行 `npx tsc --noEmit`、`npx tsc -p agent/tsconfig.json` 和 `npm run build`。
- [x] 审查 diff，保留原有 `CLAUDE.md`、`agent/package-lock.json` 及同时出现的洞察页面修改；报告验证结果和发布状态。

## 验证记录（2026-11-08）

使用本机 Node 22.23.1。新增浏览器共享用例先失败、实现后通过；独立评审发现的删除复活问题也先补失败回归再修复。

- 全量单测：1364 项，1363 通过、0 失败、1 项 Linux 隔离专用测试在 macOS 跳过。
- 页面与 Agent 类型检查、变更文件 ESLint、生产构建、`git diff --check` 均通过。
- 真实报告 Worker API 覆盖不同 Cookie 与无 Cookie 可读、跨源写入拒绝；旧回答协议和原报告不变。
- 独立代码评审复审通过，无必须修复项。
- 本地代码完成，未提交、推送或部署；未调用模型或修改真实经营数据库。
