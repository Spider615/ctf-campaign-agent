# 营销分析图表与 HTML 渲染实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 用户已明确要求直接开始，连续执行，无需再次申请设计或计划确认。

**Goal:** 正常分析与文件问答按需生成有证据来源的图表，在过程和正文展示，并提供隔离 HTML 预览。

**Architecture:** 图表只保存结构化引用，纯 TypeScript 构建器从注册证据解析统一绘图数据。分析与文件工具创建不可变图表，流与结果保持相同校验，React 和受控 HTML 共用数据。

**Tech Stack:** Node 22 strip-types、TypeScript、React、现有 NDJSON、SVG 与隔离 iframe。

**Spec:** `docs/superpowers/specs/2026-10-16-analytics-visualization-design.md`

## Global Constraints

- 保留 `analysis-answer/v2` 和 `conversation-answer/v1`，可视化扩展使用 `analysis-visualization/v1`；无能力声明保留文字路径。
- 共享模块不引入 React、Cloudflare 或 npm 依赖；文案和代码注释使用中文。
- 数值来自真实证据，缺失不补零、不同单位不混画、堆叠仅接受完整可加总分组。
- 最多六张图、四个系列、三十个条形分类、每系列三百六十六个趋势点；只限制展示，完整分析证据不裁剪。
- 阶段图使用代码标题与边界，最终图进入独立复核；失效证据撤回，取消不伪装完成。
- 用户已有未提交的分析与附件功能作为当前真实基线，不提交或覆盖无关工作；真实模型验收不自动执行。

## Review Focus

- 多维分组或比率操作可能为一个分类产生重复值，必须拒绝歧义，不能相加或覆盖。
- 比较期、币种、单位、快照和筛选不同必须在绘图前检查，并明确实际比较来源。
- 文件计算分页不能变成全表排名，计算结果身份不能由模型伪造。
- 同轮重试、快照恢复、对话切换及迟到事件不能污染另一轮图表。
- HTML 中业务名称包含结束标签或地址时仍只能是文字，不运行脚本、不加载远程内容。

### Task 1: 证据图表与受控 HTML

**Files:** 新建 `app/lib/analytics/visualization-types.ts`、`visualization.ts`、`visualization-html.ts`；新增 `tests/analytics-visualization.test.ts`。

**Interfaces:** `VisualizationSpec` 保存图形、位置、程序身份及分析操作或文件计算引用；`resolveAnalysisVisualization(spec, evidence)` 和 `resolveAttachmentVisualization(spec, calculations, sources)` 返回同一个 `ResolvedVisualization`。`visualizationHtml(data)` 与 `visualizationText(data)` 使用同一数据。

- [x] 写失败用例：分组金额与真实 fact 对应、null 不补零、未知事实/重复分类/错误币种拒绝、全量排序、非加总堆叠拒绝、HTML 转义。
  ```ts
  assert.deepEqual(resolveAnalysisVisualization(spec, evidence).series[0].values.map(v => v.value), [120, null]);
  assert.throws(() => resolveAnalysisVisualization(spec, mixedCurrencyEvidence), /币种|单位|口径/);
  ```
- [x] 运行 `PATH=/Users/hukui/.nvm/versions/node/v22.23.1/bin:$PATH node --test --experimental-strip-types tests/analytics-visualization.test.ts`；预期先因新功能缺失失败。
- [x] 实现严格引用解析、数据生成、范围/排序/展示上限与纯 HTML/SVG 模板；同源页面内不插入模型 HTML。
- [x] 重跑上述测试，预期全部通过；使用同一格式函数生成纯文本数据表。

### Task 2: 分析运行时和复核

**Files:** 修改分析类型、证据选择与格式模块、`agent/general-analytics-run-turn.ts`、提示词、复核支持与缓存；新增 `tests/analytics-visualization-runtime.test.ts`。

**Interfaces:** `AnalysisDraft.visualizations?` 为已创建的图表引用集合；可选 `present_analysis_chart` 只接受证据选择与展示参数。最终输出从注册表选取所有绘图依赖，`analysisReviewClaims` 为图表增加实际审阅项。

- [x] 写失败用例：脚本假 SDK 取得真实操作后创建图表，阶段事件与最终数据一致；伪造 id 和改源被拒；修改图后不能复用旧复核。
  ```ts
  assert.equal(answer.visualizations?.items.length, 1);
  assert.ok(analysisReviewClaims(answer, answer.evidence).some(c => c.source.startsWith('visualization:')));
  ```
