import type { ScanRule, ScanRuleFieldReference } from "./api";

export function isScanRuleFieldReferenceValue(value: ScanRule["value"]): value is ScanRuleFieldReference {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.type === "field";
}

function splitListRuleText(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function literalScanRuleValues(rule: ScanRule): Array<string | number | boolean> {
  if (isScanRuleFieldReferenceValue(rule.value)) return [];
  const values = Array.isArray(rule.value) ? rule.value : [rule.value];
  if (rule.operator === "in" || rule.operator === "not_in") {
    const normalized: Array<string | number | boolean> = [];
    for (const value of values) {
      if (typeof value === "string") normalized.push(...splitListRuleText(value));
      else normalized.push(value);
    }
    return normalized;
  }
  return values;
}

function normalizeMultiplier(rawValue: unknown): number {
  const trimmed = String(rawValue ?? "").trim();
  if (!trimmed || trimmed === "-" || trimmed === "." || trimmed === "-." || trimmed.endsWith(".")) return 1;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : 1;
}

export function normalizeScanRuleForSave(rule: ScanRule, rawCompareMultiplierInput?: string): ScanRule {
  const field = rule.field.trim();
  if (!isScanRuleFieldReferenceValue(rule.value)) {
    if (rule.operator === "in" || rule.operator === "not_in") {
      return {
        ...rule,
        field,
        value: literalScanRuleValues(rule)
          .map((value) => typeof value === "string" ? value.trim() : value)
          .filter((value) => typeof value !== "string" || value.length > 0),
      };
    }
    return {
      ...rule,
      field,
      value: Array.isArray(rule.value) ? literalScanRuleValues(rule) : rule.value,
    };
  }

  return {
    ...rule,
    field,
    value: {
      ...rule.value,
      field: rule.value.field.trim(),
      multiplier: normalizeMultiplier(rawCompareMultiplierInput ?? rule.value.multiplier ?? 1),
    },
  };
}
