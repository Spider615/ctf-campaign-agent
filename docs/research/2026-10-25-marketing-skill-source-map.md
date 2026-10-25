# 新问答 Skill 的命题与来源映射

日期：2026-10-25。适用文件仅为 `agent/analytics-plugin/skills/ctf-qa/SKILL.md` 与 `agent/analytics-plugin/skills/marketing-theory/SKILL.md`。本表是人工审查记录，不是运行时门禁、模型必须读取的文件或回答模板。

本次依据三份已核实研究记录写入 Skill，并静态核对当前代码；没有重新声称亲读所有出版终稿，也没有查询业务数据库或验证本品牌效果。阅读层级沿用原记录：**正文**为已读相关原文，**摘要**只支持摘要明确给出的命题，**书目／目录**只确认出处与章节。期刊卷页不能冒充某命题已核读的页码；无页码网页按标题／章节定位，未记录正文页码的不补写。

研究记录：

- [采用建议与总索引](2026-10-25-marketing-theory.md)。
- [基础、行业与客户指标核实](2026-10-25-marketing-theory-foundations.md)，下称 F；保留其 `[M1]`、`[T1]` 等局部标识。
- [促销与对照核实](2026-10-25-marketing-theory-promotions.md)，下称 P；保留其 `P1`、`B1` 等局部标识。两份研究的同名标识不混用。

## 1. 十张理论卡逐项映射

这里的“判断”是来源核实结论及项目采用方式，不能理解为运行时已经测得业务效果。

