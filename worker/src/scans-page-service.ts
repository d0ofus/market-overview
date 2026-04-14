import type { Env } from "./types";

export type ScanRuleOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "in" | "not_in";

export type ScanRuleScalar = string | number | boolean;

export type ScanRuleFieldReference = {
  type: "field";
  field: string;
  multiplier?: number;
};

export type ScanRuleValue = ScanRuleScalar | Array<ScanRuleScalar> | ScanRuleFieldReference;

export type ScanPresetRule = {
  id: string;
  field: string;
  operator: ScanRuleOperator;
  value: ScanRuleValue;
};

export type ScanPreset = {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  rules: ScanPresetRule[];
  sortField: string;
  sortDirection: "asc" | "desc";
  rowLimit: number;
  createdAt: string;
  updatedAt: string;
};

export type ScanCompilePresetMember = {
  scanPresetId: string;
  scanPresetName: string;
  sortOrder: number;
};

export type ScanCompilePresetRow = {
  id: string;
  name: string;
  memberCount: number;
  presetIds: string[];
  presetNames: string[];
  createdAt: string;
  updatedAt: string;
};

export type ScanCompilePresetDetail = ScanCompilePresetRow & {
  members: ScanCompilePresetMember[];
};

export type ScanSnapshotRow = {
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  change1d: number | null;
  marketCap: number | null;
  relativeVolume: number | null;
  price: number | null;
  avgVolume: number | null;
  priceAvgVolume: number | null;
  rawJson: string | null;
};

export type ScanSnapshot = {
  id: string;
  presetId: string;
  presetName: string;
  providerLabel: string;
  generatedAt: string;
  rowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
  rows: ScanSnapshotRow[];
};

export type CompiledScanUniqueTickerRow = {
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  occurrences: number;
  presetIds: string[];
  presetNames: string[];
  latestPrice: number | null;
  latestChange1d: number | null;
  latestMarketCap: number | null;
  latestRelativeVolume: number | null;
};

export type CompiledScansSnapshot = {
  compilePresetId: string | null;
  compilePresetName: string | null;
  presetIds: string[];
  presetNames: string[];
  generatedAt: string;
  rows: CompiledScanUniqueTickerRow[];
};

export type ScanCompilePresetRefreshMemberResult = {
  presetId: string;
  presetName: string;
  status: "ok" | "warning" | "error" | "empty";
  rowCount: number;
  error: string | null;
  snapshot: ScanSnapshot | null;
  usableSnapshot: ScanSnapshot | null;
  usedFallback: boolean;
  includedInCompiled: boolean;
};

export type ScanCompilePresetRefreshResult = {
  compilePresetId: string;
  compilePresetName: string;
  refreshedCount: number;
  failedCount: number;
  snapshot: CompiledScansSnapshot;
  memberResults: ScanCompilePresetRefreshMemberResult[];
};

type TradingViewFilter = {
  left: string;
  operation: string;
  right: number | string | boolean | Array<number | string | boolean>;
};

type TradingViewScanPayload = {
  markets: string[];
  symbols: { query: { types: string[] }; tickers: string[] };
  options: { lang: string };
  columns: string[];
  sort: { sortBy: string; sortOrder: "asc" | "desc"; nullsFirst?: boolean };
  range: [number, number];
  filter: TradingViewFilter[];
};

type TradingViewScanRow = {
  ticker?: string | null;
  name?: string | null;
  sector?: string | null;
  industry?: string | null;
  change1d?: number | string | null;
  marketCap?: number | string | null;
  relativeVolume?: number | string | null;
  price?: number | string | null;
  avgVolume?: number | string | null;
  priceAvgVolume?: number | string | null;
  volume?: number | string | null;
  exchange?: string | null;
  type?: string | null;
  raw?: unknown;
};

const DEFAULT_LIMIT = 100;
const RETENTION_DAYS = 7;
const MAX_FETCH_RANGE = 1000;
const MAX_PAGINATED_FETCH_TOTAL = 50000;
const TV_SCAN_URL = "https://scanner.tradingview.com/america/scan";
const TV_PROVIDER_LABEL = "TradingView Screener (america/stocks)";

