import type { AnalysisCapabilities } from "../analysis-v2-types.ts";
import type { PlanGoal, PlanIntent, PlanKind, PlanNode } from "./types.ts";
import { SEMANTIC_DIMENSIONS, type SemanticDimensionId } from "../semantic/model.ts";

// 计划即程序的分步提示词：模型只写计划、正文和复核意见，数字由代码按引用从执行结果填入。
const cut = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;
// 维度取值超过这个数只给示例。
const MAX_LISTED_VALUES = 60;
const BASIS: Record<string, string> = { schema: "字段", data: "数据", business: "业务", assumption: "待确认" };

// 能力目录压缩成每行一项，真实 36 维目录控制在 6000 字以内。
export function capabilityBrief(capabilities: AnalysisCapabilities): string {
  const lines: string[] = [`数据：${capabilities.name}；覆盖 ${capabilities.coverage.start} 至 ${capabilities.coverage.end}；币种 ${capabilities.currency}`];
  lines.push("维度（id|名称|筛选键|上级|参与扫描|取值）：筛选值必须照抄下面列出的原值。");
  const catalog = capabilities.dimensionCatalog ?? capabilities.dimensions.map((id) => {
    const item = SEMANTIC_DIMENSIONS[id as SemanticDimensionId];
    return { id, label: item?.label ?? id, filter: item?.filter ?? id, parent: item?.parent && capabilities.dimensions.includes(item.parent) ? item.parent : undefined, scan: item?.scan ?? false };
  });
  for (const item of catalog) {
    const values = "values" in item && Array.isArray(item.values) ? item.values : undefined;
    // 取值少的全列出，模型照抄原值；多的只给个数和示例，写错时由校验给出最接近的值。
    const listed = !values ? "" : values.length <= MAX_LISTED_VALUES ? `|取值：${values.join("、")}` : `|共 ${values.length} 个取值，例如：${values.slice(0, 5).join("、")}`;
    lines.push(`${item.id}|${item.label}|${item.filter}|${item.parent ?? ""}|${item.scan ? "是" : "否"}${listed}`);
  }
  lines.push("指标（id|名称|口径|定义）：");
  for (const metric of capabilities.metrics) {
    const controls = metric.requiredControls.length ? `；须控制 ${metric.requiredControls.join("、")}` : "";
    lines.push(`${metric.id}|${metric.label}|${metric.allowedPopulations.join("/")}${metric.basis ? `，${BASIS[metric.basis] ?? metric.basis}` : ""}|${cut(metric.definition, 60)}${controls}`);
  }
  if (capabilities.baselines?.length) {
    lines.push("基线：");
    for (const baseline of capabilities.baselines) lines.push(`${baseline.id}|${baseline.label}|${cut(baseline.how, 60)}`);
  }
  if (capabilities.scenarios?.length) lines.push(`情景规则：${capabilities.scenarios.join("、")}`);
  if (capabilities.limitations.length) lines.push(`数据限制：${capabilities.limitations.map((item) => cut(item, 60)).join("；")}`);
  return lines.join("\n");
}

const SCOPE_EXAMPLE = `{"period":{"start":"2025-08-23","end":"2025-08-29"},"population":"sales","filters":{"regions":["华南"]}}`;
const OPERATORS = [
  `measure：读一个范围的指标，可按维度分组。{"id":"m1","op":"measure","scope":${SCOPE_EXAMPLE},"metrics":["amount","orders"],"by":["category"]}`,
  `contrast：目标与参照同口径比较，得出差额和变化。{"id":"c1","op":"contrast","target":${SCOPE_EXAMPLE},"reference":{"period":{"start":"2025-08-01","end":"2025-08-22"},"population":"sales","filters":{"regions":["华南"]}},"metrics":["amount_per_day"],"align":{"commonStores":true}}`,
  `decompose：把 contrast 的实收变化拆成件数与单价等贡献。{"id":"d1","op":"decompose","of":"c1"}`,
  `drill：沿上下级逐层下钻。{"id":"r1","op":"drill","of":"c1","path":["region","district"]}`,
  `scan：按多个维度找偏离最大的分组；不写 dimensions 时扫描全部可扫描维度。{"id":"s1","op":"scan","of":"c1","dimensions":["category","memberSegment"],"top":5}`,
  `robust：检查结论是否被最大门店、最大订单、前后半段或替代窗口改变。{"id":"k1","op":"robust","of":"c1","checks":["largest_store","halves"]}`,
  `scenario：在 measure 的总体实收上做优惠假设测算。{"id":"z1","op":"scenario","of":"m1","adjustment":{"kind":"per_item","amount":"20"},"netVolumeChanges":["0","0.05"],"reason":"说明为什么用这些假设以及保持不变的条件"}`,
];

