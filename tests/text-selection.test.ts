import assert from "node:assert/strict";
import test from "node:test";

import { hasMeaningfulTextSelection } from "../app/lib/client/text-selection.ts";

test("only a non-collapsed non-whitespace text selection suppresses details toggling", () => {
  assert.equal(hasMeaningfulTextSelection(null), false);
  assert.equal(hasMeaningfulTextSelection({ isCollapsed: true, toString: () => "标题" }), false);
  assert.equal(hasMeaningfulTextSelection({ isCollapsed: false, toString: () => "  " }), false);
  assert.equal(hasMeaningfulTextSelection({ isCollapsed: false, toString: () => "总用时 8.9s" }), true);
});