const FIELD_ALIASES: Record<string, string> = {
  ticker: "ticker",
  symbol: "ticker",
  name: "name",
  company: "name",
  sector: "sector",
  industry: "industry",
  change: "change",
  change1d: "change",
  marketCap: "market_cap_basic",
  market_cap: "market_cap_basic",
  relative_volume: "relative_volume_10d_calc",
  relativeVolume: "relative_volume_10d_calc",
  price: "close",
  close: "close",
  avgVolume: "average_volume_30d_calc",
  averageVolume: "average_volume_30d_calc",
  volume: "volume",
  "Value.Traded": "Value.Traded",
  valueTraded: "Value.Traded",
  type: "type",
  exchange: "exchange",
  Exchange: "exchange",
  average_day_range_14: "ADR",
  averageDayRange14: "ADR",
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseRules(raw: string | null | undefined): ScanPresetRule[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as ScanPresetRule[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asComparableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text.toLowerCase() : null;
}

function normalizeTicker(value: unknown): string | null {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text) return null;
  const candidate = text.includes(":") ? text.split(":").pop() ?? text : text;
  return /^[A-Z0-9.\-^]{1,20}$/.test(candidate) ? candidate : null;
}

function normalizeFieldName(field: string): string {
  return FIELD_ALIASES[field.trim()] ?? field.trim();
}

function normalizeScalarValue(value: string | number | boolean): string | number | boolean {
  if (typeof value === "string") return value.trim();
  return value;
}

function isFieldReferenceValue(value: ScanRuleValue): value is ScanRuleFieldReference {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.type === "field";
}

function normalizeRuleValues(value: ScanRuleValue): Array<string | number | boolean> {
  if (isFieldReferenceValue(value)) return [];
  if (Array.isArray(value)) return value.map((item) => normalizeScalarValue(item));
  return [normalizeScalarValue(value)];
}

function isNumericRule(rule: ScanPresetRule): boolean {
  if (isFieldReferenceValue(rule.value)) return false;
  return normalizeRuleValues(rule.value).every((value) => typeof value === "number");
}

function shouldPushRuleUpstream(rule: ScanPresetRule): boolean {
  if (isFieldReferenceValue(rule.value)) {
    const multiplier = typeof rule.value.multiplier === "number" && Number.isFinite(rule.value.multiplier)
      ? rule.value.multiplier
      : 1;
    return multiplier === 1 && ["gt", "gte", "lt", "lte", "eq", "neq"].includes(rule.operator);
  }
  if (!isNumericRule(rule)) return false;
  return ["gt", "gte", "lt", "lte", "eq", "neq"].includes(rule.operator);
}

function mapRuleToTradingViewFilter(rule: ScanPresetRule): TradingViewFilter | null {
  const field = normalizeFieldName(rule.field);
  if (isFieldReferenceValue(rule.value)) {
    if (!shouldPushRuleUpstream(rule)) return null;
    if (rule.operator === "gt") return { left: field, operation: "greater", right: normalizeFieldName(rule.value.field) };
    if (rule.operator === "gte") return { left: field, operation: "egreater", right: normalizeFieldName(rule.value.field) };
    if (rule.operator === "lt") return { left: field, operation: "less", right: normalizeFieldName(rule.value.field) };
    if (rule.operator === "lte") return { left: field, operation: "eless", right: normalizeFieldName(rule.value.field) };
    if (rule.operator === "eq") return { left: field, operation: "equal", right: normalizeFieldName(rule.value.field) };
    if (rule.operator === "neq") return { left: field, operation: "nequal", right: normalizeFieldName(rule.value.field) };
    return null;
  }
  if (!shouldPushRuleUpstream(rule)) return null;
  const [value] = normalizeRuleValues(rule.value);
  if (typeof value !== "number") return null;
  if (rule.operator === "gt") return { left: field, operation: "greater", right: value };
  if (rule.operator === "gte") return { left: field, operation: "egreater", right: value };
  if (rule.operator === "lt") return { left: field, operation: "less", right: value };
  if (rule.operator === "lte") return { left: field, operation: "eless", right: value };
  if (rule.operator === "eq") return { left: field, operation: "equal", right: value };
  if (rule.operator === "neq") return { left: field, operation: "nequal", right: value };
  return null;
}

function resolveRuleTargetValue(row: TradingViewScanRow, rule: ScanPresetRule): unknown {
  if (!isFieldReferenceValue(rule.value)) {
    return normalizeRuleValues(rule.value)[0];
  }
  const compareField = rule.value.field.trim();
  if (!compareField) return null;
  const baseValue = rowValueForField(row, compareField);
  const baseNumber = asFiniteNumber(baseValue);
  const multiplier = typeof rule.value.multiplier === "number" && Number.isFinite(rule.value.multiplier)
    ? rule.value.multiplier
    : 1;
  if (baseNumber != null) return baseNumber * multiplier;
  const baseText = asComparableString(baseValue);
  return multiplier === 1 ? baseText : null;
}

function valueMatchesRule(candidate: unknown, rule: ScanPresetRule, row: TradingViewScanRow): boolean {
  if (isFieldReferenceValue(rule.value) && (rule.operator === "in" || rule.operator === "not_in")) {
    return false;
  }
  const values = normalizeRuleValues(rule.value);
  if (rule.operator === "in" || rule.operator === "not_in") {
    const candidateText = asComparableString(candidate);
    const set = new Set(values.map((value) => asComparableString(value)).filter((value): value is string => Boolean(value)));
    const hit = candidateText != null && set.has(candidateText);
    return rule.operator === "in" ? hit : !hit;
  }

  const candidateNumber = asFiniteNumber(candidate);
  const comparisonTarget = resolveRuleTargetValue(row, rule);
  const ruleNumber = typeof comparisonTarget === "number" ? comparisonTarget : asFiniteNumber(comparisonTarget);
  if (candidateNumber != null && ruleNumber != null) {
    if (rule.operator === "gt") return candidateNumber > ruleNumber;
    if (rule.operator === "gte") return candidateNumber >= ruleNumber;
    if (rule.operator === "lt") return candidateNumber < ruleNumber;
    if (rule.operator === "lte") return candidateNumber <= ruleNumber;
    if (rule.operator === "eq") return candidateNumber === ruleNumber;
    if (rule.operator === "neq") return candidateNumber !== ruleNumber;
  }

  const candidateText = asComparableString(candidate);
  const ruleText = asComparableString(comparisonTarget);
  if (candidateText == null || ruleText == null) return false;
  if (rule.operator === "eq") return candidateText === ruleText;
  if (rule.operator === "neq") return candidateText !== ruleText;
  if (rule.operator === "gt") return candidateText > ruleText;
  if (rule.operator === "gte") return candidateText >= ruleText;
  if (rule.operator === "lt") return candidateText < ruleText;
  if (rule.operator === "lte") return candidateText <= ruleText;
  return false;
}

function rowValueForField(row: TradingViewScanRow, field: string): unknown {
  const normalized = normalizeFieldName(field);
  if (normalized === "ticker") return row.ticker;
  if (normalized === "name") return row.name;
  if (normalized === "sector") return row.sector;
  if (normalized === "industry") return row.industry;
  if (normalized === "change") return row.change1d;
  if (normalized === "market_cap_basic") return row.marketCap;
  if (normalized === "relative_volume_10d_calc") return row.relativeVolume;
  if (normalized === "close") return row.price;
  if (normalized === "average_volume_30d_calc") return row.avgVolume;
  if (normalized === "Value.Traded") return row.priceAvgVolume;
  if (normalized === "volume") return row.volume;
  if (normalized === "exchange") return row.exchange;
  if (normalized === "type") return row.type;
  return (row.raw as Record<string, unknown> | null)?.[normalized];
}

function rowMatchesRules(row: TradingViewScanRow, rules: ScanPresetRule[]): boolean {
  return rules.every((rule) => valueMatchesRule(rowValueForField(row, rule.field), rule, row));
}

function normalizeScanRow(row: TradingViewScanRow): ScanSnapshotRow | null {
  const ticker = normalizeTicker(row.ticker);
  if (!ticker) return null;
  const price = asFiniteNumber(row.price);
  const avgVolume = asFiniteNumber(row.avgVolume);
  const priceAvgVolume = asFiniteNumber(row.priceAvgVolume) ?? (
    price != null && avgVolume != null ? price * avgVolume : null
  );
  return {
    ticker,
    name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : null,
    sector: typeof row.sector === "string" && row.sector.trim() ? row.sector.trim() : null,
    industry: typeof row.industry === "string" && row.industry.trim() ? row.industry.trim() : null,
    change1d: asFiniteNumber(row.change1d),
    marketCap: asFiniteNumber(row.marketCap),
    relativeVolume: asFiniteNumber(row.relativeVolume),
    price,
    avgVolume,
    priceAvgVolume,
    rawJson: toJson(row.raw ?? row),
  };
}

export function normalizeScanRows(rows: TradingViewScanRow[] | null | undefined): ScanSnapshotRow[] {
  return (rows ?? [])
    .map(normalizeScanRow)
    .filter((row): row is ScanSnapshotRow => Boolean(row));
}

function sortSnapshotRows(rows: ScanSnapshotRow[], sortField: string, sortDirection: "asc" | "desc"): ScanSnapshotRow[] {
  const direction = sortDirection === "asc" ? 1 : -1;
  const normalized = normalizeFieldName(sortField);
  const valueFor = (row: ScanSnapshotRow): string | number => {
    if (normalized === "ticker") return row.ticker;
    if (normalized === "name") return row.name ?? row.ticker;
    if (normalized === "sector") return row.sector ?? "";
    if (normalized === "industry") return row.industry ?? "";
    if (normalized === "market_cap_basic") return row.marketCap ?? Number.NEGATIVE_INFINITY;
    if (normalized === "relative_volume_10d_calc") return row.relativeVolume ?? Number.NEGATIVE_INFINITY;
    if (normalized === "close") return row.price ?? Number.NEGATIVE_INFINITY;
    if (normalized === "Value.Traded") return row.priceAvgVolume ?? Number.NEGATIVE_INFINITY;
    return row.change1d ?? Number.NEGATIVE_INFINITY;
  };
  return [...rows].sort((a, b) => {
    const left = valueFor(a);
    const right = valueFor(b);
    if (typeof left === "string" || typeof right === "string") {
      const comparison = String(left).localeCompare(String(right));
      if (comparison !== 0) return comparison * direction;
      return a.ticker.localeCompare(b.ticker);
    }
    const comparison = left - right;
    if (comparison !== 0) return comparison * direction;
    return a.ticker.localeCompare(b.ticker);
  });
}

function mapPresetRow(row: {
  id: string;
  name: string;
  isDefault: number;
  isActive: number;
  rulesJson: string;
  sortField: string;
  sortDirection: "asc" | "desc";
  rowLimit: number;
  createdAt: string;
  updatedAt: string;
}): ScanPreset {
  return {
    id: row.id,
    name: row.name,
    isDefault: Boolean(row.isDefault),
    isActive: Boolean(row.isActive),
    rules: parseRules(row.rulesJson),
    sortField: row.sortField,
    sortDirection: row.sortDirection === "asc" ? "asc" : "desc",
    rowLimit: clamp(Number(row.rowLimit ?? DEFAULT_LIMIT), 1, 250),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type ScanCompilePresetQueryRow = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  scanPresetId: string | null;
  scanPresetName: string | null;
  sortOrder: number | null;
};

function aggregateCompilePresets(rows: ScanCompilePresetQueryRow[]): ScanCompilePresetDetail[] {
  const map = new Map<string, ScanCompilePresetDetail>();
  for (const row of rows) {
    let current = map.get(row.id);
    if (!current) {
      current = {
        id: row.id,
        name: row.name,
        memberCount: 0,
        presetIds: [],
        presetNames: [],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        members: [],
      };
      map.set(row.id, current);
    }
    if (!row.scanPresetId || !row.scanPresetName) continue;
    current.members.push({
      scanPresetId: row.scanPresetId,
      scanPresetName: row.scanPresetName,
      sortOrder: Number(row.sortOrder ?? current.members.length + 1),
    });
    current.presetIds.push(row.scanPresetId);
    current.presetNames.push(row.scanPresetName);
  }
  return Array.from(map.values()).map((preset) => ({
    ...preset,
    memberCount: preset.members.length,
    members: [...preset.members].sort((left, right) => left.sortOrder - right.sortOrder),
  }));
}

async function queryScanCompilePresets(env: Env, compilePresetId?: string): Promise<ScanCompilePresetDetail[]> {
  const baseQuery = `
    SELECT
      cp.id,
      cp.name,
      cp.created_at as createdAt,
      cp.updated_at as updatedAt,
      m.scan_preset_id as scanPresetId,
      sp.name as scanPresetName,
      m.sort_order as sortOrder
    FROM scan_compile_presets cp
    LEFT JOIN scan_compile_preset_members m
      ON m.compile_preset_id = cp.id
    LEFT JOIN scan_presets sp
      ON sp.id = m.scan_preset_id
    ${compilePresetId ? "WHERE cp.id = ?" : ""}
    ORDER BY datetime(cp.updated_at) DESC, datetime(cp.created_at) DESC, m.sort_order ASC, sp.name ASC
  `;
  const request = env.DB.prepare(baseQuery);
  const rows = compilePresetId
    ? await request.bind(compilePresetId).all<ScanCompilePresetQueryRow>()
    : await request.all<ScanCompilePresetQueryRow>();
  return aggregateCompilePresets(rows.results ?? []);
}

export async function listScanCompilePresets(env: Env): Promise<ScanCompilePresetRow[]> {
  return (await queryScanCompilePresets(env)).map(({ members, ...preset }) => preset);
}

export async function loadScanCompilePreset(env: Env, compilePresetId: string): Promise<ScanCompilePresetDetail | null> {
  return (await queryScanCompilePresets(env, compilePresetId))[0] ?? null;
}

async function resolveCompilePresetMemberIds(env: Env, scanPresetIds: string[]): Promise<string[]> {
  const normalized = Array.from(new Set(
    scanPresetIds
      .map((value) => value.trim())
      .filter(Boolean),
  ));
  if (normalized.length === 0) throw new Error("Choose at least one scan preset.");
  const existingPresets = await Promise.all(normalized.map((presetId) => loadScanPreset(env, presetId)));
  const missingIds = normalized.filter((_, index) => !existingPresets[index]);
  if (missingIds.length > 0) {
    throw new Error(`Unknown scan preset: ${missingIds[0]}`);
  }
  return normalized;
}

export async function upsertScanCompilePreset(env: Env, input: {
  id?: string | null;
  name: string;
  scanPresetIds: string[];
}): Promise<ScanCompilePresetDetail> {
  const id = input.id?.trim() || crypto.randomUUID();
  const scanPresetIds = await resolveCompilePresetMemberIds(env, input.scanPresetIds);
  const name = input.name.trim();
  if (!name) throw new Error("Compile preset name is required.");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO scan_compile_presets (id, name, created_at, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(id, name),
    env.DB.prepare("DELETE FROM scan_compile_preset_members WHERE compile_preset_id = ?").bind(id),
    ...scanPresetIds.map((presetId, index) =>
      env.DB.prepare(
        "INSERT INTO scan_compile_preset_members (compile_preset_id, scan_preset_id, sort_order) VALUES (?, ?, ?)",
      ).bind(id, presetId, index + 1),
    ),
  ]);
  const saved = await loadScanCompilePreset(env, id);
  if (!saved) throw new Error("Failed to persist scan compile preset.");
  return saved;
}

export async function deleteScanCompilePreset(env: Env, compilePresetId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM scan_compile_preset_members WHERE compile_preset_id = ?").bind(compilePresetId),
    env.DB.prepare("DELETE FROM scan_compile_presets WHERE id = ?").bind(compilePresetId),
  ]);
}

