import type { AnalysisCapabilities } from "../analysis-v2-types.ts";
import type { PlanNode } from "./types.ts";
import { SEMANTIC_DIMENSIONS, type SemanticDimensionId } from "../semantic/model.ts";

// 计划即程序的分步提示词：模型只写计划、措辞和复核意见，数字由代码查出并绑定。
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
    "- 数据覆盖不到、目录里没有的维度或指标不要硬凑，后面在结论里直接说明缺什么。",
    "- 问「有多少个活动 / 门店 / 货品」时，按对应维度分组的 measure 会给出分组个数（distinct_count），一个节点就够；不要为了个数再拆别的对比。",
    `### 能力目录\n${brief}`,
    `### 原问题\n${question}`,
    context.length ? `### 用户此前说过\n${context.map((item) => `- ${item}`).join("\n")}` : "",
    previous ? `### 上一版计划\n在这一版基础上按下面的问题修改，重新提交完整计划。\n已接受节点：${JSON.stringify(previous.nodes)}${previous.dropped.length ? `\n被丢弃节点：\n${previous.dropped.map((item) => `- ${item.id}：${item.reason}`).join("\n")}` : ""}` : "",
    issues.length ? `### 需要修正的问题\n${issues.map((item) => `- ${item}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

// context：用户此前说过的话。追问（如「每个活动 id 算一个」）只有和前面的问题连起来才知道要答什么。
export function claimsPrompt(question: string, summary: string, context: readonly string[] = []): string {
  return [
    "## 本步：写结论",
    "根据执行结果写给业务人员看的分析，调用 submit_claims 提交 { headline, claims, actions, cannotConclude, questions }。关键数据表、图表和口径说明由代码生成，你只写判断和措辞。",
    "### 写什么",
    "- headline：一句话直接回答原问题，开头就是答案和最关键的一个数（如「8月有成交的活动共{value}」），口径和说明放在后半句，不要在句首写「按……口径」。整句只放一个最关键的数。问「有多少个活动 / 门店 / 货品」时，headline 就是那个个数（选分组汇总节点 metric 为 distinct_count 的行，assert 用 value），先报个数再说其他。要说整体或覆盖面大的规律；单个门店、商场这类小样本个案只能写进 claims。",
    "- 两段时间天数不同（如七夕 7 天对 8 月其余日子）时，比较日均类指标，不比实收、件数这些合计值。",
    "- claims 不要重复 headline 已经说过的那个数；从 headline 往下补充：构成、最高最低、需要注意的口径。",
    "- claims：3 到 5 条主要发现。每条是一句完整的业务判断：先说现象和数字，再说为什么值得注意或它意味着什么。原问题问到的每个方面（如整体对比、大区分区下钻、局部特别好或特别差）都要有对应发现；有分组结果时至少写出最好和最差的分组。",
    "- actions：2 到 3 条建议，每条写清做什么、针对哪个对象、依据哪条发现（claim 填该发现在 claims 里的序号）。",
    "- 原问题问到数据里没有的维度（如会员等级、金价）时，headline 先用最接近的现有数据回答（如会员与非会员对比、每克牌价走势），再在 cannotConclude 写明缺什么；不要因为缺一个维度就不回答。",
    "- cannotConclude：数据确实缺少、影响判断的内容，写清缺什么；能用现有数据回答的不要写在这里。",
    "- questions：只写必须由用户确认才能继续的业务事实，没有就留空。",
    "### 怎么引用数据",
    "- 执行结果按节点分段，每段开头「# 节点：说明」写明这个节点算的是什么范围；措辞里的对象（如会员还是非会员、哪段时间）必须和所选节点的说明一致。",
    "- headline 和每条 claim 都要绑定执行结果里的一行：把下面「执行结果」里那一行的 {node, select, metric, role} 原样抄进去（总体行没有 select）。",
    "- 数值写成占位符：{target}、{reference}、{delta}、{change}、{deviation} 是同一节点、同一分组、同一指标的目标、参照、差额、变化和偏离；{value} 是所选那一行（所选角色已另用具名占位写出时，{value} 指这一组的水平值）。只能用这六个占位符，每个在一条里最多出现一次。",
    "- 一条只说一个指标：占位符只会填入所选 metric 的数。要说另一个指标（如客单价、门店数），另写一条并选那个指标的行。",
    "- actions、cannotConclude、questions 不能写占位符或算出来的数字，用文字指向对应发现即可。",
    "- 业务名称和原话里的日期可以照写（如「H-克减30元」「东区/B区」「七夕7天」），其他算出来的数字只能用占位符。",
    "- assert 要和数据一致：value 只陈述这个数、不判断方向（如活动个数、本月实收）；up/higher 对应正的变化、偏离或贡献，down/lower 对应负的，flat 是变化不到 1%，largest/smallest 是同一节点同一指标里最大或最小的那组。汇总（measure）节点没有参照，分组之间只能用 largest/smallest 说谁最高最低；要说比什么高或低，选 contrast、drill、scan 节点。",
    "- 只能引用执行结果里列出的行；不支持、失败的节点和稳健性检查不能作为结论节点。",
    `### 原问题\n${question}`,
    context.length ? `### 用户此前说过\n${context.map((item) => `- ${item}`).join("\n")}\n原问题如果是在补充口径或回答上一轮的疑问，就按补充后的口径回答前面的问题。` : "",
    `### 执行结果\n${summary}`,
  ].filter(Boolean).join("\n\n");
}

// brief：计划复核时附上能力目录，便于判断筛选键和指标是否可用。
export function reviewPrompt(kind: "plan" | "wording", question: string, payload: string, brief?: string): string {
  if (kind === "plan") return [
    "## 本步：复核分析计划",
    "你是独立复核员。判断这份计划能不能回答原问题：范围和口径是否与原话一致、比较是否可比、有没有漏掉原问题要回答的事项、有没有多余节点。",
    "调用 submit_plan_review({ verdict, issues }) 提交：计划可用时 verdict 为 ok、issues 为空；需要修改时 verdict 为 revise，issues 逐条写清要改什么。",
    brief ? `### 能力目录\n${brief}` : "",
    `### 原问题\n${question}`,
    `### 计划\n${payload}`,
  ].filter(Boolean).join("\n\n");
  return [
    "## 本步：复核结论措辞",
    "你是独立复核员。数字已由代码绑定，你只看措辞：是否直接回答原问题、有没有把相关说成因果、有没有夸大、建议是否和依据相连。",
    "逐条核对措辞说的对象和「依据」里的范围是否一致：依据是非会员的节点却写成会员、依据是工作日对比却写成整月，都要按依据改写。改写时对照期照「依据」里的写法，不要自己换成别的日期范围。",
    "措辞有问题优先 rewrite；只有结论本身错误或与问题无关时才 drop。原问题要的维度数据里没有、结论用最接近的现有数据回答（如用会员与非会员代替会员等级）时，保留并在措辞里说明是替代口径，不要删除。",
    "调用 submit_wording_review({ edits, notes }) 提交。edits 每项为 { index, action: \"drop\" } 或 { index, action: \"rewrite\", text }，index 是下面结论列表的序号（0 为主结论）；改写的 text 不能写数字，保留原有占位符。没有问题时 edits 为空。notes 写给用户看的简短复核说明，可为空。",
    `### 原问题\n${question}`,
    `### 结论列表\n${payload}`,
  ].join("\n\n");
}
