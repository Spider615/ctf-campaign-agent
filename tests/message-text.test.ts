import assert from "node:assert/strict";
import test from "node:test";

import { messageToText } from "../app/lib/campaign/messages.ts";

test("user messages copy the original words", () => {
  assert.equal(messageToText({ v: 1, kind: "user_text", text: "帮我生成一个国庆节的营销活动" }), "帮我生成一个国庆节的营销活动");
});

test("readback copies every section as plain lines", () => {
  const text = messageToText({
    v: 1,
    kind: "agent_readback",
    stated: [{ label: "由头", value: "国庆" }],
    inferred: [{ label: "由头类型", value: "日历节点" }],
    uncertain: ["起止日期未说明"],
    derivedType: "日历节点 × 让利待定",
  });
  assert.equal(text, "我理解的是：\n你说的：\n- 由头：国庆\n我推断的，不对直接说：\n- 由头类型：日历节点\n我还不确定的：\n- 起止日期未说明\n活动类型判断：日历节点 × 让利待定");
});

test("change and plan cards copy what the card shows", () => {
  assert.equal(
    messageToText({
      v: 1,
      kind: "agent_change",
      title: "改了 2 处",
      items: [
        { label: "对外传播名", before: "旧名", after: "新名" },
        { label: "确认覆盖市场", before: "内地", after: "内地" },
      ],
      versionSeq: 3,
    }),
    "改了 2 处\n对外传播名：旧名 → 新名\n确认覆盖市场：内地",
  );
  assert.equal(
    messageToText({
      v: 1,
      kind: "agent_plan",
      versionSeq: 7,
      brief: { externalName: "母亲节黄金满减", icsName: "华东母亲节黄金满减", content: "满3000元减300元。", slogan: "金礼致母爱" },
      total: 1,
      readyOrders: 0,
      blockedOrders: 1,
      warnings: [],
    }),
    "对外传播名：母亲节黄金满减\nICS 开单名：华东母亲节黄金满减\n活动主张：金礼致母爱\n活动内容：满3000元减300元。\n要在 ICS 录入 1 条优惠规则：0 条字段已齐，1 条还有项要在 ICS 界面上选。",
  );
});