- [x] 运行对应运行时与复核测试，预期缺少工具或扩展而失败。
- [x] 接图表注册表、阶段事件、范围/快照撤回、最终核验与独立审阅；无可视化能力仍保持原合同。
- [x] 运行新测试及既有 `analysis-v2-runtime`、`analysis-v2-evidence`、`analysis-v2-review` 测试，预期通过。

### Task 3: 文件计算图表

**Files:** 修改 `agent/attachments/tools.ts`、`run-turn.ts`、`http.ts` 与 `app/lib/attachments/{types,answer}.ts`；新增文件图表测试。

**Interfaces:** `calculate_attachment` 注册完整 `AttachmentCalculation`，返回 `calculationId`，`present_analysis_chart` 从已授权计算集合生成图表。文件答案的可选扩展保存真实计算和图表，恢复时核验来源。

- [x] 写失败用例：有多页分组的表格仍按完整结果选择前列；错误计算 id、文件版本、任意值与混合币种均不能绘图。
  ```ts
  assert.equal(calculation.groupCount, allGroups.length);
  assert.equal(chart.categories[0].label, '真实最大分组');
  ```
- [x] 运行文件图表测试，预期因计算注册/绘图缺失失败。
- [x] 在全表确定性运算时登记完整结果，接现有授权、取消、失效与独立文件复核，不从摘录反推值。
- [x] 运行图表测试及 `attachments-agent`、`attachments-answer`、`attachments-files`、`attachments-http`，预期通过。

### Task 4: 能力协商和过程生命周期

**Files:** 修改 Node/Workers HTTP 边界、`stream.ts`、客户端请求与会话状态；新增过程协议测试。

**Interfaces:** `X-Analytics-Visuals: analysis-visualization/v1` 在所有路径转交；`visualization` 事件使用请求身份、epoch、revision、upsert/retract。`HistoryMessage` 保存经过验证的阶段内容，最终状态由完整答案决定。

- [x] 写失败用例：能力头转交、旧客户端无新增事件、UTF-8 与终态分块、重复/乱序修订、快照撤回、取消/重试/切换对话。
  ```ts
  assert.throws(() => reduceVisualizationProgress(state, conflictingRevision), /修订|重复/);
  assert.equal(reduceVisualizationProgress(state, retract).items.length, 0);
  ```
- [x] 运行流和客户端测试，预期新增事件或头尚不支持而失败。
- [x] 实现规范事件解析与状态归属；超长预览延后最终分块，保留全部证据。
- [x] 运行新流测试、既有 stream/http/client/unified-conversation 测试，预期通过。

### Task 5: 页面展示与完整回归

**Files:** 新建图表卡片与 HTML 预览组件；修改分析/文件/阶段消息及共用查看区；新增图表 UI 测试，更新相关界面合同。

**Interfaces:** 图表卡片只接收 `ResolvedVisualization`；表格与原生 SVG、HTML 使用同一数据，来源沿用当前查看区，阶段与最终状态清晰区分。

- [x] 写失败用例：图文按位置展示、缺值/负数/长标签、HTML sandbox 与 CSP、文字表和来源入口、阶段未完成提示。
  ```ts
  assert.match(markup, /sandbox=""/);
  assert.match(markup, /查看数据/);
  ```
- [x] 运行 UI 测试，预期组件与插图缺失失败。
- [x] 实现图表交互、可访问数据表、隔离 HTML、展开与来源、恢复和失效提示；保持文字可选。
- [x] 运行 `npm test`、根/Agent TypeScript、`npm run lint`、`npm run build`；预期均通过。
- [x] 用虚构结果验证桌面与移动端真实页面，并在浏览器验证 HTML 无脚本、网络和主页面访问能力，保留截图和结果。
- [x] 以独立上下文进行最终代码评审，修复实质问题后重新验证。更新设计/计划实际完成状态，汇报验证边界。

## 实施与验证结果

已完成五项任务，保留当前工作区改动。完整测试共 772 项，771 通过、1 跳过、0 失败；页面和 Agent 类型检查、Lint、生产构建通过。真实 Node → Workers → 客户端验证图表预览与最终结果；独立评审的三项问题均完成回归与复核。桌面与手机用合成数据验证，HTML 脚本及网络探针被 CSP 拦截，跨文档读取被 sandbox 拦截。未调用真实模型，未部署。

实施时采用固定的 SVG、图例、说明和数据表 HTML 模板，标题由代码生成；多图按正文位置排列。文件与经营图表的最终放置由服务端建立明确清单，UI 与独立复核共用同一个解析器。
