# 对话附件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans 在当前会话逐项实现，用户已确认按规格继续实现。

**Goal:** 对话中上传多种文件，基于实际读取内容回答并可追问和查看来源。

**Architecture:** Workers 负责访问身份和流式转发；Node 负责仓库外文件、受限解析、读取工具和文件回答；文件结果使用独立合同，既有经营分析校验继续生效。

**Tech Stack:** TypeScript、React、现有 Claude Agent SDK、Python 文档解析库、LibreOffice、libarchive、Tesseract。

**Spec:** `docs/superpowers/specs/2026-10-15-conversation-attachments-design.md`

## Global Constraints

- Node.js >= 22.13；共享模块不 import Node、npm 包或 `cloudflare:workers`。
- 单文件 25 MiB；每条消息 10 个、100 MiB；单会话 500 MiB；30 天保留。
- 解压整棵树 250 MiB、100 文件、2 层；逐项保留失败与覆盖状态。
- 不执行 HTML、宏或上传代码，不把附件文字写成用户确认的执行事实。
- 文件、解析产物和历史证据留在仓库外；只使用合成测试资料。
- 先免费假模型验证；不发起付费模型验收。

## Review Focus

- 同一浏览器多个会话切换及旧异步请求完成，不得串附件。
- 文件已删除或过期，旧消息恢复和重试不得继续读原内容。
- Excel 缓存公式、合并单元格、CSV 引号换行不能悄悄改口径。
- 混合压缩包部分失败和解压限额不能伪装为整包读取成功。
- 有附件的寒暄、空文字和未配置 MySQL 不能落入忽略文件的快速回复。

### Task 1: 附件和回答合同

**Files:** 创建 `app/lib/attachments/{types,answer}.ts` 与 `tests/attachments-answer.test.ts`。

**Interfaces:** `AttachmentSummary`、`DocumentBlock`、`ConversationRequest`、`ConversationAnswer`；`validateConversationAnswer(value)`、`conversationAnswerText(answer)`。

- [x] 写失败测试：未知引用、不匹配的原文和不受支持的数字不能通过；真实来源可序列化恢复。
- [x] 运行 `node --test --experimental-strip-types tests/attachments-answer.test.ts`，确认缺少实现失败。
- [x] 实现版本化类型、严格输入校验和由实际读取来源组装的回答；客户端不供应权威解析内容。
- [x] 同命令验证通过，登记结果。

```ts
const answer = validateConversationAnswer({ schema: "conversation-answer/v1", status: "answered", blocks: [{ text: "建议关注会员方案", sourceIds: ["s1"] }], sources: [{ id: "s1", attachmentId, version, name: "方案.docx", location: "段落 1", kind: "document", excerpt: "会员方案" }] });
assert.equal(conversationAnswerText(answer), "建议关注会员方案");
```

### Task 2: 文件存储、解析与受控计算

**Files:** 创建 `agent/attachments/{store,parser,tools}.ts`、`agent/attachments/parse.py`、`agent/attachments/requirements.txt`、`tests/attachments-files.test.ts`。

**Interfaces:** `createAttachmentStore(config)` 提供 upload/list/get/remove/read；`parseAttachment(input, output, signal)` 产出带位置的结构块和表格；读取工具返回本轮可引用来源。

- [x] 写真实临时目录测试，覆盖 UTF-8 / GB18030 CSV、HTML 脚本剔除、跨会话拒绝、全表十进制求和和删除后失效。
- [x] 运行 `node --test --experimental-strip-types tests/attachments-files.test.ts`，观察缺失能力失败。
- [x] 实现流式写入、哈希、队列和原子元信息；解析以实际类型路由，保存原文、位置和资源状态。
- [x] 添加 DOCX / PPTX / XLSX / PDF / 图片及混合 ZIP 合成样本测试；包括路径穿越、压缩炸弹、公式无缓存、损坏文件和取消。
- [x] 实现受限执行器、格式解析、解包及结构化表格查询；不开放任意路径、SQL或代码。
- [x] 运行同文件测试并登记实际通过数量。