async function listReferencingCompilePresetNames(env: Env, scanPresetId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT cp.name as name
     FROM scan_compile_presets cp
     JOIN scan_compile_preset_members m
       ON m.compile_preset_id = cp.id
     WHERE m.scan_preset_id = ?
     ORDER BY datetime(cp.updated_at) DESC, datetime(cp.created_at) DESC, cp.name ASC`,
  ).bind(scanPresetId).all<{ name: string }>();
  return (rows.results ?? []).map((row) => row.name).filter(Boolean);
}

function nextDuplicatePresetName(sourceName: string, existingNames: string[]): string {
  const trimmedSourceName = sourceName.trim();
  const occupied = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  const firstCandidate = `${trimmedSourceName} Copy`;
  if (!occupied.has(firstCandidate.toLowerCase())) return firstCandidate;
  let counter = 2;
  while (occupied.has(`${trimmedSourceName} Copy ${counter}`.toLowerCase())) {
    counter += 1;
  }
  return `${trimmedSourceName} Copy ${counter}`;
}

export async function listScanPresets(env: Env): Promise<ScanPreset[]> {
  const rows = await env.DB.prepare(
    "SELECT id, name, is_default as isDefault, is_active as isActive, rules_json as rulesJson, sort_field as sortField, sort_direction as sortDirection, row_limit as rowLimit, created_at as createdAt, updated_at as updatedAt FROM scan_presets ORDER BY is_default DESC, updated_at DESC, created_at DESC",
  ).all<{
    id: string;
    name: string;
    isDefault: number;
    isActive: number;
    rulesJson: string;
    sortField: string;
    sortDirection: "asc" | "desc";
    rowLimit: number;
    createdAt: string;
    updatedAt: string;
  }>();
  return (rows.results ?? []).map(mapPresetRow);
}

export async function loadScanPreset(env: Env, presetId: string): Promise<ScanPreset | null> {
  const row = await env.DB.prepare(
    "SELECT id, name, is_default as isDefault, is_active as isActive, rules_json as rulesJson, sort_field as sortField, sort_direction as sortDirection, row_limit as rowLimit, created_at as createdAt, updated_at as updatedAt FROM scan_presets WHERE id = ? LIMIT 1",
  )
    .bind(presetId)
    .first<{
      id: string;
      name: string;
      isDefault: number;
      isActive: number;
      rulesJson: string;
      sortField: string;
      sortDirection: "asc" | "desc";
      rowLimit: number;
      createdAt: string;
      updatedAt: string;
    }>();
  return row ? mapPresetRow(row) : null;
}

export async function loadDefaultScanPreset(env: Env): Promise<ScanPreset | null> {
  const row = await env.DB.prepare(
    "SELECT id, name, is_default as isDefault, is_active as isActive, rules_json as rulesJson, sort_field as sortField, sort_direction as sortDirection, row_limit as rowLimit, created_at as createdAt, updated_at as updatedAt FROM scan_presets WHERE is_default = 1 LIMIT 1",
  ).first<{
    id: string;
    name: string;
    isDefault: number;
    isActive: number;
    rulesJson: string;
    sortField: string;
    sortDirection: "asc" | "desc";
    rowLimit: number;
    createdAt: string;
    updatedAt: string;
  }>();
  if (row) return mapPresetRow(row);
  const presets = await listScanPresets(env);
  return presets[0] ?? null;
}

export async function upsertScanPreset(env: Env, input: {
  id?: string | null;
  name: string;
  isDefault?: boolean;
  isActive?: boolean;
  rules: ScanPresetRule[];
  sortField?: string;
  sortDirection?: "asc" | "desc";
  rowLimit?: number;
}): Promise<ScanPreset> {
  const id = input.id?.trim() || crypto.randomUUID();
  const isDefault = input.isDefault === true;
  if (isDefault) {
    await env.DB.prepare("UPDATE scan_presets SET is_default = 0 WHERE is_default = 1").run();
  }
  await env.DB.prepare(
    `INSERT INTO scan_presets (id, name, is_default, is_active, rules_json, sort_field, sort_direction, row_limit, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       is_default = excluded.is_default,
       is_active = excluded.is_active,
       rules_json = excluded.rules_json,
       sort_field = excluded.sort_field,
       sort_direction = excluded.sort_direction,
       row_limit = excluded.row_limit,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      id,
      input.name.trim(),
      isDefault ? 1 : 0,
      input.isActive === false ? 0 : 1,
      JSON.stringify(input.rules),
      input.sortField?.trim() || "change",
      input.sortDirection === "asc" ? "asc" : "desc",
      clamp(Number(input.rowLimit ?? DEFAULT_LIMIT), 1, 250),
    )
    .run();

  const saved = await loadScanPreset(env, id);
  if (!saved) throw new Error("Failed to persist scan preset.");
  return saved;
}

