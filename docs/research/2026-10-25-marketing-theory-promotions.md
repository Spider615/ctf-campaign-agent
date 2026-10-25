# 促销理论：原始来源核实与当前分析能力边界

核实日期：2026-10-25。范围仅含五项促销理论。以下均为中文转述；将原始研究、出版社教材、本文代数推导及面向本库的方法类推分别说明，不主张已经找到各理论的最早首创者。

**结论：五项均找到一手依据，但理论成立不等于本库已识别效果。** 本次实际打开出版社或作者机构页面，记录全文／摘要的访问层级；未连接业务数据库、未运行模型或复现论文估计。单月交易观察数据及当前五种方法不能确认真实促销增量、品牌切换、购买提前、蚕食或因果。

## 1. 促销增量分解、品牌切换、购买提前／囤货、货品蚕食

### P1：购买时点、品牌和购买量的分解

Sunil Gupta（1988），**Impact of Sales Promotions on When, What, and How Much to Buy**，*Journal of Marketing Research*, 25(4), 342–355。DOI：[10.1177/002224378802500402](https://doi.org/10.1177/002224378802500402)；[SAGE／AMA 原文页](https://journals.sagepub.com/doi/10.1177/002224378802500402)。

- **访问：摘要，非全文。** 出版社确认作者、年份、题名、页码及 DOI。
- **支持：** 将促销期间的品牌销量抬升分解为品牌切换、购买时点提前和购买量增加／囤货；联合建模“何时买、买什么、买多少”，而非直接把促销销量当净新增需求。
- **限制：** 研究使用常规研磨咖啡的家庭扫描面板。其样本分解比例不能作为珠宝促销的通用比例；本次未核验正文估计、模型诊断或消费者库存测量。

### P2：门店数据中的跨品牌、跨期与品类扩张，以及蚕食

Harald J. van Heerde、Peter S. H. Leeflang、Dick R. Wittink（2004），**Decomposing the Sales Promotion Bump with Store Data**，*Marketing Science*, 23(3), 317–334。DOI：[10.1287/mksc.1040.0061](https://doi.org/10.1287/mksc.1040.0061)；[INFORMS 原文页](https://pubsonline.informs.org/doi/10.1287/mksc.1040.0061)；[Groningen 作者机构记录](https://research.rug.nl/en/publications/decomposing-the-sales-promotion-bump-with-store-data/)。

- **访问：出版社摘要及机构摘要，非全文。** 出版社 PDF 入口回到摘要；机构将出版版标为受限并要求索取。
- **支持：** 门店回归模型把促销销量抬升分为跨品牌、跨期借用及品类扩张；扩展模型另区分跨店与市场扩张，并把跨货品效应细分为蚕食和品牌间效应。
- **限制：** 这是有模型条件的估计方法，不是对两个销售总额做减法。品类扩张不自动等于整个市场的新需求；品牌、零售商和品类层面的增量含义不同。蚕食属于进一步细分，不能不定义边界就与品牌切换等项重复相加。

### P3：囤货不必然只是未来需求前移

Kusum L. Ailawadi、Karen Gedenk、Christian Lutzky、Scott A. Neslin（2007），**Decomposition of the Sales Impact of Promotion-Induced Stockpiling**，*Journal of Marketing Research*, 44(3), 450–467。DOI：[10.1509/jmkr.44.3.450](https://doi.org/10.1509/jmkr.44.3.450)；[SAGE／AMA 原文页](https://journals.sagepub.com/doi/10.1509/jmkr.44.3.450)。

- **访问：摘要，非全文。** `/full/` 入口实际重定向到摘要；未将其计为全文。
- **支持：** 囤货可能提前原本会按常价发生的购买，也可能伴随品类消费增加、抢占未来竞品购买及后续复购；论文用模型和模拟衡量成本与收益。
- **限制：** 不能把全部囤货都记为损失，也不能把论文样本中的收益当本库收益。此次只确认摘要命题，未核验模型设定及动态参数。

**用于本项目的安全表述：** “活动关联销量中可能包含跨货品或跨期转移；现有证据只展示观察差异，不能确认净增及其来源。”识别消费者品牌切换／囤货需要适当的纵向购买及竞争信息；识别货品蚕食至少要有替代货品、促销暴露和可辩护的反事实。当前会员销售标识不能替代消费者身份和重复购买轨迹。

## 2. 同店对照及观察数据的因果限制

### C1：对照对象必须能代表未干预轨迹

Alberto Abadie、Alexis Diamond、Jens Hainmueller（2010），**Synthetic Control Methods for Comparative Case Studies: Estimating the Effect of California’s Tobacco Control Program**，*Journal of the American Statistical Association*, 105(490), 493–505。DOI：[10.1198/jasa.2009.ap08746](https://doi.org/10.1198/jasa.2009.ap08746)；[MIT 托管出版版全文，13 页](https://economics.mit.edu/sites/default/files/publications/Synthetic%20Control%20Methods.pdf)。

- **访问：全文；核读引言及 §2.2–2.4。**
- **支持：** 有完整汇总数据也仍存在反事实误差。合成对照依赖干预前结果和预测变量的匹配、适当的未干预对象，并明确讨论提前反应、单位间无干扰及拟合不足等条件。
- **限制：** 原文研究控烟政策，不直接验证珠宝同店方法。本文据此类推：门店相同只能改善部分可比性，不能排除节日、金价、客群、陈列、同期活动及时间变化。

### C2：控制大量可观测变量仍可能得到错误效果

Brett R. Gordon、Florian Zettelmeyer、Neha Bhargava、Dan Chapsky（2019），**A Comparison of Approaches to Advertising Measurement: Evidence from Big Field Experiments at Facebook**，*Marketing Science*, 38(2), 193–225。DOI：[10.1287/mksc.2018.1135](https://doi.org/10.1287/mksc.2018.1135)；[INFORMS 原文页](https://pubsonline.informs.org/doi/10.1287/mksc.2018.1135)；[作者研究页](https://brgordon1.github.io/publication/2019-comparison-advertising-measurement)。

- **访问：出版社摘要及作者介绍，非论文全文。**
- **支持：** 对照随机实地实验，常用观察估计即使控制丰富的人口及行为变量，仍经常不能恢复实验效果。
- **限制：** 这是广告测量证据，不是满减或同店促销的效应估计；不能据此宣布所有观察研究都无法识别因果。

**用于本项目的判断：** 同店、共同观察门店、分层及标准化均可用于描述性比较；它们本身不是随机分配或因果识别。观察数据可在有依据的准实验设计和识别假设下估计因果，但当前五种方法未实现这种设计。对于本库仅有单月交易观察、缺少经核验干预分配和可信反事实的情形，不能声称已确认增量／因果；问题在识别证据，不能仅凭“同店”或多几个控制维度解决。

## 3. 折扣补量公式 d/(m-d)：口径、推导及条件

### B1：已核实的贡献毛利与本量利假设

Mitchell Franklin、Patty Graybeal、Dixon Cooper（2019），**Principles of Accounting, Volume 2: Managerial Accounting**，OpenStax／Rice University。[§3.1：贡献毛利定义](https://openstax.org/books/principles-managerial-accounting/pages/3-1-explain-contribution-margin-and-calculate-contribution-margin-per-unit-contribution-margin-ratio-and-total-contribution-margin)；[§3.2：本量利条件与盈亏平衡](https://openstax.org/books/principles-managerial-accounting/pages/3-2-calculate-a-break-even-point-in-units-and-dollars)。

- **访问：出版社两节全文。** 页尾确认作者、书名及 2019-02-14 出版日期；未查到可引用 DOI，使用上述稳定章节 URL。
- **支持：** 单位贡献毛利＝售价减单位变动成本，贡献毛利率以售价为分母。本量利分析在相关范围内假设总固定成本不变、单位变动成本不变；多品种分析需要固定销售组合。
- **限制：** 下式是本文根据这些会计定义作的代数推导，**不是声称教材直接刊载了 d/(m−d)，也不是宣称找到公式最早作者**。贡献毛利不等同于扣除固定制造费用后的账面毛利，也不是毛利加成率。

令 P 为降价前单位售价，c 为单位变动成本，Q₀ 为基准销量，F 为同一评价期间的总固定成本，m＝(P−c)/P。d 是相对于 P 的降价比例；九折对应 d＝0.10，不是 0.90。降价后单位售价为 P(1−d)，在下列条件下令新利润等于原利润：

~~~text
π₀ = Q₀(P − c) − F
π₁ = Q₁[P(1 − d) − c] − F
π₁ = π₀  ⇒  Q₁/Q₀ = m/(m − d)
所需额外销量比例 = (Q₁ − Q₀)/Q₀ = d/(m − d)
~~~

**必须同时成立：**

1. P、Q₀ 均为正；m 为降价前的贡献毛利率，且 m＞d≥0。m≤d 时，降价后单位贡献非正，不能靠有限补量维持原有正贡献。
2. c 的单位金额保持不变，F 的总额保持不变；**不是“所有成本总额固定”**，总变动成本仍随销量增长。抽佣、支付费等若随成交价变化，应重算 c。
3. 比较期间、币种、税费及销量单位一致。单一同质商品按统一比例降价；多商品仅在组合固定、能够定义一致加权的 P、c、d 时使用同式。不能直接将订单满减、部分货品折扣或混合克价一概当 d。
4. 没有漏计新增活动费、履约费、退货损失、库存／资金成本及跨货品、门店或日期转移的机会成本；新增固定活动费 K 时，应改为 Q₁/Q₀＝[m＋K/(PQ₀)]/(m−d)。

这是**维持基准利润所需的销量增幅**，不是销售额增幅、需求预测，也不等于企业利润从亏损到零的绝对盈亏平衡点。例如显式假设 m＝30%、d＝10%，额外销量须为 50%；这只是条件算例。

### B2：原始定价文章线索，未完成公式正文核验

Gerald E. Smith、Thomas T. Nagle（1994），**Financial Analysis for Profit-Driven Pricing**。[MIT Sloan Management Review 出版社页面](https://shop.sloanreview.mit.edu/store/financial-analysis-for-profit-driven-pricing)，页面标注 1994-04-15。

- **访问：出版社介绍／摘要，正文付费；未购买。未核到 DOI，使用出版社稳定 URL。**
- **支持：** 出版社介绍确认其以利润贡献和达到增量盈利所需市场反应为定价分析核心。
- **未核实：** 原文公式的确切形式、所在页、假设逐项文字及“最早出处”归属。因此不把这篇文章当作已经亲读并核实 d/(m−d) 的证据；公式条件以 B1 与上面的显式推导为准。

**本库限制：** 语义层把 `profit` 定义为口径待确认的源字段“零售毛利”，并注明不等于实收减成本；`margin_rate` 也带假设身份。不能直接把它替换成 m，更不能据此发布真实利润保本或最优折扣结论。

## 4. 门槛促销与凑单

### T1：门槛可成为支出目标，效果受购物目标影响

Leonard Lee、Dan Ariely（2006），**Shopping Goals, Goal Concreteness, and Conditional Promotions**，*Journal of Consumer Research*, 33(1), 60–70。DOI：[10.1086/504136](https://doi.org/10.1086/504136)；[Oxford 出版社摘要](https://academic.oup.com/jcr/article-abstract/33/1/60/1822613)；[MIT 作者机构托管出版版全文，11 页](https://web.mit.edu/ariely/www/MIT/Papers/ShopGoals.pdf)。

- **访问：MIT 全文；核读实验设置、实验 2／3 和讨论。**
- **支持：** 便利店实地实验使用真实购买和有／无门槛优惠券；最低消费额可成为支出目标，部分消费者支出集中在门槛稍上方。门槛高低及目标具体程度会改变效果，甚至出现支出下降。
- **限制：** 这是特定便利店环境，不能保证珠宝顾客也会凑单。作者说明未购买离店者的优惠券数据有缺失，不能据此自动推断所有到店者的转化或净利润。

### T2：靠近门槛与促销表述共同影响追加搜索

Atul A. Kulkarni、Hong Yuan（2025），**Shopper Search in Response to Conditional Promotions: A Function of Basket Sizes and Incentive Types**，*Psychology & Marketing*, 42(6), 1700–1720。DOI：[10.1002/mar.22200](https://doi.org/10.1002/mar.22200)；[Wiley 原文页](https://onlinelibrary.wiley.com/doi/abs/10.1002/mar.22200)。

- **访问：摘要，非全文；首次在线日期 2025-02-15。** `/full/` 入口实际回到摘要。
- **支持：** 五项研究考察购物篮与门槛距离、激励框架及环境线索对追加搜索可能性的共同影响。
- **限制：** 搜索行为／自报搜索可能性不等于已实现凑单额、订单净增或贡献利润；本次未核验各研究的样本、材料及效应量。

**用于本项目的判断：** 可以提出“门槛可能引发追加购买”的待检验机制，不能从门槛附近的订单金额直接确认凑单。应有完整订单、真实资格规则及未促销／随机对照，并区分原本自然达标、追加购买和放弃成交。门槛附近的密度变化可以是研究线索，不能仅凭堆积作因果判断。

## 5. 折扣表述与参考价格侵蚀

### F1：促销频率与深度影响消费者价格预期

Manohar U. Kalwani、Chi Kin Yim（1992），**Consumer Price and Promotion Expectations: An Experimental Study**，*Journal of Marketing Research*, 29(1), 90–100。DOI：[10.1177/002224379202900108](https://doi.org/10.1177/002224379202900108)；[SAGE／AMA 原文页](https://journals.sagepub.com/doi/10.1177/002224379202900108)。

- **访问：摘要，非全文。**
- **支持：** 控制实验直接询问价格预期，发现促销频率及折扣深度影响预期；是否出现预期中的促销也影响品牌选择。
- **限制：** 摘要足以确认“预期会受促销影响”，不足以复核所有条件下的方向、幅度及持续时间；不能推成“每次折扣必然永久侵蚀品牌”。

### F2：金额减免与百分比减免对后续预期的影响可能不同

Devon DelVecchio、H. Shanker Krishnan、Daniel C. Smith（2007），**Cents or Percent? The Effects of Promotion Framing on Price Expectations and Choice**，*Journal of Marketing*, 71(3), 158–170。DOI：[10.1509/jmkg.71.3.158](https://doi.org/10.1509/jmkg.71.3.158)；[SAGE／AMA 原文页](https://journals.sagepub.com/doi/10.1509/jmkg.71.3.158)。

- **访问：摘要，非全文。**
- **支持：** 在研究中的深度折扣条件下，相比等价金额减免，百分比减免对应更高的促销后价格预期及促销后品牌选择；框架影响消费者对促销价的感知及其在预期更新中的权重。
- **限制：** 这是带折扣深度等条件的相对比较，不是百分比表述永远优于金额表述；不能据此给高价珠宝规定通用文案，更不能声称已经测得本品牌长期侵蚀。

**用于本项目的判断：** “消费者将来预期支付的价格”是心理构念，源表牌仔价／实际成交价不是它的直接测量。文献支持把预期下调列为促销风险与实验指标，不支持用单月折扣率和销量相关性确认参考价格侵蚀。

## 6. 当前五种方法能执行什么

核对的是工作区当前静态代码，而非线上实测。“五工具”按 `ANALYSIS_METHODS` 的五种确定性方法解释；计划层另有节点，不把节点名称、方法名称和理论名称混用。

| 方法 | 已有合同／实现 | 对上述五项的可用范围与缺口 |
| --- | --- | --- |
| `aggregate` | 按已登记维度、指标、范围汇总全部选定数据 | 可核对金额、件数、克重及商品结构；不能由汇总识别购买提前、竞品切换、消费者库存或参考价格。 |
| `compare` | 目标／参照范围，`controls`，`commonStores`，部分指标分层或标准化 | 可描述可比范围差异。共同观察门店是两个范围均有成交记录的交集，不等于正式“同店”，也不是未干预对照；没有随机分配或因果估计器。 |
| `decompose` | 实收的数量、单位实收、结构及进入／退出贡献；净销售另分销售、零元销售和退货组成 | 是算术重构；未实现 P1／P2 的购买决策模型或跨品牌／跨期促销分解，亦不将单位实收变化确认为折扣效应。 |
| `scan` | 登记维度内的完整组合、份额／偏离扫描 | 可找货品和优惠的观察差异；不是替代关系、门槛密度或增量模型，排名不能证明蚕食或因果。 |
| `robustness` | 最大门店／订单剔除、订单成交部分分位数、替代窗口检查 | 可检查结论对个别对象／窗口是否敏感；订单仅为当前筛选内成交部分。既不估计消费者行为，也不自动提供反事实或统计因果置信度。 |

代码定位：

- [analysis-v2-types.ts:9](/Users/jerry/Desktop/product/ctf-campaign-agent/app/lib/analytics/analysis-v2-types.ts:9)：方法名单；同文件第 40、43、46 行分别为情景规则、数据会话能力及操作参数。
- [analysis-v2-operations.ts:369](/Users/jerry/Desktop/product/ctf-campaign-agent/app/lib/analytics/analysis-v2-operations.ts:369)：共同观察门店边界；第 504 行起为拆解，第 602 行起为稳健性分支。
- [semantic/model.ts:68](/Users/jerry/Desktop/product/ctf-campaign-agent/app/lib/analytics/semantic/model.ts:68)：同店类型口径待确认；第 127、134、139、140、173 行附近分别注明毛利、订单成交部分、毛利率、折扣率及数据限制。

**公式与门槛情景另核对：**

- `FactExpression` 的四则表达式是证据派生结构，不代表模型已有任意公式求解工具。五种方法及当前 [PlanNode 合同](/Users/jerry/Desktop/product/ctf-campaign-agent/app/lib/analytics/plan/types.ts:3) 均未提供通用贡献毛利保本求解入口；B1 可作研究中的条件推导，不能称五工具已自动完成利润测算。
- 已有计划 `scenario` 节点及数据源情景能力，支持按克、件、订单成交部分、实收比例和订单成交部分门槛的额外让利；依赖当前适配器声明能力、同范围原始 `sales` 总体及有效单位。按人民币分计算、逐单位封顶，不发布缺失单位下的部分收入。
- [plan/scenario.ts:33](/Users/jerry/Desktop/product/ctf-campaign-agent/app/lib/analytics/plan/scenario.ts:33) 明确固定价格环境和商品结构、排除成交挪动、未重算成本；第 50 行输出的是“收入持平所需净成交量增幅”，统一比例让利 d 时为 d/(1−d)，**不是 d/(m−d) 的利润持平条件**。净成交量变化由显式假设输入，不能当历史净增或需求响应估计。
- [analysis-v2-scenarios.ts:34](/Users/jerry/Desktop/product/ctf-campaign-agent/app/lib/analytics/analysis-v2-scenarios.ts:34) 按店号和单号聚合筛选内成交部分，`order_threshold` 只对该部分应用假设门槛；它不恢复完整购物篮、不验证历史真实资格、不模拟消费者凑单，也不重建叠加／封顶等未提供规则。

## 7. 核实状态与剩余空白

| 项目 | 本次已核实 | 仍未核实／不得声称 |
| --- | --- | --- |
| 增量分解与蚕食 | P1–P3 的原始论文身份及摘要中的机制、分解思路 | 三文正文模型与估计复现；本库各机制比例及真实净增 |
| 同店与因果 | C1 全文的反事实条件；C2 摘要的观察估计失败证据；代码的共同门店边界 | 本库存在可用因果设计，或同店／单月观察已证明活动效果 |
| 折扣保本 | B1 全文的贡献毛利及成本条件；本文等利润代数推导 | d/(m−d) 最早出处；B2 原文公式页；源字段毛利能否作为贡献毛利 |
| 门槛与凑单 | T1 全文的条件性真实购买证据；T2 摘要的搜索机制 | 珠宝适用效应量、本库凑单人数／金额及真实资格 |
| 表述与参考价格 | F1／F2 原始实验论文身份及摘要支持的条件性命题 | 两文正文细节、珠宝通用最优表述、本品牌长期参考价格侵蚀 |

只修改本研究文件；未改产品代码、运行时 Skill 或集成文档。本文不把文献、代码中的历史备注或假设情景当作本次业务数据实测结果。