```ts
const file = await store.upload({ owner, conversationId, name: "销售.csv", stream, signal });
await assert.rejects(store.get({ owner, conversationId: otherConversationId, id: file.id }));
const result = await tools.calculate({ attachmentId: file.id, tableId: "table-1", operation: "sum", column: "实收" });
assert.equal(result.value, "0.3");
```

### Task 3: 上传、来源与流式问答接口

**Files:** 创建 `agent/attachments/http.ts`、Workers 附件接口；修改 `agent/http-handler.ts`、`agent/server.ts`、`app/lib/server/runtime.ts`。

**Interfaces:** 同源 `/api/analytics/attachments` 二进制上传及查询/删除/预览；`/api/analytics/conversation` NDJSON；内部 owner 只由 Workers 注入。

- [x] 写 HTTP 集成失败测试：鉴权、二进制上传、跨 owner / 会话访问、大小限制、断连取消和未配置数据库的文件问答。
- [x] 运行 `node --test --experimental-strip-types tests/attachments-http.test.ts`，确认新路径缺失。
- [x] 实现 Node 独立路由及 Workers 流式网关，严格校验 owner、会话和资源 ID。
- [x] 验证同源与身份覆盖、HTML 强制下载及安全预览；运行接口测试并登记。

```ts
const response = await fetch(`${base}/attachments?conversationId=${conversationId}&name=notes.txt`, { method: "POST", headers: { authorization: "Bearer test", "x-attachments-owner": owner }, body: "活动方案" });
assert.equal(response.status, 202);
```

### Task 4: 文件 Agent 与引用核验

**Files:** 创建 `agent/attachments/run-turn.ts`、`tests/attachments-agent.test.ts`；扩展流式合同与过程工具元信息。

**Interfaces:** `createConversationRunner(config)`；本地固定工具为目录、读块、检索、表格计算、识图、经营数据子任务及提交答案；只返回校验后的 `ConversationAnswer`。

- [x] 用假 SDK 调真实工具，验证有附件不走寒暄快速回复、未读取引用被拒绝和伪造数字被拒绝。
- [x] 运行测试观察缺少 runner 失败。
- [x] 接入 SDK 与取消，先实际读取再发来源；识图只在发送后调用模型；最终答复经过独立上下文语义复核。
- [x] 混合问题调用现有经营分析，先保留其原合同核验，再绑定引用；文件不得扩展数据库权限。
- [x] 验证中断挂起 SDK、图像原文来源、复核失败及重试；登记测试结果。

```ts
assert.equal(await run({ question: "你好", attachmentIds: [id], conversationId, history: [] }, signal).then((r) => r.schema), "conversation-answer/v1");
```

### Task 5: 上传交互和会话恢复

**Files:** 创建附件卡片、来源展开、`app/lib/client/attachments.ts`；修改共享输入框、营销和活动对话、历史保存及消息展示。

**Interfaces:** `Composer` 接收附件状态及选择/移除/重试事件；提交快照含 text 与 ready 附件；历史只持久化元信息和 ID。

- [x] 写客户端行为失败测试：文件数量、体积、空文字默认问题、会话切换、重复选择及恢复过期文件。
- [x] 实现选择/拖拽/图片粘贴、状态和移除；保留中文输入法、停止按钮和文字可复制。
- [x] 首页与绑定活动、独立活动聊天都接入文件问答；不把附件抽取文字传入事实写入路径。
- [x] 浏览器验证单文件、多文件、图片和 ZIP；用确定性假模型完成上传至最终来源展开的端到端验证。

```ts
const draft = createAttachmentSubmission("", readyFiles);
assert.equal(draft.question, "请概括这些文件，并说明值得关注的内容");
```

### Task 6: 交付依赖、回归与独立审查

**Files:** 修改 Dockerfile、配置示例、AGENTS.md，补充依赖检查命令和测试夹具。

**Interfaces:** 开发和交付镜像安装同一解析依赖；`ATTACHMENTS_DIR` 私有持久卷；缺失解析隔离能力显式报告。