export async function duplicateScanPreset(env: Env, presetId: string): Promise<ScanPreset> {
  const existing = await loadScanPreset(env, presetId);
  if (!existing) throw new Error("Scan preset not found.");
  const name = nextDuplicatePresetName(existing.name, (await listScanPresets(env)).map((preset) => preset.name));
  return upsertScanPreset(env, {
    name,
    isDefault: false,
    isActive: existing.isActive,
    rules: JSON.parse(JSON.stringify(existing.rules)) as ScanPresetRule[],
    sortField: existing.sortField,
    sortDirection: existing.sortDirection,
    rowLimit: existing.rowLimit,
  });
}

export async function deleteScanPreset(env: Env, presetId: string): Promise<void> {
  const preset = await loadScanPreset(env, presetId);
  if (!preset) return;
  if (preset.isDefault) throw new Error("Default preset cannot be deleted.");
  const compilePresetNames = await listReferencingCompilePresetNames(env, presetId);
  if (compilePresetNames.length > 0) {
    throw new Error(`Cannot delete scan preset because it is used by compile presets: ${compilePresetNames.join(", ")}`);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM scan_rows WHERE snapshot_id IN (SELECT id FROM scan_snapshots WHERE preset_id = ?)").bind(presetId),
    env.DB.prepare("DELETE FROM scan_snapshots WHERE preset_id = ?").bind(presetId),
    env.DB.prepare("DELETE FROM scan_presets WHERE id = ?").bind(presetId),
  ]);
}

