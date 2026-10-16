import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { attachmentPython } from "../agent/attachments/parser.ts";

test("Linux 受限进程不能向隔离外 UNIX 监听器发送数据，也不能越界读写", { skip: process.platform !== "linux" }, () => {
  const checked = spawnSync(attachmentPython(), ["tests/helpers/attachment-sandbox.py", resolve("agent/attachments/sandbox.py")], { encoding: "utf8", timeout: 15000 });
  assert.equal(checked.status, 0, checked.stderr + checked.stdout); assert.match(checked.stdout, /检查通过/);
});