- [x] 安装锁定解析依赖、检查本机与镜像命令，不调用付费模型。
- [x] 运行全部 `npm test`、两侧 `tsc`、lint、build；任何失败按名称记录。
- [x] 使用 executing-plans 要求的独立审查检查本次改动，修复有实质影响的问题并重跑对应回归。
- [x] 更新本计划与执行记录，说明真实文件/界面验证、部署验证与未执行的模型效果验收边界。

## 执行约定

在当前会话持续实现；用户已授权实施，不重复请求同一实施许可。当前仓库有既有未提交功能，保留其全部修改，只审查本任务增量；不自动提交用户的其他工作，不推送或部署。


## 实施与验证结果（2026-10-15）

六项任务已完成。文件上传与问答已覆盖营销首页、绑定活动后的统一对话及独立活动聊天；本地 `dev:all` 已重启，`http://localhost:5173/analysis` 使用新服务。没有提交、推送或发布到线上。

- 最终 `npm test`：730 项，729 通过、0 失败、1 项因 macOS 跳过（Linux 内核隔离专项）；两侧 TypeScript、lint、build、`git diff --check` 均通过。
- 最终交付镜像构建成功；直接在镜像内执行附件测试 37/37 通过，包含 Linux 隔离专项，未挂载开发机源代码。镜像内依赖检查和真实 CSV 解析通过。
- macOS 与 Linux 分别验证了真实 DOC / PPT / XLS 转换；另以合成文件验证 DOCX、PPTX、XLSX、HTML、PDF/扫描 PDF、HEIC、CSV/GB18030/带引号换行、ZIP、7Z、TAR、gzip、bz2、xz。RAR 使用 libarchive 公开的微型测试资料验证，正常子文件可读，符号链接逐项标记失败；该上游二进制未加入仓库。
- 表格验证包括全表十进制计算、缺值、前导零、空行后的记录、合并单元格、无缓存公式和歧义数值。Word 验证最终修订视图（保留插入、排除删除），结构有歧义时拒绝自动计算。
- 浏览器验证选择、多文件、拖拽、粘贴图片、仅附件发送、压缩包逐项状态、来源展开、连续追问、删除与失效提示、刷新恢复、活动绑定和独立聊天。390px 手机宽度无横向溢出。
- 本地实际 Workers → Node 接口验证：页面与身份初始化 200，合成 CSV 上传 202、解析 ready、读取 2 行，原文件下载 200，删除 200、删除后读取 404；外部来源删除 403，其他浏览器身份读取 404，客户端伪造 owner 头被覆盖。此轮未发送模型问答。
- 独立审查发现的空行丢记录、合并表格误分组、失效引用阻断、压缩包漏报、逗号小数误算、持续业务约束丢失及 UNIX 数据报出站绕过均已修复，并以对应回归验证。Linux 以独立监听器确认无法向外部 UNIX socket 发送内容。

解析依赖安装于用户应用数据目录，原文件与产物也位于仓库外；开发机安装的 LibreOffice 已通过原始下载校验与完整代码签名检查。镜像安装同样的锁定 Python 依赖及转换、OCR、解包工具，Linux 内核需提供 Landlock ABI 6；不满足时明确禁用解析。

本次回答及视觉端到端使用假 SDK / 假视觉回调，真实上传、解析、计算、工具调用和引用校验均执行。包含图片的复核已验证传入真实归一化像素，且主分析为 Pro 时使用 Flash 识图及图片复核。未发起付费模型效果验收，未把假模型结论当作实际模型质量证明。

执行日志位于忽略目录 `.agents/attachments-work/`：`full-test-final.log`、`typecheck-*-final.log`、`lint-final.log`、`build-final.log`、`docker-build-verified.log`、`docker-image-tests.log`、`docker-image-dependencies.log`、`local-stack-proof.json`。未知、加密、损坏及超限文件可以上传，但会明确显示不能读取或部分读取；音视频转写不在本次范围内。