function hasPostFilters(preset: ScanPreset): boolean {
  return preset.rules.some((rule) => !shouldPushRuleUpstream(rule));
}

function paginatedFetchTarget(preset: ScanPreset): number {
  return clamp(Math.max(preset.rowLimit * 20, MAX_FETCH_RANGE * 2), MAX_FETCH_RANGE * 2, MAX_PAGINATED_FETCH_TOTAL);
}

function buildTradingViewScanPayload(
  preset: ScanPreset,
  options?: { rangeOffset?: number; rangeLimit?: number },
): TradingViewScanPayload {
  const baseColumns = [
    "name",
    "sector",
    "industry",
    "change",
    "market_cap_basic",
    "relative_volume_10d_calc",
    "close",
    "average_volume_30d_calc",
    "Value.Traded",
    "volume",
    "exchange",
    "type",
  ];
  const extraColumns = Array.from(new Set(
    preset.rules
      .flatMap((rule) => {
        const fields = [normalizeFieldName(rule.field)];
        if (isFieldReferenceValue(rule.value)) fields.push(normalizeFieldName(rule.value.field));
        return fields;
      })
      .concat([normalizeFieldName(preset.sortField)])
      .filter((field) => field && field !== "ticker" && !baseColumns.includes(field)),
  ));
  const rangeOffset = Math.max(0, options?.rangeOffset ?? 0);
  const rangeLimit = Math.max(1, options?.rangeLimit ?? (
    hasPostFilters(preset)
      ? Math.min(paginatedFetchTarget(preset), MAX_FETCH_RANGE)
      : clamp(preset.rowLimit, 1, MAX_FETCH_RANGE)
  ));
  return {
    markets: ["america"],
    symbols: { query: { types: [] }, tickers: [] },
    options: { lang: "en" },
    columns: [...baseColumns, ...extraColumns],
    sort: {
      sortBy: normalizeFieldName(preset.sortField) || "change",
      sortOrder: preset.sortDirection === "asc" ? "asc" : "desc",
    },
    range: [rangeOffset, rangeLimit],
    filter: preset.rules
      .map(mapRuleToTradingViewFilter)
      .filter((filter): filter is TradingViewFilter => Boolean(filter)),
  };
}

