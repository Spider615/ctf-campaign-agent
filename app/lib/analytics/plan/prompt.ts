import type { AnalysisCapabilities } from "../analysis-v2-types.ts";
import type { PlanNode } from "./types.ts";
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

export type PreviousPlan = { nodes: PlanNode[]; dropped: Array<{ id: string; reason: string }> };

// previous：复核退回时上一版已接受的节点和被丢弃的节点，供修改时对照。
export function planPrompt(question: string, context: string[], brief: string, issues: string[], previous?: PreviousPlan): string {
  return [
    "## 本步：写分析计划",
    "把原问题拆成一份声明式计划，调用 submit_plan({ plan: { question, nodes } }) 提交。代码会校验并执行计划，你不需要也不能自己算数。",
    "### 算子与示例",
    ...OPERATORS.map((item) => `- ${item}`),
    "### 规则",
    "- 范围的 filters 只能用能力目录里维度的筛选键（如 regions、categories、festivals），取值写业务原值；分区写作「大区/分区」。",
    "- population 取 sales、net、returns、recovery、zero_sales，指标须适用于所选口径；标了「须控制」的指标要在范围中固定为单值或放进 by / align.controls。",
    "- 不同天数的窗口用 amount_per_day 等日均指标比较。decompose、drill、scan、robust、scenario 必须用 of 引用前面已声明的节点。",
    "- 节点只写当前问题真正需要的，最多 12 个；id 用字母数字。计划里不写结论。",
    "- 数据覆盖不到、目录里没有的维度或指标不要硬凑，后面在回答里直接说明缺什么。",
    "- 问「有多少个活动 / 门店 / 货品」时，按对应维度分组的 measure 会给出分组个数（distinct_count），一个节点就够；不要为了个数再拆别的对比。",
    `### 能力目录\n${brief}`,
    `### 原问题\n${question}`,
    context.length ? `### 用户此前说过\n${context.map((item) => `- ${item}`).join("\n")}` : "",
    previous ? `### 上一版计划\n在这一版基础上按下面的问题修改，重新提交完整计划。\n已接受节点：${JSON.stringify(previous.nodes)}${previous.dropped.length ? `\n被丢弃节点：\n${previous.dropped.map((item) => `- ${item.id}：${item.reason}`).join("\n")}` : ""}` : "",
    issues.length ? `### 需要修正的问题\n${issues.map((item) => `- ${item}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

const contextBlock = (context: readonly string[], hint = "") => context.length ? `### 用户此前说过\n${context.map((item) => `- ${item}`).join("\n")}${hint}` : "";

// 写正文：模型按问题自由组织 Markdown，数字一律写成引用，由代码从执行结果填值。
// summary 是 executionSummary 的输出，每行开头就是可以照抄的引用。
export function answerPrompt(question: string, summary: string, context: readonly string[] = []): string {
  return [
    "## 本步：写回答",
    "你是周大福的营销顾问，正在回复业务同事刚才问的问题。根据下面的执行结果写一段 Markdown 正文，调用 submit_answer({ body }) 提交。口径说明、出处和分析步骤由代码另外附上，正文只写回答本身。",
    "### 怎么说",
    "- 像当面回复同事那样说话，按这个问题本身来组织，不要套「结论 / 发现 / 建议」这类固定板块。",
    "- 第一句就回答问题：问「多少」「哪个最高」，第一句就是那个数或那个对象；复盘类先说整体好不好，再讲差在哪里；问要不要做、选哪个，先给推荐，再讲依据和风险；问哪里有机会，直接列几条带数据的发现，每条一句话说清对象和数。",
    "- 只写回答这个问题用得上的内容。问数字就给数字和必要的口径，不附建议；没有需要提醒的限制就不提；数据缺口只在影响这次答案时用一句话说清缺什么。一两句能答完的问题，不加标题、不分点。",
    "- 第一句说整体或覆盖面大的规律。单个门店、商场这类个案再突出也只放在后面作为补充，并说明它只是个例。",
    "- 两段时间天数不同（例如节庆几天对比当月其他日子）时，比较日均实收、日均订单这类日均指标，不比实收、件数这些合计值；合计值的引用在这种情况下会被删掉。",
    "- 相关不写成因果：可以说「活动期间日均实收更高」，不说「活动带来了增长」。",
    "- 原问题问到数据里没有的维度或指标时，先用最接近的现有数据回答，再一句话说明缺什么，不要因为缺一项就不回答。",
    "- 原问题如果是在补充口径或回答上一轮的疑问，就按补充后的口径回答前面的问题。",
    "- 正文控制在 600 字以内（引用按填好的数字计）。",
    "### 数字怎么写",
    "- 正文里凡是算出来的数字都写成引用，代码会按执行结果填值。写法：`{{节点.指标}}`、`{{节点.指标.角色}}`、`{{节点.指标|维度=取值}}`、`{{节点.指标.角色|维度=取值,维度=取值}}`。最稳妥的做法是照抄执行结果每行开头反引号里的那段引用。",
    "- 分组取值里有逗号、竖线、等号、引号或花括号时，取值要加双引号，例如 `{{m1.rows|offer=\"M-2月慶典（滿4,000 92折）\"}}`；执行结果里已经按需要加好引号，照抄即可。",
    "- 角色：value 数值、target 目标期、reference 参照期、delta 差额、change 变化率、deviation 偏离、share 占比、contribution 贡献。不写角色时，对比节点默认 delta，下钻和扫描默认 deviation，拆解默认 contribution，其余默认 value；不写分组时取总体行。",
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
    "下面三个例子只示意不同问题怎么组织，不是模板。示例里的 m1、c1 等只是示意，本题的节点 id 以执行结果每段开头的「# 节点：说明」为准；指标和取值也以执行结果为准。",
    "例一，问「库里有多少个活动」——一句话给数，不加别的：\n```\n库里有成交的活动共 {{m1.distinct_count}}。\n```",
    "例二，问「七夕卖得怎么样，和八月其他日子比」——先说整体，再看差在哪：\n```\n和八月其他日子比，七夕期间日均实收变化 {{c1.amount_per_day.change}}，日均订单变化 {{c1.orders_per_day.change}}。\n\n分大区看，各区相对整体的偏离如下：\n\n::: table r1 amount_per_day by region\n\n偏离最大的是南区，{{r1.amount_per_day|region=南区}}。\n```",
    "例三，问「两个满减档哪个值得继续做」——先给推荐，再讲依据和风险：\n```\n建议优先保留高档：同店同期比较，高档的单均实收比低档 {{c2.amount_per_order.delta}}。\n\n风险在单数：高档的成交单数比低档 {{c2.orders.change}}，铺开前先在几家店试一轮，看单数能不能稳住。\n```",
    `### 原问题\n${question}`,
    contextBlock(context),
    `### 执行结果\n${summary}`,
  ].filter(Boolean).join("\n\n");
}

// 复核时每个引用填进去的值和依据；value 缺省表示这个引用填不了值，所在句会被删掉。
export type ReviewRef = { ref: string; value?: string; issue?: string; basis: string };

export function answerReviewPrompt(question: string, context: readonly string[], body: string, refs: readonly ReviewRef[]): string {
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
    "### 提交",
    "调用 submit_answer_review({ verdict, body, notes }) 提交。没有问题时 verdict 为 ok，不写 body。有问题时 verdict 为 rewrite，body 写改好的完整正文：保留原有的 {{…}} 引用和 ::: 块，只改文字，不能新写数字。notes 写给用户看的简短复核说明，没有可以为空。",
    `### 原问题\n${question}`,
    contextBlock(context),
    `### 正文（引用原样）\n${body}`,
    `### 引用填值与依据\n${refs.length ? refs.map((item) => `- ${item.ref} → ${item.value ?? `填不了值（${item.issue ?? "无法解析"}），所在句会被删掉`}｜依据：${item.basis}`).join("\n") : "（正文没有引用）"}`,
  ].filter(Boolean).join("\n\n");
}

// 计划复核；brief 附上能力目录，便于判断筛选键和指标是否可用。
export function planReviewPrompt(question: string, payload: string, brief?: string): string {
  return [
    "## 本步：复核分析计划",
    "你是独立复核员。判断这份计划能不能回答原问题：范围和口径是否与原话一致、比较是否可比、有没有漏掉原问题要回答的事项、有没有多余节点。",
    "调用 submit_plan_review({ verdict, issues }) 提交：计划可用时 verdict 为 ok、issues 为空；需要修改时 verdict 为 revise，issues 逐条写清要改什么。",
    brief ? `### 能力目录\n${brief}` : "",
    `### 原问题\n${question}`,
    `### 计划\n${payload}`,
  ].filter(Boolean).join("\n\n");
}
