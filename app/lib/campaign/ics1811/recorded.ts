// 「已经记下了什么」。追问时只把缺的问出来，用户看不到已经攒下的部分，
// 活动像是凭空出现的；把已记下的列出来，一步步搭建才看得见。

import { FACT_LABEL } from "./messages.ts";
import type { FactKey, Ics1811Draft } from "./types.ts";

// 按 FACT_LABEL 的声明顺序取，顺序固定：日期、门店、优惠……和问题目录一致，
// 不依赖对象键枚举的偶然顺序。
const ORDER = Object.keys(FACT_LABEL) as FactKey[];

export function recordedSoFar(draft: Ics1811Draft): string[] {
  return ORDER.filter((key) => draft.facts[key] !== null && draft.facts[key] !== undefined).map((key) => FACT_LABEL[key]);
}