function mapTradingViewResponse(payload: TradingViewScanPayload, body: {
  data?: Array<{ s?: string; d?: unknown[] }>;
}): TradingViewScanRow[] {
  const columns = payload.columns;
  return (body.data ?? []).map((entry) => {
    const data = Array.isArray(entry.d) ? entry.d : [];
    const raw = Object.fromEntries(columns.map((column, index) => [column, data[index] ?? null])) as Record<string, unknown>;
    return {
      ticker: entry.s ?? null,
      name: typeof raw.name === "string" ? raw.name : null,
      sector: typeof raw.sector === "string" ? raw.sector : null,
      industry: typeof raw.industry === "string" ? raw.industry : null,
      change1d: typeof raw.change === "string" || typeof raw.change === "number" ? raw.change : null,
      marketCap: typeof raw.market_cap_basic === "string" || typeof raw.market_cap_basic === "number" ? raw.market_cap_basic : null,
      relativeVolume: typeof raw.relative_volume_10d_calc === "string" || typeof raw.relative_volume_10d_calc === "number" ? raw.relative_volume_10d_calc : null,
      price: typeof raw.close === "string" || typeof raw.close === "number" ? raw.close : null,
      avgVolume: typeof raw.average_volume_30d_calc === "string" || typeof raw.average_volume_30d_calc === "number" ? raw.average_volume_30d_calc : null,
      priceAvgVolume: typeof raw["Value.Traded"] === "string" || typeof raw["Value.Traded"] === "number" ? raw["Value.Traded"] : null,
      volume: typeof raw.volume === "string" || typeof raw.volume === "number" ? raw.volume : null,
      exchange: typeof raw.exchange === "string" ? raw.exchange : null,
      type: typeof raw.type === "string" ? raw.type : null,
      raw,
    };
  });
}

async function fetchTradingViewScanRows(preset: ScanPreset): Promise<{
  providerLabel: string;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
  rows: ScanSnapshotRow[];
}> {
  const candidates: TradingViewScanRow[] = [];
  const usePagination = hasPostFilters(preset);
  let targetFetchCount = usePagination ? paginatedFetchTarget(preset) : clamp(preset.rowLimit, 1, MAX_FETCH_RANGE);
  let hasKnownTotalCount = false;

  for (let rangeOffset = 0; rangeOffset < targetFetchCount; rangeOffset += MAX_FETCH_RANGE) {
    const rangeLimit = Math.min(MAX_FETCH_RANGE, targetFetchCount - rangeOffset);
    const payload = buildTradingViewScanPayload(preset, { rangeOffset, rangeLimit });
    const response = await fetch(TV_SCAN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "market-command-centre/1.0",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`TradingView scans request failed (${response.status}): ${body.slice(0, 180)}`);
    }
    const body = await response.json() as { totalCount?: number; data?: Array<{ s?: string; d?: unknown[] }> };
    if (typeof body.totalCount === "number" && Number.isFinite(body.totalCount) && body.totalCount > targetFetchCount) {
      hasKnownTotalCount = true;
      targetFetchCount = Math.min(body.totalCount, MAX_PAGINATED_FETCH_TOTAL);
    } else if (typeof body.totalCount === "number" && Number.isFinite(body.totalCount)) {
      hasKnownTotalCount = true;
    }
    const pageRows = mapTradingViewResponse(payload, body);
    const pageMatches = pageRows.filter((row) => rowMatchesRules(row, preset.rules));
    candidates.push(...pageMatches);

    if (!usePagination || pageRows.length === 0 || (!hasKnownTotalCount && pageRows.length < rangeLimit)) {
      break;
    }
  }

  const rows = sortSnapshotRows(normalizeScanRows(candidates), preset.sortField, preset.sortDirection)
    .slice(0, preset.rowLimit);
  return {
    providerLabel: TV_PROVIDER_LABEL,
    status: rows.length > 0 ? "ok" : "empty",
    error: null,
    rows,
  };
}

