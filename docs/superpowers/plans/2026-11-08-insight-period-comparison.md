# 七夕相对可比平日的变化分析实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 选择七夕或自定义时段后，呈现相对同店同星期历史基准的变化和相关观察，替换门店横向规模的宏观结论。

**Architecture:** 将匹配、金额计算和变化图谱分别放在独立纯函数模块。Agent 范围请求继续读取参数化的范围聚合，并复用全月门店日面板作为对照；页面、详情和问图共同读取新图谱的对照元数据。全月构建与已有快照不变。

**Tech Stack:** TypeScript、Node 22 strip-types、node:test、React、现有只读 MySQL 聚合和缓存。

---

## 工作区和验证

在当前已建立的 `codex/insight-period-comparison` 功能分支实施，保留用户原有 `agent/package-lock.json` 修改。Node 使用 `/Users/jerry/.nvm/versions/node/v22.23.1/bin/node`；npm、tsc、构建时把该目录置于 PATH 开头。

基线：相关 60 项测试通过。设计已由用户确认，后续按技能要求使用独立实现与评审子任务，连续执行，不再逐步请求许可。

## 文件职责

- 新建 `app/lib/insight/comparison.ts`：同店同星期匹配、有效样本、逐分金额、变化与拆解、分组汇总。
- 新建 `app/lib/insight/comparison-graph.ts`：从可比样本生成图谱节点、关系、卡片、默认结论和对照说明。
- 修改 `app/lib/insight/types.ts`：可选对照元数据、KPI 对照、变化拆解与同期观察的关系类型；尽量复用已有节点 id。
- 修改 `agent/insight-graph.ts`：保留原聚合参数合同；按数据版本复用全月面板；范围进入新构建器，全月仍进 `buildDriverGraph`。
- 修改 `app/components/insight/{insight-workspace,insight-graph-view,insight-side-panel}.tsx`：显示专题、对照、覆盖，适配较小图的排版，区别观察和贡献。
- 修改 `app/lib/insight/{ask,context}.ts`：向问图与智能问答传递本期、基准、覆盖和重叠边界。
- 新建 `tests/insight-comparison.test.ts`，扩展 Agent、问答和上下文测试；保留全月快照。

## 任务 1：完成可比样本到页面的纵向实现

- [x] 写可比样本的失败测试并运行，确认缺少匹配与拆解行为时失败。

  测试用真实纯函数和合成门店日，不调用模型。固定场景包含两家规模相差十倍、七夕同幅增长的店，以及周末固定较高但无额外增长的店。匹配条件为目标日前、非节日、铺开前、同店同星期至少两天；测试缺一条不够、缺字段不补零、未来记录排除、负毛利保留。

  金额守恒断言形状：

  ```ts
  assert.equal(parts.ordersCents + parts.aovCents, actual.salesCents - reference.salesCents);
  assert.equal(parts.revenueCents + parts.marginCents, actual.gpCents - reference.gpCents);
  ```

- [x] 实现可比计算。候选日先建 `store + weekday` 索引，避免逐条目标记录扫描全月面板；每个匹配单元的金额均值取整到分。保留匹配日期集合和覆盖；本期与基准来自同一组目标门店日。分组至少 9 家店，对照值不大于零时不写变化率。销售额与毛利采用两因素对称拆解，末项吸收逐分取整余差。
- [x] 运行纯计算测试直至通过。

  ```sh
  /Users/jerry/.nvm/versions/node/v22.23.1/bin/node --test --experimental-strip-types tests/insight-comparison.test.ts
  ```

- [x] 增加图谱及服务失败测试：范围图包含可比样本、标题和基准；不再给出「门店规模解释度」默认结论；无对照仍是专题且不给数字；全月未出现对照元数据。验证同范围并发只算一次、对照面板按版本复用、失败可重试。
- [x] 实现图谱构建和服务接入。范围内事实和全月基准分开命名，复用全月缓存，不执行额外模型请求；对照面板加载也遵守原查询并发和排队限制。图谱只返回聚合依据，不把完整面板交给浏览器。
- [x] 接入页面。主标题、默认侧栏、KPI 比较和图例使用同一对照元数据；无分数的同期观察不进入旧解释度排名。图布局只在对照模式调整，不能依赖被移除节点的位置。
- [x] 增加问答及上下文失败测试，再实现证据传递。整图跳转也保留范围与比较目标；所选节点不存在时不让详情陷入空白。明示七夕与全国克减重叠，不能把算式贡献说成因果贡献。
- [x] 验证整条相关链路与类型。

  ```sh
  node --test --experimental-strip-types tests/insight-*.test.ts
  npx tsc --noEmit
  npx tsc -p agent/tsconfig.json
  ```

- [x] 自检并仅提交本任务文件，保留用户既有锁文件修改。

## 任务 2：独立评审和真实页面验收

- [x] 独立规格评审：逐条核对已确认设计，特别检查同口径样本、缺失、周末、毛利率分母与节日/活动边界；修复后重新评审。
- [x] 规格通过后独立代码质量评审：检查退化输入、缓存失败和并发、性能、类型、旧合同兼容。重要问题在完成前修复。
- [x] 检查现有本地服务，按需用 Node 22 启动页面和 Agent；不输出凭据。以真实只读缓存验证七夕范围与全月。
- [x] 浏览器确认专题标题、实际值与可比样本、对照日期、重叠说明、节点/线详情、全月切换及缺对照范围。保留必要截图在仓库外。
- [x] 运行完整单测、lint、构建和 diff 检查。只在新改动或失败需要时重复检查。
- [x] 将设计状态和计划勾选更新为实际结果；报告完成内容、验证和未部署状态。


## 2026-11-08 验收记录

- 实现提交 `59ec991`，缺失实际指标修复 `bf935bb`，完整上下文分片修复 `c818c6a`。
- 独立规格评审与代码质量评审均通过；发现的两项 P2（缺失毛利被显示为零、上下文单项超过 500 的请求拒绝）已加真实回归并修复。
- 最终完整单测：1,356 项，1,355 通过、1 跳过、0 失败；前端和 Agent 类型检查、全局 lint、构建、diff 检查通过。全月固定快照未变。
- 真实私有缓存与独立 Decimal 计算逐分一致；整图、全部节点及连线共 25 种上下文均通过真实请求守卫，最多 5 片、每片不超过 500 个 UTF-16 单元。未调用模型。
- 浏览器已验证七夕专题、全期值与可比样本、对照日期和覆盖、活动详情、全月切换、无对照范围与旧节点链接回概览；截图保存在仓库外。
- 字段命名澄清：本版门店类型分组采用源字段「铺型」，页面明确标为「铺型」，不与「零售体验描述」对应的店型混称。
- 非阻塞性能项：冷范围仍沿用既有完整聚合查询，部分聚合结果在新比较图中不再使用；本次保留原查询及缓存合同，未扩大为查询优化。
- 本地预览已更新；未推送、未部署；用户原有锁文件修改保留。
