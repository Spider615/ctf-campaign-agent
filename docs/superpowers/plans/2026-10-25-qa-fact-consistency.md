# 通用事实一致性校核实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在自由经营问答之后检查回答与本轮已读证据的一致性，修正可证实的错误，不编排营销业务步骤或统一回复格式。

**Architecture:** 保留每轮一次 SDK `query()`、两个可选 Skill、五个自主调用工具。独立技术校核只接收收到的问题上下文、最终草稿及本轮已有的公开证据；没有查库、网络工具或业务写入权限。先默认关闭，私有冻结草稿实验通过后接入关闭的运行时开关；完整实测达标才开启本地配置。

**Tech Stack:** Node 22 TypeScript、现有 Anthropic 兼容模型服务、node:test、现有 v4 答案与 NDJSON 轨迹。

## 授权与边界

2026-10-25 用户明确同意：“允许研发，达标后启用”。这是对原来不固定独立事实复核约束的限定调整，不授权固定取证步骤、营销推导、章节、建议或回复模板。附件和活动创建运行器不接入。

原开发原型额外耗时约 96 秒，且遗漏目录证据、误删正确内容，拒绝采用。本计划先验证证据输入与速度，不因接口成功而开启。

## 验收口径

- 原题规则边界、缺少会员等级、活动计数，以及规则部分已知、等级确实存在的对照均按原业务规则审查。正确说明缺失数据可以通过，不强迫补造事实或扩写。
- 校核能识别冻结失败稿中可证实的数字/范围/推断错误，且不能误删已有目录、用户资料或合法局部汇总支持的内容。正确稿无实质误改。
- 独立审查修订后的完整正文，不能只看补丁格式或模型自行宣称通过。
- 附加耗时目标为单次不超过 15 秒；记录全部观测及原问答总耗时，不挑最快值，不声称所有复杂任务都几十秒完成。超过目标先优化或保持关闭。
- 一次 SDK 会话保持不变，校核的额外模型 API 请求如实另计。取消可中断校核；密钥、原始错误和隐藏思维不进入公开过程或 Git。

## Task 1：冻结草稿实验

执行状态：已完成冻结输入、整篇/分段/断言级及不同推理设置的实验。尚未达到质量与时延的联合验收条件，后续运行时接入保持未实施；具体数据见[研发记录](../notes/2026-10-25-qa-quality-repair.md)。另有私有十进制表达式原型 89 项测试通过，但不将算术测试等同于范围或语义校核通过。

**Files:** 仓库外私有验收目录的 `checker-prototype-v4/`；仓库中不放客户问句、回答、原始结果。

- [x] 从验收 JSON 与同轮审计提取事实、frame、对象、定义、方法和真实 `inspect_dataset` 返回；保留匹配条件、范围、目录总数与完整性身份。
- [x] 去重重复定义，按 `frameId` 和 `objectIds` 关联实际范围，不重复堆长读数；不裁掉事实、筛选或目录证据以满足上下文。
- [x] 用当前选定服务请求非思考模式，只返回最小补丁及证据引用；不保存 reasoning/thinking 块。
- [x] 对每个补丁验证原文唯一命中、不重叠、引用存在、结果非空，图表引用保持有效；失败明确记录，不默认套用。
- [x] 对冻结错误稿、正确稿和资料对照测质量与新增耗时；独立复核后决定是否进入下一任务。结论为不接入未达标原型。

## Task 2：证据与补丁合同

**Files:** 新建 `agent/analytics-fact-check.ts`、`tests/analytics-fact-check.test.ts`。

核心类型：

```ts
type FactPatch = { oldText: string; newText: string; evidenceRefs: string[] };
type FactCheckResult = { body: string; patches: FactPatch[]; durationMs: number };
type FactCheckInput = {
  question: string;
  history: unknown;
  context: unknown;
  body: string;
  evidence: unknown;
  receipts: Array<{ id: string; tool: string; input: unknown; output?: unknown; error?: string }>;
};
```

- [ ] 先写失败测试：目录支持的计数与原值能到达校核、合法原文无补丁原样保留、补丁精确应用、不明引用/重复原文/重叠/空结果拒绝。
- [ ] HTTP 测试覆盖非思考参数、同一配置服务、取消、额度中文提示、其他错误不冒充额度、截断/坏 JSON 不误标校核完成。
- [ ] 实现纯输入整理与补丁验证，再实现可注入 fetch 的无工具模型请求；私有审计只记录公开结论与补丁，不记录隐藏思维。

## Task 3：默认关闭的运行时接入

**Files:** `agent/analytics-skill-run-turn.ts`、`agent/server.ts`、`agent/analytics-skill-evaluation.ts`、`app/lib/analytics/tool-names.ts`、`tests/analytics-skill-runtime.test.ts`。

- [ ] 新增显式 `ANALYTICS_FACT_CHECK=1` 开关，未设置保持现有路径；开发验收可显式打开，不暗改当前模型或推理配置。
- [ ] 在内存中收集本轮公开工具回执；SDK 最终正文完成后按开关校核，再用同一证据组装 v4。只传已有授权数据，不补查询或业务动作。
- [ ] 新增真实中文“核对回答依据”过程，记录完成/失败/取消及实际耗时；不把业务 MCP 工具增成第六个。
- [ ] 校核失败不得静默标为已核对成功；原稿留私有诊断，明确失败并允许重试。原额度中文提示和身份清洗保持有效。
- [ ] 测试开关关闭、一次 SDK、取消、无新 SQL、v4 图表绑定和对外身份清洗；运行 Node 22 相关测试与两端类型检查。

## Task 4：真实验收和启用

**Files:** `.env.example`、`.dev.vars.example`、`AGENTS.md`、`docs/superpowers/notes/2026-10-25-qa-quality-repair.md`；私有 `.dev.vars` 仅在达标后设置。

- [ ] 用原请求实测两道题与计数回归，另测两类资料已知对照；记录 SDK、全部 API、SQL、校核时延及最终审查。
- [ ] 检查失误是否真实修正、正确内容是否保留、自由回答是否仍能随任务变化；不要求固定 Skill 数、步骤或章节。
- [ ] 达标后才启用本地开关，重启 Agent 并验证真实 HTTP 与浏览器；未达标保留关闭并写明原因。
- [ ] 更新授权后的合同及实施记录，运行必要回归、类型、lint、构建与秘密检查；只做本地提交，不推送或部署。