// 问题类型与计划骨架，照抄方法论第十章（二）的表；只作参考，问题本身更具体时以问题为准。
export const KIND_LABEL: Record<PlanKind, string> = { lookup: "查数", review: "复盘", attribution: "归因", mechanism: "机制比较", scenario: "方案测算", opportunity: "找机会" };
const KIND_SKELETON: Array<[PlanKind, string, string]> = [
  ["lookup", "8 月卖了多少", "单个 measure，不问目标"],
  ["review", "七夕活动效果怎么样", "按目标选主指标 → 天然对照 contrast（共同门店、日均）→ decompose → scan → 活动前后窗口 → robust"],
  ["attribution", "为什么华南跌了", "contrast → drill 大区 / 分区 → decompose；跨期时加每克牌价对比"],
  ["mechanism", "克减和满减哪个好", "先问目标（本流程不能中途追问：按问法推断目标，并在回答开头说明）；同货类、同材料、按克重或价位段对齐后 contrast，主指标和护栏指标一起看"],
  ["scenario", "每克再减 10 元会怎样", "同范围 measure 作基线 + scenario"],
  ["opportunity", "下次活动往哪推", "按场、货 scan + robust，只产出候选，不产出结论"],
];
// 活动目标 → 主指标 / 护栏指标，照抄方法论第三章；指标 id 用语义层已有的。
export const GOAL_LABEL: Record<PlanGoal, string> = { frequency: "提高到店频次", basket: "提高客单", series: "推重点系列或新品", revenue: "冲业绩", profit: "保利润", acquisition: "拉新", none: "不涉及目标" };
export const GOAL_METRICS: Record<Exclude<PlanGoal, "none">, { primary: string; guard: string }> = {
  frequency: { primary: "日均订单 orders_per_day", guard: "非活动日的 orders_per_day（非活动日有没有被挖空；活动日 / 非活动日的写法见下）" },
  basket: { primary: "单均实收 amount_per_order、件均实收 amount_per_item；要看件均克重时在同一节点里分别取 grams 和 quantity，在正文里用文字说明克重和件数各自的变化，不要自己相除", guard: "毛利率 margin_rate" },
  series: { primary: "重点系列占比（按 keySeries 分组的 amount 占比）", guard: "整体实收 amount" },
  revenue: { primary: "日均实收 amount_per_day", guard: "毛利率 margin_rate" },
  profit: { primary: "零售毛利 profit、毛利率 margin_rate", guard: "件数 quantity" },
  acquisition: { primary: "新会员数（数据里没有，标为测不了）", guard: "无" },
};
const GOAL_SHORT: Record<Exclude<PlanGoal, "none">, string> = {
  frequency: "主指标日均订单，护栏非活动日的日均订单",
  basket: "主指标单均实收和件均实收，护栏毛利率",
  series: "主指标重点系列实收占比，护栏整体实收",
  revenue: "主指标日均实收，护栏毛利率",
  profit: "主指标毛利和毛利率，护栏件数",
  acquisition: "主指标新会员数，数据里没有，测不了",
};