| Skill 条目 | 实际采用的命题 | 原始来源与已核读定位 | 阅读层级与核实结论 | 适用限制及当前能力 |
| --- | --- | --- | --- | --- |
| T01 `marketing-theory / 直接回答与表达层级`；`ctf-qa / 理解当前问题` | 统领判断可先呈现，随后按需要展开支持；不据此固定章节 | Barbara Minto，[作者概念页](https://www.barbaraminto.com/concept)，从事实归组至统领思想、自上而下沟通的网页正文；F `[M1]` | 作者网页正文，非图书全文；无网页页码。可支持表达顺序，不核首创年或书中页码 | 表达不是营销效果识别。最新纠正、缺维度与方案答法是本项目问答要求，不冒充 Minto 原话 |
| T02 `marketing-theory / 销售指标树与算术拆解`；`ctf-qa / 经营口径`订单与比率条 | 交易数、篮子金额和客流转化分别定义；A＝O×(Q/O)×(A/Q) 为定义推导 | Perdikaki、Kesavan、Swaminathan（2012），[DOI](https://doi.org/10.1287/msom.1110.0356)出版社摘要中交易／客流及销售额／交易数的定义；F `[T1]`、§3.1–3.2 | 论文仅摘要；期刊 145–162 是书目卷页，不当作已读命题页。件数扩展来自 F §3.1 的代数定义 | 需要同范围、同币种、有效正分母与覆盖一致。当前订单为筛选内成交部分，缺键行可能仍计金额；现有拆解不自动提供完整三因子贡献树，也不证明价格因果 |
| T03 `marketing-theory / 促销销量的来源与净增`；`ctf-qa / 经营口径`相关与因果条 | 促销抬升可能含切换、跨期与扩张；囤货不必然全是前移损失 | Gupta（1988）[DOI](https://doi.org/10.1177/002224378802500402)摘要；van Heerde 等（2004）[作者机构摘要](https://research.rug.nl/en/publications/decomposing-the-sales-promotion-bump-with-store-data/)；Ailawadi 等（2007）[DOI](https://doi.org/10.1509/jmkr.44.3.450)摘要；P `P1–P3` | 三篇仅摘要，未核读正文模型、效应量或逐页推导，不补正文页码 | 本库可描述差异及算术结构，没有购买决策／门店回归模型。跨品、品牌、品类、市场等净增边界分别定义，蚕食不能与重叠项重复加总 |
| T04 `marketing-theory / 可比窗口、共同门店与对照`；`ctf-qa / 经营口径`日均与对照条 | 对照需要有依据的未干预轨迹；共同门店、控制变量不单独识别因果 | Abadie、Diamond、Hainmueller（2010）[MIT 出版版](https://economics.mit.edu/sites/default/files/publications/Synthetic%20Control%20Methods.pdf)，引言、§2.2–2.4；Gordon 等（2019）[DOI](https://doi.org/10.1287/mksc.2018.1135)摘要；P `C1–C2`、F `[E2]` | 前者相关正文、后者摘要。采用已记录章节，不为前者另补页码；后者书目卷页不作正文定位 | 控烟与广告研究的方法类推，不是珠宝验证。当前 compare／robustness 支持描述和敏感性，没有合成对照或因果置信度；共同观察门店与正式同店不同 |
| T05 `marketing-theory / 收入持平与维持原利润`；`ctf-qa / 测算与呈现` | 收入补量 d/(1−d) 与维持基准利润补量 d/(m−d) 不同；m 是降价前贡献毛利率 | Franklin、Graybeal、Cooper（2019），OpenStax 管理会计 [§3.1](https://openstax.org/books/principles-managerial-accounting/pages/3-1-explain-contribution-margin-and-calculate-contribution-margin-per-unit-contribution-margin-ratio-and-total-contribution-margin)、[§3.2](https://openstax.org/books/principles-managerial-accounting/pages/3-2-calculate-a-break-even-point-in-units-and-dollars)；P `B1`及其显式推导 | 两节正文，无需编在线书页码；教材支持贡献毛利及本量利条件，两个补量公式是项目据定义推导，不宣称原文直接刊有 | 利润式需 m>d≥0、单位变动成本与总固定成本不变及同质／固定组合；新增费用或转移要另算。源零售毛利不能代 m；情景工具输出收入，不是利润解算器 |
| T06 `marketing-theory / 黄金珠宝的价格、重量与换购`；`ctf-qa / 经营口径`黄金条 | 金额、件数、金重与定价方式分开；换购、现金回收与 POS 实收不能直接互换 | 世界黄金协会 [2023 珠宝调查](https://www.gold.org/goldhub/research/market-update/2023-chinese-jewellery-market-insights-gold-continues-to-lead-the-market)，定价部分图 11–12 周边说明；[2025 全年 Notes and Definitions](https://www.gold.org/goldhub/research/gold-demand-trends/gold-demand-trends-full-year-2025/notes-definitions)，金饰消费、回收定义；F `[G1]`、`[G5]`、§5.1 | 原站相关正文，按图号和定义名定位，无网页页码。行业计量与调查已核实；企业核算对应是项目应用判断 | 没有据此填本库金价、纯度、工费或新旧货配对。每克牌价是代理，回收只是候选。F `[G2–G4]`可作背景，但 Skill 未移植其行业数字为门店事实 |
| T07 `marketing-theory / 门槛促销与追加购买`；`ctf-qa / 测算与呈现`订单门槛条 | 门槛可成为支出目标，效果有条件；追加搜索不等于已实现凑单或利润 | Lee、Ariely（2006）[MIT 出版版](https://web.mit.edu/ariely/www/MIT/Papers/ShopGoals.pdf)，实验设置、实验 2／3、讨论；Kulkarni、Yuan（2025）[DOI](https://doi.org/10.1002/mar.22200)摘要；P `T1–T2` | 前者相关正文，按实验名定位，不补其正文页码；后者仅摘要，不背书各实验材料或效应量 | 便利店研究不是珠宝效果。当前订单分布仅 p50/p90/p99，不是门槛直方图；order_threshold 是筛选内成交部分的假设让利，不恢复历史资格或模拟追加购买 |
| T08 `marketing-theory / 折扣的表述方式` | 等价经济优惠的金额／百分比表达在研究条件下可能影响预期与选择 | DelVecchio、Krishnan、Smith（2007），[DOI](https://doi.org/10.1509/jmkg.71.3.158)摘要中深折扣条件下的相对比较；P `F2` | 仅摘要；158–170 是期刊书目页，不给某命题编正文页号。未核正文效应量 | 不推出百分比普遍最优；克减与折扣可能改变经济条件。当前优惠标签与成交不隔离文案作用，缺曝光及认知测量不能报本品牌感知或长期收益 |
| T09 `marketing-theory / 交易、门店细分与目标选择`；`ctf-qa / 经营口径`会员与门店标签条 | 分组观察、目标选择和定位分别需要证据；有效细分还需可衡量、可触达及可行动等条件 | Albrecht、Green、Hoffman（2023），OpenStax 营销学 [§5.1](https://openstax.org/books/principles-marketing/pages/5-1-market-segmentation-and-consumer-markets)、[§5.4](https://openstax.org/books/principles-marketing/pages/5-4-essential-factors-in-effective-market-segmentation)、[§5.5](https://openstax.org/books/principles-marketing/pages/5-5-selecting-target-markets)、[§5.6](https://openstax.org/books/principles-marketing/pages/5-6-product-positioning)；F `[S3]`、§4.1 | 官方教材相关正文，按节定位，无在线页码。Smith（1956）F `[S1]`仅书目，Kotler 等第 16 版 F `[S2]`仅出版社第 6／7 章目录；后两者不是 Skill 具体定义的正文证据 | 门店／交易标签不等于消费者需求或名单，高销售组不自动最佳。memberSegment 在导入源可用不表示 MySQL 同样可用，也不自动是等级、RFM 或 CLV |
| T10 `marketing-theory / 促销频率与参考价格` | 频率、深度与表述可能影响价格预期；心理预期与挂牌或成交价格不同 | Kalwani、Yim（1992），[DOI](https://doi.org/10.1177/002224379202900108)原论文摘要；DelVecchio 等（2007）同 T08；P `F1–F2` | 均仅摘要，未复核正文全部条件、方向、持续时间或效应量，不写正文页码 | 单期销售无法确认长期预期变化，不能断言折扣必然永久伤品牌。多期成交描述仍不等于直接测量心理预期，没有通用安全频次／恢复天数 |

## 2. 客户与效果指标缺口映射

本节对应 `marketing-theory / 客户与效果指标的数据缺口`，并支持 `ctf-qa` 对缺数据仍继续分析的指导。最低数据条件是结合来源与本项目语义层整理的应用判断，不冒充论文统一行业清单；能力日后变化时应以 capabilities 和实际工具为准。

| 条目 | 实际采用的命题 | 原始来源与已核读定位 | 边界与可继续完成的分析 |
| --- | --- | --- | --- |
| D01 RFM／复购 | 客户关联、有效交易与一致观察窗口不可由订单或会员标识替代；预测与观察复购率不同 | Fader、Hardie、Lee（2005）[RFM 作者稿](https://www.brucehardie.com/papers/rfm_clv_2005-02-16.pdf)，§2、输入／假设、货币值及验证相关段落；[Counting Your Customers 作者提供期刊重印](https://www.brucehardie.com/papers/018/fader_et_al_mksc_05.pdf)，引言与模型输入；F `[C1]`、`[C3]` | 读到相关正文，作者稿页码不换算成期刊页码；当前不将未读具体页数补写。无逐客轨迹仍可描述会员销售行、订单及货品结构，不能称为复购、新老客或流失 |
| D02 CLV | 客户价值含未来收益及预测假设；个体与群体估值所需关联粒度不同 | Gupta、Lehmann、Stuart（2004），[作者机构摘要](https://business.columbia.edu/faculty/research/valuing-customers-0)与 [DOI 出版摘要](https://doi.org/10.1509/jmkr.41.1.7.25084)；F `[C2]` | 仅摘要，不写正文页码，不将一切 CLV 都规定为逐客 ID。群体方法仍需 cohort／留存／利润／获客及折现依据；历史实收仅可作历史贡献描述 |
| D03 客流转化 | 交易数／客流有专门分子分母与计数定义 | T02 原研究的出版社摘要；F `[T1]`、§6.1 | 无客流不能在流量与转化之间归因；仍能研究订单、件数、单均和结构。有成交日期不是营业日，无成交不等于零客流 |
| D04 利润型营销回报 | 必须说明财务价值、费用、期间及估值口径；项目采用的增量贡献利润口径还需可信反事实 | Farris、Hanssens、Lenskold、Reibstein（2015），[出版社 PDF](https://henrystewartpublications.com/wp-content/uploads/2025/02/Hanssens.pdf)，**出版页 270–271**的定义及估值差异；F `[E1]`；反事实限制另见 T04／F `[E2]` | 这是原研究已记录核读的页码；2015 为论文年，URL 中 2025 是上传路径。利润型是项目口径，不是原文唯一形式。费用与反事实不足时给历史收入／源毛利描述或情景，不报真实增量利润 ROI，折扣不重复扣减 |
| D05 金价与换购现金 | 行业计量和旧换新／现金回收定义不能补造企业结算关联 | T06 两份正文；另 F `[G4]` [2025 全年 Jewellery](https://www.gold.org/goldhub/research/gold-demand-trends/gold-demand-trends-full-year-2025/jewellery)中国段中旧换新说明；F §5.1 | 按网页章节定位，不补页码。新旧单配对、估价、抵扣、工费与补现金是项目所需数据推导；暂缺时仍可分列实收、件数、克重、退货和回收候选 |

## 3. 应用合同与工具能力的映射

以下要求来自设计、计划和实际代码，不为它们强加论文出处；理论卡中的同类提醒同时受这些应用定义限制。

| `ctf-qa` 条目／相关理论卡 | 应用命题 | 可核对位置 | 边界 |
| --- | --- | --- | --- |
| 引言、`理解当前问题`、`自主取证与停止`；全部理论卡 | 自主决定是否加载 Skill、怎样查询与组织回答；问候可直接答，查数不必加载理论；已有工具能做的先做，缺项只收窄有关判断 | `docs/superpowers/specs/2026-10-24-skill-driven-qa-design.md` §2、§3.1、§3.3；实施计划任务 5、6；研究总索引 §3–4 | 是应用内 SDK Skill，不安装为用户个人 Skill；章节是内部参考组织，不规定用户答案章节、试点天数或固定复核流程 |
| `理解当前问题`；T01 | 最新纠正结合收到的 history／context 理解；方案给出有依据的做法，缺原问题维度则明确受影响判断 | 设计 §3 连续对话说明、§3.3；`app/lib/analytics/plan/prompt.ts` 的 `answerPrompt` 中仍适用的语义要求 | 不搬入旧提示词的示例答案、固定目标前缀、模板或流程；保留的是问题覆盖与证据适用性 |
| `经营口径`；T02、T04、T06、T09 | 金额缺失不补零，人口口径分开；订单及门店不可跨组直接相加；日均按成交日期；每克同货类同材料；会员及同店定义有边界 | `app/lib/analytics/semantic/model.ts` 的 `SEMANTIC_DIMENSIONS`、`SEMANTIC_METRICS`；`agent/analytics-operation-database.ts` 的聚合与人口编译；`app/lib/analytics/analysis-v2-operations.ts` | 字段依据档位与实际完整性分别确认，本次静态核对不证明业务库已经补齐数据 |
| `自主取证与停止`；T02–T04、T07 | 五种确定性方法经 `analyze` 提供，分页读取与重查区分；全局判断不能以首页当全量 | 设计 §3.1；`app/lib/analytics/analysis-v2-types.ts` 的 `ANALYSIS_METHODS`、`AnalysisOperationRequest`、`AnalysisOrderDistribution`；`app/lib/analytics/analysis-v2-operations.ts` | 五种底层方法与新会话五个业务工具不是同一层。新工具按其他任务接入；本任务只写 Skill 与目录，不据名称声称完整系统已上线 |
| `测算与呈现`；T05、T07 | 情景基线绑定同范围已读 sales 总体，逐单位到分、封顶、缺单位不发布部分收入，净量变化是假设 | `app/lib/analytics/plan/scenario.ts` 的 `simulatePlanScenario`；`app/lib/analytics/analysis-v2-scenarios.ts`；`AnalysisAdjustment` 与 `AnalysisDataSession.scenario` | 情景未重算成本、无需求响应预测，不识别交易挪动，不还原完整订单；退役的 calculate_analysis／simulate_analysis 不作为新工具调用 |
| `测算与呈现`与最后权限段；全部理论卡 | 按需绑定真实结果画图、用占位提交；只用本回合受控工具，不开放 SQL／脚本／文件／网络，不披露底层身份 | 设计 §2、§3.1、§3.4；实施计划任务 4、6 | 目录只校验、提供元信息；SDK 允许名单、业务工具授权、身份处理和运行器由集成任务完成，本任务不改执行插件门禁 |

## 4. 公式身份与逐项核对记录

沿用研究索引 §2、P `B1` 已记录的定义推导，不新增未核实的首创断言：

```text
收入：Q₁ P(1−d) = Q₀ P
     (Q₁−Q₀)/Q₀ = d/(1−d)

利润：Q₁[P(1−d)−c]−F = Q₀(P−c)−F，m=(P−c)/P
     (Q₁−Q₀)/Q₀ = d/(m−d)
```

单位变动成本 c 不变，并不等于总变动成本不变；总固定成本 F 的比较期间一致且不变。新增费用需重算。P `B2` 的 Smith／Nagle（1994）仅出版社介绍，**未核其付费正文公式或公式页**，因此未被用作 Skill 公式正文证据。

人工对照结论：T01–T10 均有对应 Skill 条目，D01–D05 均有对应缺口说明；正文／摘要／书目目录的标签与两份原始核实记录一致。没有把行业数字、原样本效果、假设净量或代数条件移写为本库事实；没有新增 SQL、脚本、任意读取入口或理论必载门禁。

目录自动测试只验证元信息及路径安全，不能证明模型会按问题选择方法。此任务未运行真实模型问答；问题分布、自由回答结构、实际 Skill 选择和端到端效果仍应由运行器接入后的真实回归验证，不能由 frontmatter 通过推定。
