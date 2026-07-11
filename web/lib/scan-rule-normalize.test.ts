import assert from "node:assert/strict";
import test from "node:test";
import { normalizeScanRuleForSave } from "./scan-rule-normalize";
import type { ScanRule } from "./api";

test("scan rule save normalization serializes comma-delimited list values as arrays", () => {
  const rule: ScanRule = {
    id: "type",
    field: " type ",
    operator: "in",
    value: "stock, dr",
  };

  const normalized = normalizeScanRuleForSave(rule);

  assert.equal(normalized.field, "type");
  assert.deepEqual(normalized.value, ["stock", "dr"]);
});