const JUDGE = [
  "### 先判断",
  "写节点之前先判断问题类型和活动目标，再按类型取计划骨架。",
  "问题类型（下表是参考骨架；问题本身问得更具体时以问题为准，节点上限仍是 12）：",
  "| 类型 | kind | 典型问法 | 骨架要点 |",
  "| --- | --- | --- | --- |",
  ...KIND_SKELETON.map(([kind, ask, skeleton]) => `| ${KIND_LABEL[kind]} | ${kind} | ${ask} | ${skeleton} |`),
  "活动目标：用户说了就按用户说的；没说时从活动名和问法推断最可能的目标；查数类和不涉及目标的问题 goal 为 none。用户在追问里纠正了目标，按纠正后的目标重新判断。目标决定主指标和护栏指标，计划里两者都要算：",
  ...(Object.entries(GOAL_METRICS) as Array<[Exclude<PlanGoal, "none">, { primary: string; guard: string }]>).map(([goal, item]) => `- ${goal}（${GOAL_LABEL[goal]}）：主指标 ${item.primary}；护栏 ${item.guard}`),
  `活动日 / 非活动日没有单独的维度：优惠活动用 offers 筛选，目标为该活动的 offer，参照为同期的「一般開單」，并在 align.controls 里控制 dayType（或两边固定同一 dayTypes）；节庆类活动用 festivals 对照，目标为该节庆，参照为「非节庆」。例如 {"id":"c1","op":"contrast","target":{"period":{"start":"2025-08-01","end":"2025-08-31"},"population":"sales","filters":{"offers":["活动的优惠原值"]}},"reference":{"period":{"start":"2025-08-01","end":"2025-08-31"},"population":"sales","filters":{"offers":["一般開單"]}},"metrics":["orders_per_day"],"align":{"commonStores":true,"controls":["dayType"]}}；节庆把 filters 换成 {"festivals":["七夕"]} 对 {"festivals":["非节庆"]}。取值照抄能力目录里的原值。`,
  "提交时在 plan 里写 intent: { kind, goal, reason }，reason 用一句话说明为什么这样判断（缺数据时写明缺什么）。",
  "机制比较（mechanism）必须对齐货：对比的目标和参照固定同一组货类（categories）和材料（materials），或在 align.controls 里控制 category、material。原因是不同优惠吸引来的货不同，例如克减 50 的件均克重是克减 30 的 3 倍，不对齐时比出来的主要是吸引来的货，不是优惠本身。",
  "缺数据不硬答（原则 A）：先看能力目录。问题要的维度或指标不在目录里（例如会员等级、会员 ID、活动费用、客流）时，不用相近维度凑出原问题的结论（例如问会员等级，不拿会员 / 非会员的对比顶替）；计划先算能确定的事实（例如整体的对比、会员销售占比），相近维度的数据可以算来补充，但它回答不了原问题，并在 intent.reason 里写明缺什么。以目录为准判断，目录里有的就正常算。会员分组（memberSegment）不等于会员等级，只有它的定义里明确写了等级时才能当等级用。",
].join("\n");

export type PreviousPlan = { nodes: PlanNode[]; dropped: Array<{ id: string; reason: string }>; intent?: PlanIntent };