async function upsertSymbolsFromRows(env: Env, rows: ScanSnapshotRow[]): Promise<void> {
  const statements = rows.map((row) =>
    env.DB.prepare(
      `INSERT INTO symbols (ticker, name, exchange, asset_class, sector, industry, updated_at)
       VALUES (?, ?, NULL, 'equity', ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(ticker) DO UPDATE SET
         name = COALESCE(excluded.name, symbols.name),
         sector = COALESCE(excluded.sector, symbols.sector),
         industry = COALESCE(excluded.industry, symbols.industry),
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(row.ticker, row.name ?? row.ticker, row.sector ?? null, row.industry ?? null),
  );
  if (statements.length > 0) await env.DB.batch(statements);
}

type ScanSnapshotHeader = {
  id: string;
  presetId: string;
  providerLabel: string;
  generatedAt: string;
  rowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
};

async function loadLatestScanSnapshotHeader(
  env: Env,
  presetId: string,
  options?: { usableOnly?: boolean },
): Promise<ScanSnapshotHeader | null> {
  const clauses = ["preset_id = ?"];
  if (options?.usableOnly) clauses.push("status != 'error'");
  return env.DB.prepare(
    `SELECT
       id,
       preset_id as presetId,
       provider_label as providerLabel,
       generated_at as generatedAt,
       row_count as rowCount,
       status,
       error
     FROM scan_snapshots
     WHERE ${clauses.join(" AND ")}
     ORDER BY datetime(generated_at) DESC
     LIMIT 1`,
  )
    .bind(presetId)
    .first<ScanSnapshotHeader>();
}

async function loadScanSnapshotRows(env: Env, snapshotId: string): Promise<ScanSnapshotRow[]> {
  const rows = await env.DB.prepare(
    "SELECT ticker, name, sector, industry, change_1d as change1d, market_cap as marketCap, price, avg_volume as avgVolume, price_avg_volume as priceAvgVolume, raw_json as rawJson FROM scan_rows WHERE snapshot_id = ? ORDER BY change_1d DESC, ticker ASC",
  )
    .bind(snapshotId)
    .all<ScanSnapshotRow>();
  return (rows.results ?? []).map((row) => {
    let relativeVolume: number | null = null;
    try {
      const raw = row.rawJson ? JSON.parse(row.rawJson) as Record<string, unknown> : null;
      const candidate = raw?.relative_volume_10d_calc ?? raw?.relative_volume;
      relativeVolume = asFiniteNumber(candidate);
    } catch {
      relativeVolume = null;
    }
    return { ...row, relativeVolume };
  });
}

async function hydrateScanSnapshot(
  env: Env,
  preset: ScanPreset,
  snapshot: ScanSnapshotHeader,
): Promise<ScanSnapshot> {
  return {
    id: snapshot.id,
    presetId: preset.id,
    presetName: preset.name,
    providerLabel: snapshot.providerLabel,
    generatedAt: snapshot.generatedAt,
    rowCount: snapshot.rowCount,
    status: snapshot.status,
    error: snapshot.error,
    rows: await loadScanSnapshotRows(env, snapshot.id),
  };
}

export async function refreshScansSnapshot(env: Env, presetId?: string | null): Promise<ScanSnapshot> {
  const preset = presetId ? await loadScanPreset(env, presetId) : await loadDefaultScanPreset(env);
  if (!preset) throw new Error("No scan preset is configured.");
  const snapshotId = crypto.randomUUID();

  try {
    const result = await fetchTradingViewScanRows(preset);
    await upsertSymbolsFromRows(env, result.rows);
    const statements = [
      env.DB.prepare(
        "INSERT INTO scan_snapshots (id, preset_id, provider_label, generated_at, row_count, status, error) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)",
      ).bind(snapshotId, preset.id, result.providerLabel, result.rows.length, result.status, result.error),
      ...result.rows.map((row) =>
        env.DB.prepare(
          "INSERT INTO scan_rows (id, snapshot_id, ticker, name, sector, industry, change_1d, market_cap, price, avg_volume, price_avg_volume, raw_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
        ).bind(
          crypto.randomUUID(),
          snapshotId,
          row.ticker,
          row.name ?? null,
          row.sector ?? null,
          row.industry ?? null,
          row.change1d,
          row.marketCap,
          row.price,
          row.avgVolume,
          row.priceAvgVolume,
          row.rawJson,
        ),
      ),
    ];
    await env.DB.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scan refresh failed.";
    await env.DB.prepare(
      "INSERT INTO scan_snapshots (id, preset_id, provider_label, generated_at, row_count, status, error) VALUES (?, ?, ?, CURRENT_TIMESTAMP, 0, 'error', ?)",
    )
      .bind(snapshotId, preset.id, TV_PROVIDER_LABEL, message)
      .run();
  }

  const snapshot = await loadLatestScansSnapshot(env, preset.id);
  if (!snapshot) throw new Error("Failed to load refreshed scan snapshot.");
  return snapshot;
}

export async function loadLatestScansSnapshot(env: Env, presetId?: string | null): Promise<ScanSnapshot | null> {
  const preset = presetId ? await loadScanPreset(env, presetId) : await loadDefaultScanPreset(env);
  if (!preset) return null;
  const snapshot = await loadLatestScanSnapshotHeader(env, preset.id);
  if (!snapshot) return null;
  return hydrateScanSnapshot(env, preset, snapshot);
}

export async function loadLatestUsableScansSnapshot(env: Env, presetId?: string | null): Promise<ScanSnapshot | null> {
  const preset = presetId ? await loadScanPreset(env, presetId) : await loadDefaultScanPreset(env);
  if (!preset) return null;
  const snapshot = await loadLatestScanSnapshotHeader(env, preset.id, { usableOnly: true });
  if (!snapshot) return null;
  return hydrateScanSnapshot(env, preset, snapshot);
}

export async function loadCompiledScansSnapshot(
  env: Env,
  presetIds: string[],
  options?: { compilePresetId?: string | null; compilePresetName?: string | null },
): Promise<CompiledScansSnapshot> {
  const uniquePresetIds = Array.from(new Set(
    presetIds
      .map((value) => value.trim())
      .filter(Boolean),
  ));
  const presets = (await Promise.all(uniquePresetIds.map((presetId) => loadScanPreset(env, presetId))))
    .filter((preset): preset is ScanPreset => Boolean(preset));
  const snapshots = await Promise.all(presets.map((preset) => loadLatestUsableScansSnapshot(env, preset.id)));
  const rowMap = new Map<string, CompiledScanUniqueTickerRow>();
  const rowTimestampMap = new Map<string, string>();
  let latestGeneratedAt = "";

  snapshots.forEach((snapshot, index) => {
    if (!snapshot) return;
    const preset = presets[index];
    if (!preset) return;
    if (snapshot.generatedAt > latestGeneratedAt) latestGeneratedAt = snapshot.generatedAt;
    for (const row of snapshot.rows) {
      const existing = rowMap.get(row.ticker);
      if (!existing) {
        rowMap.set(row.ticker, {
          ticker: row.ticker,
          name: row.name,
          sector: row.sector,
          industry: row.industry,
          occurrences: 1,
          presetIds: [preset.id],
          presetNames: [preset.name],
          latestPrice: row.price,
          latestChange1d: row.change1d,
          latestMarketCap: row.marketCap,
          latestRelativeVolume: row.relativeVolume,
        });
        rowTimestampMap.set(row.ticker, snapshot.generatedAt);
        continue;
      }
      existing.occurrences += 1;
      if (!existing.name && row.name) existing.name = row.name;
      if (!existing.sector && row.sector) existing.sector = row.sector;
      if (!existing.industry && row.industry) existing.industry = row.industry;
      if (!existing.presetIds.includes(preset.id)) existing.presetIds.push(preset.id);
      if (!existing.presetNames.includes(preset.name)) existing.presetNames.push(preset.name);
      const currentTimestamp = rowTimestampMap.get(row.ticker) ?? "";
      if (snapshot.generatedAt >= currentTimestamp) {
        existing.latestPrice = row.price;
        existing.latestChange1d = row.change1d;
        existing.latestMarketCap = row.marketCap;
        existing.latestRelativeVolume = row.relativeVolume;
        rowTimestampMap.set(row.ticker, snapshot.generatedAt);
      }
    }
  });

  return {
    compilePresetId: options?.compilePresetId ?? null,
    compilePresetName: options?.compilePresetName ?? null,
    presetIds: presets.map((preset) => preset.id),
    presetNames: presets.map((preset) => preset.name),
    generatedAt: latestGeneratedAt || new Date().toISOString(),
    rows: Array.from(rowMap.values()).sort((a, b) => {
      if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
      const left = a.latestChange1d ?? Number.NEGATIVE_INFINITY;
      const right = b.latestChange1d ?? Number.NEGATIVE_INFINITY;
      if (right !== left) return right - left;
      return a.ticker.localeCompare(b.ticker);
    }),
  };
}

export async function loadCompiledScansSnapshotForCompilePreset(env: Env, compilePresetId: string): Promise<CompiledScansSnapshot> {
  const compilePreset = await loadScanCompilePreset(env, compilePresetId);
  if (!compilePreset) throw new Error("Scan compile preset not found.");
  return loadCompiledScansSnapshot(env, compilePreset.presetIds, {
    compilePresetId: compilePreset.id,
    compilePresetName: compilePreset.name,
  });
}

export async function refreshScanCompilePreset(env: Env, compilePresetId: string): Promise<ScanCompilePresetRefreshResult> {
  const compilePreset = await loadScanCompilePreset(env, compilePresetId);
  if (!compilePreset) throw new Error("Scan compile preset not found.");

  const memberResults: ScanCompilePresetRefreshMemberResult[] = [];
  for (const member of compilePreset.members) {
    const refreshedSnapshot = await refreshScansSnapshot(env, member.scanPresetId);
    const usableSnapshot = refreshedSnapshot.status === "error"
      ? await loadLatestUsableScansSnapshot(env, member.scanPresetId)
      : refreshedSnapshot;
    memberResults.push({
      presetId: member.scanPresetId,
      presetName: member.scanPresetName,
      status: refreshedSnapshot.status,
      rowCount: usableSnapshot?.rowCount ?? 0,
      error: refreshedSnapshot.error,
      snapshot: refreshedSnapshot,
      usableSnapshot,
      usedFallback: refreshedSnapshot.status === "error" && Boolean(usableSnapshot),
      includedInCompiled: Boolean(usableSnapshot),
    });
  }

  const snapshot = await loadCompiledScansSnapshot(env, compilePreset.presetIds, {
    compilePresetId: compilePreset.id,
    compilePresetName: compilePreset.name,
  });

  return {
    compilePresetId: compilePreset.id,
    compilePresetName: compilePreset.name,
    refreshedCount: memberResults.filter((result) => result.status !== "error").length,
    failedCount: memberResults.filter((result) => result.status === "error").length,
    snapshot,
    memberResults,
  };
}

export async function cleanupOldScansPageData(env: Env, retentionDays = RETENTION_DAYS): Promise<void> {
  const window = `-${Math.max(1, retentionDays)} day`;
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM scan_rows WHERE snapshot_id IN (SELECT id FROM scan_snapshots WHERE datetime(generated_at) < datetime('now', ?))",
    ).bind(window),
    env.DB.prepare("DELETE FROM scan_snapshots WHERE datetime(generated_at) < datetime('now', ?)").bind(window),
  ]);
}

export { buildTradingViewScanPayload, fetchTradingViewScanRows };
