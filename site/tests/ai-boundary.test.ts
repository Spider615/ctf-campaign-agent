import assert from "node:assert/strict";
import test from "node:test";

import {
  parseGeneratedCopy,
  parseInterpretation,
  parsePatchProposal,
} from "../app/lib/server/ai-schemas.ts";

test("interpretation preserves only explicit offer values", () => {
  const result = parseInterpretation(
    JSON.stringify({
      summary: "母亲节满减",
      fields: { occasion: "日历节点", thresholdAmount: 3000, amountOff: 300 },
      unresolved: ["结束日期"],
    }),
    "母亲节满3000减300",
  );

  assert.equal(result.fields.thresholdAmount, 3000);
  assert.equal(result.fields.amountOff, 300);
});

test("interpretation rejects an offer number absent from the user text", () => {
  assert.throws(
    () =>
      parseInterpretation(
        JSON.stringify({
          summary: "母亲节满减",
          fields: { thresholdAmount: 3000, amountOff: 300 },
          unresolved: [],
        }),
        "母亲节做个满减",
      ),
    /让利数值必须来自用户原话/,
  );
});

test("generated copy cannot contain code-table fields", () => {
  assert.throws(
    () =>
      parseGeneratedCopy(
        JSON.stringify({
          externalName: "母爱如金",
          icsName: "母亲节金礼",
          content: "到店选购指定商品",
          slogan: "把爱戴在身边",
          approvalFlowCode: "03",
        }),
      ),
    /模型返回了不允许生成的字段/,
  );
});

test("patch proposal allows copy and explicit operational edits only", () => {
  const patches = parsePatchProposal(
    JSON.stringify({
      ops: [
        {
          op: "replace",
          path: "/brief/externalName",
          value: "她的光芒",
          reason: "用户要求更克制",
        },
      ],
    }),
    "活动名改成她的光芒",
  );

  assert.equal(patches[0].path, "/brief/externalName");
  assert.equal(patches[0].provenance, "ai");
});