// previous：复核退回时上一版已接受的节点和被丢弃的节点，供修改时对照。
// followup：补充计划步骤复用算子、规则和能力目录，不再重新判断问题类型，沿用主计划的 intent。
export function planPrompt(question: string, context: string[], brief: string, issues: string[], previous?: PreviousPlan, options: { followup?: PlanIntent } = {}): string {
  const followup = options.followup;
  return [
    "## 本步：写分析计划",
    followup ? `沿用主计划的问题类型和目标：${followup.kind}/${followup.goal}。代码会校验并执行计划，你不需要也不能自己算数。` : "把原问题拆成一份声明式计划，调用 submit_plan({ plan: { question, intent, nodes } }) 提交。代码会校验并执行计划，你不需要也不能自己算数。",
    followup ? "" : JUDGE,
    "### 算子与示例",
    ...OPERATORS.map((item) => `- ${item}`),
    "### 规则",
    "- 范围的 filters 只能用能力目录里维度的筛选键（如 regions、categories、festivals），取值写业务原值；分区写作「大区/分区」。",
    "- population 取 sales、net、returns、recovery、zero_sales，指标须适用于所选口径；标了「须控制」的指标要在范围中固定为单值或放进 by / align.controls。",
    "- 不同天数的窗口用 amount_per_day 等日均指标比较。decompose、drill、scan、robust、scenario 必须用 of 引用前面已声明的节点。",
    "- 节点只写当前问题真正需要的，最多 12 个；id 用字母数字。计划里不写结论。",
    "- 数据覆盖不到、目录里没有的维度或指标不要硬凑，按原则 A 只算能确定的事实，后面在回答里直接说明缺什么。",
    "- 问「有多少个活动 / 门店 / 货品」时，按对应维度分组的 measure 会给出分组个数（distinct_count），一个节点就够；不要为了个数再拆别的对比。",
    `### 能力目录\n${brief}`,
    `### 原问题\n${question}`,
    context.length ? `### 用户此前说过\n${context.map((item) => `- ${item}`).join("\n")}` : "",
    previous ? `### 上一版计划\n在这一版基础上按下面的问题修改，重新提交完整计划（含 intent）。${previous.intent ? `\n上一版 intent：${JSON.stringify(previous.intent)}` : ""}\n已接受节点：${JSON.stringify(previous.nodes)}${previous.dropped.length ? `\n被丢弃节点：\n${previous.dropped.map((item) => `- ${item.id}：${item.reason}`).join("\n")}` : ""}` : "",
    issues.length ? `### 需要修正的问题\n${issues.map((item) => `- ${item}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

const contextBlock = (context: readonly string[], hint = "") => context.length ? `### 用户此前说过\n${context.map((item) => `- ${item}`).join("\n")}${hint}` : "";

// 写正文：模型按问题自由组织 Markdown，数字一律写成引用，由代码从执行结果填值。
// summary 是 executionSummary 的输出，每行开头就是可以照抄的引用。
// intent 是计划里判断的问题类型和目标；goal 为 none 时不要求写目标说明。
export function intentLine(intent?: PlanIntent): string {
  if (!intent) return "";
  const goal = intent.goal === "none" ? "不涉及活动目标" : `目标 ${GOAL_LABEL[intent.goal]}（${GOAL_SHORT[intent.goal]}）`;
  return `本题按${KIND_LABEL[intent.kind]}处理，${goal}${intent.reason ? `：${intent.reason}` : ""}`;
}

export function answerPrompt(question: string, summary: string, context: readonly string[] = [], intent?: PlanIntent): string {
  // acquisition 的主指标（新会员数）数据里没有：不写目标前缀，按原则 A 说明测不了。
  const goal = intent && intent.goal !== "none" && intent.goal !== "acquisition" ? intent.goal : undefined;
  return [
    "## 本步：写回答",
    "你是周大福的营销顾问，正在回复业务同事刚才问的问题。根据下面的执行结果写一段 Markdown 正文，调用 submit_answer({ body }) 提交。口径说明、出处和分析步骤由代码另外附上，正文只写回答本身。",
    "### 怎么说",
    "- 像当面回复同事那样说话，按这个问题本身来组织，不要套「结论 / 发现 / 建议」这类固定板块。",
    "- 第一句就回答问题：问「多少」「哪个最高」，第一句就是那个数或那个对象；复盘类先说整体好不好，再讲差在哪里；问要不要做、选哪个，先给推荐，再讲依据和风险；问哪里有机会，直接列几条带数据的发现，每条一句话说清对象和数。",
    "- 只写回答这个问题用得上的内容。问数字就给数字和必要的口径，不附建议；没有需要提醒的限制就不提；数据缺口只在影响这次答案时用一句话说清缺什么；缺的正是原问题要的维度或指标时，按下面的原则 A 回答。一两句能答完的问题，不加标题、不分点。",
    "- 第一句说整体或覆盖面大的规律。单个门店、商场这类个案再突出也只放在后面作为补充，并说明它只是个例。",
    "- 两段时间天数不同（例如节庆几天对比当月其他日子）时，比较日均实收、日均订单这类日均指标，不比实收、件数这些合计值；合计值的引用在这种情况下会被删掉。",
    "- 相关不写成因果：可以说「活动期间日均实收更高」，不说「活动带来了增长」。",
    "- 原问题需要的维度或指标不在执行结果和能力目录里时（原则 A，缺数据不硬答）：先直接说这个问题现有数据回答不了哪部分、为什么；再给能确定的事实；最后说补什么数据能回答到什么程度。不要拿相近维度凑出原问题的结论（例如说「非会员提升最明显」来回答哪个等级提升最明显），也不要只说一句「测不了」就结束。相近维度的数据可以放出来作补充，但要写明它不能回答原问题。下面例四只示意这三层，不是模板。",
    "- 用户要方案、规划、怎么做（例如「给我规划一个营销方案」「直接给完整方案」）时，先把方案给出来，不说「给不出方案」「只能给候选方向」「现有数据不能直接落地」这类话，也不把方案降格成「假设，待验证」。方案写清：做什么（主推品类、力度方向、重点区域或城市层级）、为什么（每条都用执行结果里的数字支撑）、要盯住什么风险（护栏）。数据缺口统一放在最后一段，用「要把方案做得更细，还需要补……」说清缺什么、补上能把哪一部分定下来。时间对不上（例如问 12 月、数据只有 8 月）时，用一句话说明方案参考的是哪段历史，照样给方案。原则 A 只管「问具体数据、库里没有这个维度」的情况，不适用于要方案的问题。",
    "- 原问题如果是在补充口径或回答上一轮的疑问，就按补充后的口径回答前面的问题；用户纠正了活动目标，就按纠正后的目标重新评估。",
    "- 正文控制在 600 字以内（引用按填好的数字计）。",
    goal ? `### 目标和护栏\n- 本题按「${GOAL_LABEL[goal]}」评估（${GOAL_SHORT[goal]}）。正文第一句以「按${GOAL_LABEL[goal]}看：」开头，后面直接接对原问题的回答；主指标和护栏放在正文里讲。用户觉得目标不对可以纠正。\n- 主指标和护栏指标的结果都要报；护栏恶化时（例如毛利率下降、非活动日被挖空）要明说，不能只报主指标的好消息。执行结果里没有护栏指标时，一句话说明护栏没算到。` : "",
    intent?.goal === "acquisition" ? "### 目标\n- 本题目标是拉新，主指标新会员数数据里没有：不写「按拉新看」这类前缀，按原则 A 先说明新会员数测不了及原因，再给能确定的事实，最后说补什么数据。" : "",
    "### 数字怎么写",
    "- 正文里凡是算出来的数字都写成引用，代码会按执行结果填值。写法：`{{节点.指标}}`、`{{节点.指标.角色}}`、`{{节点.指标|维度=取值}}`、`{{节点.指标.角色|维度=取值,维度=取值}}`。最稳妥的做法是照抄执行结果每行开头反引号里的那段引用。",
    "- 分组取值里有逗号、竖线、等号、引号或花括号时，取值要加双引号，例如 `{{m1.rows|offer=\"M-2月慶典（滿4,000 92折）\"}}`；执行结果里已经按需要加好引号，照抄即可。",
    "- 角色：value 数值、target 目标期、reference 参照期、delta 差额、change 变化率、deviation 偏离、share 占比、contribution 贡献。share 是这一组占总体的比例（例如非会员实收占全部实收的比例）；contribution 是这一组对差额的贡献（例如增量里有多少来自非会员），两者不能混用：说「占实收的比例」用 share，说「增量的来源」用 contribution。不写角色时，对比节点默认 delta，下钻和扫描默认 deviation，拆解默认 contribution，其余默认 value；不写分组时取总体行。",
    "- 填进去的值自带单位，差额、变化、偏离还带正负号（例如「+104.14%」「-12.00%」「1,234.56元」「442个」）。引用后面不要再写单位。带正负号的值前面用「变化」「比……」这类中性说法，或者用和正负一致的「高」「增长」；不要写「少 {{…}}」「下降 {{…}}」，否则负号会和字面意思叠成反话。",
    "- 不能自己算比例、倍数、差额或合计，也不要写「翻了一番」「涨了三成」「约一半」这类估算；要说幅度就引用 change、delta 或 share，执行结果里没有的数就不写。",
    "- 业务名称（如「H-克减30元」「东区/B区」）和用户原话里的日期、天数可以照写；其他数字只能用引用。写死数字的那一整句会被删掉。",
    "- 句子说的对象要和所引节点的说明（每段开头「# 节点：说明」）一致：说明是非会员，就不能写成会员；说明是工作日对比，就不能写成整月。",
    "- 对比节点的 delta、change 是「目标减参照」：先看执行结果里的正负，确认到底哪边更高，再写结论和推荐。正数是目标更高，负数是参照更高。",
    "- 只能引用执行结果里列出的行；不支持、失败的节点不能引用。稳健性检查只用文字说明结论稳不稳，不引用数字。",
    "### 表格和图",
    "- 块语法单独占一行：",
    "  - `::: table 节点 指标[,指标] [by 维度] [top N]`：一张表。对比节点列出目标、参照和变化（只取第一个指标）；分组统计、下钻、扫描节点按 by 维度列出各组，按第一个指标从高到低排。top 默认 6，最多 8 行。",
    "  - `::: chart 节点 指标 [by 维度] [top N]`：一张图。分组统计按数值画条形图，按日期（by day）画走势，下钻、扫描画偏离最大的几组。",
    "- 要比较三组以上、或用户想看排名、分布、走势时，用表或图比在句子里堆数字清楚；一两句能答完的问题不加表和图。表最多 3 个，图最多 2 个。",
    "- 块的前一句说清读者该看什么；块里已经有的数字不用在句子里再报一遍。块里的节点、指标、维度只能用执行结果里出现过的 id。",
    "### 组织方式随问题变化",
    "下面四个例子只示意不同问题怎么组织，不是模板。示例里的 m1、c1 等只是示意，本题的节点 id 以执行结果每段开头的「# 节点：说明」为准；指标和取值也以执行结果为准。",
    "例一，问「库里有多少个活动」——一句话给数，不加别的：\n```\n库里有成交的活动共 {{m1.distinct_count}}。\n```",
    "例二，问「七夕卖得怎么样，和八月其他日子比」——先说整体，再看差在哪：\n```\n和八月其他日子比，七夕期间日均实收变化 {{c1.amount_per_day.change}}，日均订单变化 {{c1.orders_per_day.change}}。\n\n分大区看，各区相对整体的偏离如下：\n\n::: table r1 amount_per_day by region\n\n偏离最大的是南区，{{r1.amount_per_day|region=南区}}。\n```",
    "例三，问「两个满减档哪个值得继续做」——先给推荐，再讲依据和风险：\n```\n建议优先保留高档：同店同期比较，高档的单均实收比低档 {{c2.amount_per_order.delta}}。\n\n风险在单数：高档的成交单数比低档 {{c2.orders.change}}，铺开前先在几家店试一轮，看单数能不能稳住。\n```",
    "例四，问「七夕对不同等级会员影响有什么不同」，数据只有会员 / 非会员、没有会员等级——先说答不了及原因，再给能确定的事实，最后说补什么：\n```\n不同等级会员的差异现有数据回答不了：销售记录只标了是否会员，没有会员等级。\n\n能确定的是七夕期间会员销售占实收 {{m1.amount.share|memberFlag=会员}}。\n\n如果补上每笔销售的会员等级，就能按等级对比七夕和平日的日均实收、单均实收，看哪一级变化最大；再补会员 ID，还能看复购。\n```",
    intent ? `### 本题判断\n${intentLine(intent)}` : "",
    `### 原问题\n${question}`,
    contextBlock(context),
    `### 执行结果\n${summary}`,
  ].filter(Boolean).join("\n\n");
}

// 复核时每个引用填进去的值和依据；value 缺省表示这个引用填不了值，所在句会被删掉。
export type ReviewRef = { ref: string; value?: string; issue?: string; basis: string };

export function answerReviewPrompt(question: string, context: readonly string[], body: string, refs: readonly ReviewRef[], intent?: PlanIntent): string {
  const goal = intent && intent.goal !== "none" && intent.goal !== "acquisition" ? intent.goal : undefined;
  return [
    "## 本步：复核回答",
    "你是独立复核员。下面是另一位顾问写给业务同事的正文，数字用 {{…}} 引用，交付时由代码填值；后面列出了每个引用会填进去的值和它的依据（节点说明和分组）。",
    "### 逐条检查",
    "- 答非所问：第一句有没有直接回答原问题；问「多少」时第一句是不是那个数。",
    "- 相关写成因果：「活动带来增长」「因为促销所以」这类说法要改成「活动期间……更高」。",
    "- 方向不一致：文字说「高」「增长」，引用值却是负数；文字说「低」「下降」，引用值却是正数。",
    "- 结论和数字对不上：对比节点的 delta、change 是「目标减参照」（依据里写了哪边是目标）。先看填值的正负判断到底是哪边更高，再看正文的结论、推荐、标题有没有说反。例如目标是 A、参照是 B，变化为负，就是 B 更高；正文却说「A 占优」「选 A 冲销售」，就要按数字改写结论。",
    "- 对象或对照期写错：文字说的人群、门店、时间段和依据里的范围不一致，例如依据是非会员写成会员、依据是工作日对比写成整月、对照期写成了别的月份。改写时对照期照依据里的写法。",
    "- 个案放在第一句、把单个门店或商场的表现当成整体结论。",
    goal ? `- 没写目标：第一句要以「按${GOAL_LABEL[goal]}看：」开头（${GOAL_SHORT[goal]}）。` : "",
    goal ? "- 护栏没提：只报了主指标，没提护栏指标的结果；护栏恶化却没说出来。" : "",
    "- 该给方案没给：用户要方案、规划、怎么做，正文却说「给不出完整方案」「只能给候选方向 / 待验证假设」「现有数据不能落地」，或把缺数据放在开头。应改写成先给方案（做什么、为什么、风险），每条带数据，缺什么数据放到最后一段说。",
    "- 拿相近维度凑结论（原则 A）：原问题要的维度数据里没有（例如问会员等级，数据只有会员 / 非会员），正文却用相近维度给出了原问题的对比结论。应改成先说答不了及原因，再给能确定的事实，再说补什么数据；也不能只剩一句「测不了」。",
    "### 提交",
    "调用 submit_answer_review({ verdict, body, notes }) 提交。没有问题时 verdict 为 ok，不写 body。有问题时 verdict 为 rewrite，body 写改好的完整正文：保留原有的 {{…}} 引用和 ::: 块，只改文字，不能新写数字。notes 写给用户看的简短复核说明，没有可以为空。",
    `### 原问题\n${question}`,
    contextBlock(context),
    intent ? `### 本题判断\n${intentLine(intent)}` : "",
    `### 正文（引用原样）\n${body}`,
    `### 引用填值与依据\n${refs.length ? refs.map((item) => `- ${item.ref} → ${item.value ?? `填不了值（${item.issue ?? "无法解析"}），所在句会被删掉`}｜依据：${item.basis}`).join("\n") : "（正文没有引用）"}`,
  ].filter(Boolean).join("\n\n");
}

// 计划复核；brief 附上能力目录，便于判断筛选键和指标是否可用。
export function planReviewPrompt(question: string, payload: string, brief?: string, context: readonly string[] = []): string {
  return [
    "## 本步：复核分析计划",
    "你是独立复核员。判断这份计划能不能回答原问题：范围和口径是否与原话一致、比较是否可比、有没有漏掉原问题要回答的事项、有没有多余节点。另外逐条检查：",
    "- intent 是否和问题一致：问题类型（lookup 查数、review 复盘、attribution 归因、mechanism 机制比较、scenario 方案测算、opportunity 找机会）和活动目标是否判断对了；查数类 goal 应为 none。",
    `- 主指标和护栏是否都在计划里：按目标对照——${(Object.keys(GOAL_SHORT) as Array<Exclude<PlanGoal, "none">>).map((goal) => `${goal} ${GOAL_SHORT[goal]}`).join("；")}。`,
    "- 机制比较是否对齐货：对比的目标和参照要固定同一货类和材料，或在 align.controls 里控制 category、material。",
    "- 是否拿相近维度凑原问题要的维度（原则 A）：例如问会员等级，计划把会员 / 非会员对比当作等级结论来算；目录里没有的维度要在 intent.reason 写明缺什么，相近维度的数据可以作补充。",
    "- 反过来，计划已经按原则 A 在 intent.reason 里写明缺了原问题要的维度时，不要以「回答不了原问题」为由退回；只要补上能确定的整体事实即可，相近维度的数据算不算由计划决定。",
    "调用 submit_plan_review({ verdict, issues }) 提交：计划可用时 verdict 为 ok、issues 为空；需要修改时 verdict 为 revise，issues 逐条写清要改什么。",
    brief ? `### 能力目录\n${brief}` : "",
    `### 原问题\n${question}`,
    // 洞察图谱带过来的范围说明了「这个关系」「这条线」指什么，不要因为原问题短就要求澄清。
    context.length ? `### 用户此前说过（原问题里的指代按这里理解）\n${context.map((item) => `- ${item}`).join("\n")}` : "",
    `### 计划\n${payload}`,
  ].filter(Boolean).join("\n\n");
}
