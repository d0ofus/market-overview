import { describe, expect, it, vi } from "vitest";
import {
  buildTradingViewScanPayload,
  deleteScanPreset,
  duplicateScanPreset,
  fetchTradingViewScanRows,
  loadCompiledScansSnapshot,
  loadCompiledScansSnapshotForCompilePreset,
  normalizeScanRows,
  refreshScanCompilePreset,
  type ScanPreset,
  type ScanSnapshot,
  type ScanSnapshotRow,
} from "../src/scans-page-service";

const topGainersPreset: ScanPreset = {
  id: "scan-preset-top-gainers",
  name: "Top Gainers",
  isDefault: true,
  isActive: true,
  rules: [
    { id: "close", field: "close", operator: "gt", value: 1 },
    { id: "change", field: "change", operator: "gt", value: 3 },
    { id: "type", field: "type", operator: "in", value: ["stock", "dr"] },
    { id: "exchange", field: "exchange", operator: "in", value: ["NASDAQ", "NYSE", "AMEX"] },
    { id: "volume", field: "volume", operator: "gt", value: 100000 },
    { id: "traded", field: "Value.Traded", operator: "gt", value: 10000000 },
    {
      id: "industry",
      field: "industry",
      operator: "not_in",
      value: [
        "Biotechnology",
        "Pharmaceuticals: generic",
        "Pharmaceuticals: major",
        "Pharmaceuticals: other",
      ],
    },
  ],
  sortField: "change",
  sortDirection: "desc",
  rowLimit: 100,
  createdAt: "",
  updatedAt: "",
};

type MutableCompilePreset = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  members: Array<{ scanPresetId: string; scanPresetName: string; sortOrder: number }>;
};

type MutableSnapshot = {
  id: string;
  presetId: string;
  providerLabel: string;
  generatedAt: string;
  rowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
};

function createMutableScansEnv(input: {
  presets: ScanPreset[];
  compilePresets?: MutableCompilePreset[];
  snapshots?: MutableSnapshot[];
  rowsBySnapshotId?: Record<string, ScanSnapshotRow[]>;
}) {
  const presets = [...input.presets];
  const compilePresets = [...(input.compilePresets ?? [])];
  const snapshots = [...(input.snapshots ?? [])];
  const rowsBySnapshotId = new Map<string, ScanSnapshotRow[]>(
    Object.entries(input.rowsBySnapshotId ?? {}).map(([snapshotId, rows]) => [snapshotId, [...rows]]),
  );
  let generatedCounter = snapshots.length;

  const nextGeneratedAt = () => {
    generatedCounter += 1;
    return `2026-03-18T${String(generatedCounter).padStart(2, "0")}:00:00.000Z`;
  };

  const buildCompilePresetRows = (compilePresetId?: string) =>
    compilePresets
      .filter((preset) => !compilePresetId || preset.id === compilePresetId)
      .flatMap((preset) => (
        preset.members.length > 0
          ? preset.members.map((member) => ({
            id: preset.id,
            name: preset.name,
            createdAt: preset.createdAt,
            updatedAt: preset.updatedAt,
            scanPresetId: member.scanPresetId,
            scanPresetName: member.scanPresetName,
            sortOrder: member.sortOrder,
          }))
          : [{
            id: preset.id,
            name: preset.name,
            createdAt: preset.createdAt,
            updatedAt: preset.updatedAt,
            scanPresetId: null,
            scanPresetName: null,
            sortOrder: null,
          }]
      ));

  const env = {
    DB: {
      prepare(sql: string) {
        const makeBound = (args: unknown[]) => ({
          __sql: sql,
          __args: args,
          async first<T>() {
            if (sql.includes("FROM scan_presets WHERE id = ?")) {
              return presets.find((row) => row.id === args[0]) ?? null as T;
            }
            if (sql.includes("FROM scan_snapshots")) {
              const presetId = String(args[0] ?? "");
              const usableOnly = sql.includes("status != 'error'");
              const candidate = snapshots
                .filter((row) => row.presetId === presetId && (!usableOnly || row.status !== "error"))
                .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))[0] ?? null;
              return candidate as T;
            }
            return null as T;
          },
          async all<T>() {
            if (sql.includes("FROM scan_compile_presets cp")) {
              const compilePresetId = sql.includes("WHERE cp.id = ?") ? String(args[0] ?? "") : undefined;
              return { results: buildCompilePresetRows(compilePresetId) as T[] };
            }
            if (sql.includes("FROM scan_rows WHERE snapshot_id = ?")) {
              return { results: (rowsBySnapshotId.get(String(args[0] ?? "")) ?? []) as T[] };
            }
            if (sql.includes("FROM scan_compile_presets cp")) {
              return { results: [] as T[] };
            }
            return { results: [] as T[] };
          },
          async run() {
            if (sql.includes("INSERT INTO scan_snapshots")) {
              const [id, presetId, providerLabel, errorOrRowCount, maybeStatus, maybeError] = args;
              if (args.length >= 4) {
                const rowCount = args.length === 4 ? 0 : Number(errorOrRowCount ?? 0);
                const status = args.length === 4 ? "error" : String(maybeStatus ?? "ok");
                const error = args.length === 4 ? String(errorOrRowCount ?? "") : (maybeError == null ? null : String(maybeError));
                snapshots.push({
                  id: String(id),
                  presetId: String(presetId),
                  providerLabel: String(providerLabel),
                  generatedAt: nextGeneratedAt(),
                  rowCount,
                  status: status as MutableSnapshot["status"],
                  error,
                });
              }
            }
            return {};
          },
        });

        return {
          bind(...args: unknown[]) {
            return makeBound(args);
          },
          async all<T>() {
            if (sql.includes("FROM scan_presets ORDER BY")) {
              return { results: presets as T[] };
            }
            return { results: [] as T[] };
          },
          async first<T>() {
            return null as T;
          },
          async run() {
            return {};
          },
        };
      },
      async batch(statements: Array<{ __sql?: string; __args?: unknown[] }>) {
        for (const statement of statements) {
          if (!statement.__sql) continue;
          if (statement.__sql.includes("INSERT INTO scan_snapshots")) {
            const [id, presetId, providerLabel, rowCount, status, error] = statement.__args ?? [];
            snapshots.push({
              id: String(id),
              presetId: String(presetId),
              providerLabel: String(providerLabel),
              generatedAt: nextGeneratedAt(),
              rowCount: Number(rowCount ?? 0),
              status: String(status ?? "ok") as MutableSnapshot["status"],
              error: error == null ? null : String(error),
            });
            continue;
          }
          if (statement.__sql.includes("INSERT INTO scan_rows")) {
            const [id, snapshotId, ticker, name, sector, industry, change1d, marketCap, price, avgVolume, priceAvgVolume, rawJson] = statement.__args ?? [];
            const rows = rowsBySnapshotId.get(String(snapshotId)) ?? [];
            rows.push({
              ticker: String(ticker),
              name: name == null ? null : String(name),
              sector: sector == null ? null : String(sector),
              industry: industry == null ? null : String(industry),
              change1d: change1d == null ? null : Number(change1d),
              marketCap: marketCap == null ? null : Number(marketCap),
              relativeVolume: null,
              price: price == null ? null : Number(price),
              avgVolume: avgVolume == null ? null : Number(avgVolume),
              priceAvgVolume: priceAvgVolume == null ? null : Number(priceAvgVolume),
              rawJson: rawJson == null ? null : String(rawJson),
            });
            rowsBySnapshotId.set(String(snapshotId), rows);
            void id;
          }
        }
        return [];
      },
    },
  } as any;

  return { env, snapshots, rowsBySnapshotId };
}

describe("scans page service", () => {
  it("normalizes rows, computes price * avg volume fallback, and sorts by 1D change descending", () => {
    const rows = normalizeScanRows([
      {
        ticker: "NASDAQ:MSFT",
        name: "Microsoft",
        sector: "Technology",
        industry: "Software",
        change1d: 4.2,
        marketCap: 3_000_000_000_000,
        relativeVolume: 1.3,
        price: 420,
        avgVolume: 20_000_000,
      },
      {
        ticker: "nyse:abc",
        name: "ABC Corp",
        sector: "Industrials",
        industry: "Machinery",
        change1d: 8.5,
        marketCap: "1200000000",
        relativeVolume: "2.75",
        price: "12.5",
        avgVolume: "2500000",
        raw: { source: "tv" },
      },
      {
        ticker: "",
        name: "Invalid",
        change1d: 99,
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ticker: "MSFT",
      name: "Microsoft",
      relativeVolume: 1.3,
      priceAvgVolume: 8_400_000_000,
    });
    expect(rows[1]).toMatchObject({
      ticker: "ABC",
      name: "ABC Corp",
      change1d: 8.5,
      marketCap: 1_200_000_000,
      price: 12.5,
      avgVolume: 2_500_000,
      relativeVolume: 2.75,
      priceAvgVolume: 31_250_000,
    });
  });

  it("builds a tradingview payload that pushes numeric rules upstream and expands fetch size for post-filters", () => {
    const payload = buildTradingViewScanPayload(topGainersPreset);

    expect(payload.sort).toEqual({ sortBy: "change", sortOrder: "desc" });
    expect(payload.range).toEqual([0, 1000]);
    expect(payload.filter).toEqual([
      { left: "close", operation: "greater", right: 1 },
      { left: "change", operation: "greater", right: 3 },
      { left: "volume", operation: "greater", right: 100000 },
      { left: "Value.Traded", operation: "greater", right: 10000000 },
    ]);
  });

  it("keeps field-reference rules as post-filters and fetches the comparison field column", () => {
    const payload = buildTradingViewScanPayload({
      ...topGainersPreset,
      rules: [
        { id: "ema5-max", field: "EMA5", operator: "lte", value: { type: "field", field: "close", multiplier: 1 } },
        { id: "ema5-min", field: "EMA5", operator: "gte", value: { type: "field", field: "close", multiplier: 0.97 } },
      ],
    });

    expect(payload.filter).toEqual([
      { left: "EMA5", operation: "eless", right: "close" },
    ]);
    expect(payload.columns).toContain("EMA5");
    expect(payload.columns).toContain("close");
    expect(payload.range).toEqual([0, 1000]);
  });

  it("applies string post-filters after the TradingView response is parsed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            s: "NASDAQ:NVDA",
            d: ["NVIDIA", "Technology", "Semiconductors", 5.7, 2_000_000_000_000, 1.8, 910, 45_000_000, 40_950_000_000, 60_000_000, "NASDAQ", "stock"],
          },
          {
            s: "NASDAQ:BIOX",
            d: ["Bio X", "Health Care", "Biotechnology", 2_500_000_000, 1.1, 6.2, 9.4, 4_000_000, 37_600_000, 8_000_000, "NASDAQ", "stock"],
          },
          {
            s: "OTC:OTCC",
            d: ["OTC Co", "Technology", "Software", 8.2, 900_000_000, 0.8, 5.5, 2_000_000, 11_000_000, 3_000_000, "OTC", "stock"],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTradingViewScanRows(topGainersPreset);

    expect(result.status).toBe("ok");
    expect(result.rows.map((row) => row.ticker)).toEqual(["NVDA"]);
    expect(result.rows[0]?.relativeVolume).toBe(1.8);
    vi.unstubAllGlobals();
  });

  it("applies field-reference comparisons after the TradingView response is parsed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            s: "NASDAQ:PASS",
            d: ["Pass Corp", "Technology", "Software", 4.1, 500_000_000, 1.5, 100, 5_000_000, 500_000_000, 6_000_000, "NASDAQ", "stock", 98],
          },
          {
            s: "NASDAQ:TOOLOW",
            d: ["Too Low", "Technology", "Software", 3.7, 400_000_000, 1.2, 100, 4_000_000, 400_000_000, 5_000_000, "NASDAQ", "stock", 96],
          },
          {
            s: "NASDAQ:TOOHIGH",
            d: ["Too High", "Technology", "Software", 3.9, 450_000_000, 1.3, 100, 4_500_000, 450_000_000, 5_500_000, "NASDAQ", "stock", 101],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTradingViewScanRows({
      ...topGainersPreset,
      rules: [
        { id: "type", field: "type", operator: "in", value: ["stock"] },
        { id: "exchange", field: "exchange", operator: "in", value: ["NASDAQ"] },
        { id: "ema5-max", field: "EMA5", operator: "lte", value: { type: "field", field: "close", multiplier: 1 } },
        { id: "ema5-min", field: "EMA5", operator: "gte", value: { type: "field", field: "close", multiplier: 0.97 } },
      ],
    });

    expect(result.status).toBe("ok");
    expect(result.rows.map((row) => row.ticker)).toEqual(["PASS"]);
    vi.unstubAllGlobals();
  });

  it("pages through upstream-sorted results so post-filters are not biased to the first market-cap slice", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { range?: [number, number] };
      const rangeStart = payload.range?.[0] ?? 0;
      if (rangeStart === 0) {
        return {
          ok: true,
          json: async () => ({
            totalCount: 1002,
            data: Array.from({ length: 1000 }, (_, index) => ({
              s: `NASDAQ:BIG${index}`,
              d: [`Big ${index}`, "Technology", "Software", 1.5, 200_000_000_000 - index, 1.1, 50, 5_000_000, 250_000_000, 5_000_000, "NASDAQ", "stock", 60, 40],
            })),
          }),
        };
      }
      if (rangeStart === 1000) {
        return {
          ok: true,
          json: async () => ({
            totalCount: 1002,
            data: [
              {
                s: "NASDAQ:MID1",
                d: ["Mid 1", "Technology", "Software", 4.1, 35_000_000_000, 1.5, 25, 3_500_000, 87_500_000, 3_500_000, "NASDAQ", "stock", 25.2, 20],
              },
              {
                s: "NASDAQ:MID2",
                d: ["Mid 2", "Technology", "Software", 3.8, 34_000_000_000, 1.4, 24, 3_200_000, 76_800_000, 3_200_000, "NASDAQ", "stock", 24.1, 19],
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              s: "NASDAQ:SMALL1",
              d: ["Small 1", "Technology", "Software", 4.2, 2_000_000_000, 1.7, 20, 3_000_000, 60_000_000, 3_000_000, "NASDAQ", "stock", 20.1, 18],
            },
            {
              s: "NASDAQ:SMALL2",
              d: ["Small 2", "Technology", "Software", 3.6, 1_500_000_000, 1.6, 14, 2_500_000, 35_000_000, 2_500_000, "NASDAQ", "stock", 14.2, 12],
            },
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTradingViewScanRows({
      ...topGainersPreset,
      sortField: "market_cap_basic",
      sortDirection: "desc",
      rowLimit: 2,
      rules: [
        { id: "exchange", field: "exchange", operator: "in", value: ["NASDAQ"] },
        { id: "close-max", field: "close", operator: "lte", value: { type: "field", field: "EMA5", multiplier: 1.03 } },
        { id: "close-min", field: "close", operator: "gte", value: { type: "field", field: "EMA5", multiplier: 0.97 } },
        { id: "sma200", field: "SMA200", operator: "lt", value: { type: "field", field: "close", multiplier: 1 } },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.rows.map((row) => row.ticker)).toEqual(["MID1", "MID2"]);
    vi.unstubAllGlobals();
  });

  it("compiles unique tickers across the latest snapshots of multiple presets", async () => {
    const presetRows = [
      { id: "preset-a", name: "Leaders", isDefault: 1, isActive: 1, rulesJson: "[]", sortField: "change", sortDirection: "desc", rowLimit: 100, createdAt: "", updatedAt: "" },
      { id: "preset-b", name: "Breakouts", isDefault: 0, isActive: 1, rulesJson: "[]", sortField: "change", sortDirection: "desc", rowLimit: 100, createdAt: "", updatedAt: "" },
    ];
    const snapshotRows = {
      "preset-a": { id: "snap-a", presetId: "preset-a", providerLabel: "TV", generatedAt: "2026-03-18T01:00:00.000Z", rowCount: 2, status: "ok", error: null },
      "preset-b": { id: "snap-b", presetId: "preset-b", providerLabel: "TV", generatedAt: "2026-03-18T02:00:00.000Z", rowCount: 2, status: "ok", error: null },
    } as const;
    const scanRows = {
      "snap-a": [
        { ticker: "NVDA", name: "NVIDIA", sector: "Technology", industry: "Semiconductors", change1d: 4.5, marketCap: 1, price: 100, avgVolume: 10, priceAvgVolume: 1000, rawJson: JSON.stringify({ relative_volume_10d_calc: 2.1 }) },
        { ticker: "PLTR", name: "Palantir", sector: "Technology", industry: "Software", change1d: 2.2, marketCap: 1, price: 20, avgVolume: 10, priceAvgVolume: 200, rawJson: JSON.stringify({ relative_volume_10d_calc: 1.4 }) },
      ],
      "snap-b": [
        { ticker: "NVDA", name: "NVIDIA", sector: "Technology", industry: "Semiconductors", change1d: 5.1, marketCap: 1, price: 101, avgVolume: 10, priceAvgVolume: 1010, rawJson: JSON.stringify({ relative_volume_10d_calc: 2.3 }) },
        { ticker: "SNOW", name: "Snowflake", sector: "Technology", industry: "Software", change1d: 3.1, marketCap: 1, price: 30, avgVolume: 10, priceAvgVolume: 300, rawJson: JSON.stringify({ relative_volume_10d_calc: 1.8 }) },
      ],
    } as const;

    const env = {
      DB: {
        prepare(query: string) {
          return {
            bind(value: string) {
              return {
                async first() {
                  if (query.includes("FROM scan_presets WHERE id = ?")) {
                    return presetRows.find((row) => row.id === value) ?? null;
                  }
                  if (query.includes("FROM scan_snapshots")) {
                    return snapshotRows[value as keyof typeof snapshotRows] ?? null;
                  }
                  return null;
                },
                async all() {
                  if (query.includes("FROM scan_rows WHERE snapshot_id = ?")) {
                    return { results: scanRows[value as keyof typeof scanRows] ?? [] };
                  }
                  return { results: [] };
                },
              };
            },
          };
        },
      },
    } as any;

    const result = await loadCompiledScansSnapshot(env, ["preset-a", "preset-b"]);

    expect(result.presetNames).toEqual(["Leaders", "Breakouts"]);
    expect(result.generatedAt).toBe("2026-03-18T02:00:00.000Z");
    expect(result.rows.map((row) => [row.ticker, row.occurrences])).toEqual([
      ["NVDA", 2],
      ["SNOW", 1],
      ["PLTR", 1],
    ]);
    expect(result.rows[0]).toMatchObject({
      ticker: "NVDA",
      presetNames: ["Leaders", "Breakouts"],
      latestPrice: 101,
      latestRelativeVolume: 2.3,
    });
  });

  it("duplicates presets with copied settings, a fresh id, and incremented copy naming", async () => {
    const presetRows = [
      { id: "preset-a", name: "Momentum", isDefault: 1, isActive: 1, rulesJson: JSON.stringify(topGainersPreset.rules), sortField: "change", sortDirection: "desc", rowLimit: 100, createdAt: "", updatedAt: "" },
      { id: "preset-b", name: "Momentum Copy", isDefault: 0, isActive: 1, rulesJson: "[]", sortField: "change", sortDirection: "desc", rowLimit: 50, createdAt: "", updatedAt: "" },
      { id: "preset-c", name: "Momentum Copy 2", isDefault: 0, isActive: 1, rulesJson: "[]", sortField: "ticker", sortDirection: "asc", rowLimit: 25, createdAt: "", updatedAt: "" },
    ];
    let insertedRow: any = null;

    const env = {
      DB: {
        prepare(query: string) {
          return {
            bind(...args: any[]) {
              return {
                async first() {
                  if (query.includes("FROM scan_presets WHERE id = ?")) {
                    const id = args[0];
                    if (insertedRow?.id === id) return insertedRow;
                    return presetRows.find((row) => row.id === id) ?? null;
                  }
                  return null;
                },
                async all() {
                  if (query.includes("FROM scan_presets ORDER BY")) {
                    return { results: insertedRow ? [...presetRows, insertedRow] : presetRows };
                  }
                  return { results: [] };
                },
                async run() {
                  if (query.includes("UPDATE scan_presets SET is_default = 0")) return {};
                  if (query.includes("INSERT INTO scan_presets")) {
                    insertedRow = {
                      id: args[0],
                      name: args[1],
                      isDefault: args[2],
                      isActive: args[3],
                      rulesJson: args[4],
                      sortField: args[5],
                      sortDirection: args[6],
                      rowLimit: args[7],
                      createdAt: "",
                      updatedAt: "",
                    };
                  }
                  return {};
                },
              };
            },
            async all() {
              if (query.includes("FROM scan_presets ORDER BY")) {
                return { results: insertedRow ? [...presetRows, insertedRow] : presetRows };
              }
              return { results: [] };
            },
            async run() {
              if (query.includes("UPDATE scan_presets SET is_default = 0")) return {};
              return {};
            },
          };
        },
      },
    } as any;

    const result = await duplicateScanPreset(env, "preset-a");

    expect(result.id).not.toBe("preset-a");
    expect(result.name).toBe("Momentum Copy 3");
    expect(result.isDefault).toBe(false);
    expect(result.isActive).toBe(true);
    expect(result.sortField).toBe("change");
    expect(result.sortDirection).toBe("desc");
    expect(result.rowLimit).toBe(100);
    expect(result.rules).toEqual(topGainersPreset.rules);
  });

  it("loads compiled rows from a saved compile preset", async () => {
    const compilePresetRows = [
      { id: "compile-daily", name: "Daily", createdAt: "", updatedAt: "", scanPresetId: "preset-a", scanPresetName: "Leaders", sortOrder: 1 },
      { id: "compile-daily", name: "Daily", createdAt: "", updatedAt: "", scanPresetId: "preset-b", scanPresetName: "Breakouts", sortOrder: 2 },
    ];
    const presetRows = [
      { id: "preset-a", name: "Leaders", isDefault: 1, isActive: 1, rulesJson: "[]", sortField: "change", sortDirection: "desc", rowLimit: 100, createdAt: "", updatedAt: "" },
      { id: "preset-b", name: "Breakouts", isDefault: 0, isActive: 1, rulesJson: "[]", sortField: "change", sortDirection: "desc", rowLimit: 100, createdAt: "", updatedAt: "" },
    ];
    const snapshotRows = {
      "preset-a": { id: "snap-a", presetId: "preset-a", providerLabel: "TV", generatedAt: "2026-03-18T01:00:00.000Z", rowCount: 1, status: "ok", error: null },
      "preset-b": { id: "snap-b", presetId: "preset-b", providerLabel: "TV", generatedAt: "2026-03-18T02:00:00.000Z", rowCount: 1, status: "ok", error: null },
    } as const;
    const scanRows = {
      "snap-a": [
        { ticker: "NVDA", name: "NVIDIA", sector: "Technology", industry: "Semiconductors", change1d: 4.5, marketCap: 1, price: 100, avgVolume: 10, priceAvgVolume: 1000, rawJson: JSON.stringify({ relative_volume_10d_calc: 2.1 }) },
      ],
      "snap-b": [
        { ticker: "SNOW", name: "Snowflake", sector: "Technology", industry: "Software", change1d: 3.1, marketCap: 1, price: 30, avgVolume: 10, priceAvgVolume: 300, rawJson: JSON.stringify({ relative_volume_10d_calc: 1.8 }) },
      ],
    } as const;

    const env = {
      DB: {
        prepare(query: string) {
          return {
            bind(value: string) {
              return {
                async first() {
                  if (query.includes("FROM scan_presets WHERE id = ?")) {
                    return presetRows.find((row) => row.id === value) ?? null;
                  }
                  if (query.includes("FROM scan_snapshots")) {
                    return snapshotRows[value as keyof typeof snapshotRows] ?? null;
                  }
                  return null;
                },
                async all() {
                  if (query.includes("FROM scan_compile_presets cp")) {
                    return { results: compilePresetRows };
                  }
                  if (query.includes("FROM scan_rows WHERE snapshot_id = ?")) {
                    return { results: scanRows[value as keyof typeof scanRows] ?? [] };
                  }
                  return { results: [] };
                },
              };
            },
          };
        },
      },
    } as any;

    const result = await loadCompiledScansSnapshotForCompilePreset(env, "compile-daily");

    expect(result.compilePresetId).toBe("compile-daily");
    expect(result.compilePresetName).toBe("Daily");
    expect(result.presetNames).toEqual(["Leaders", "Breakouts"]);
    expect(result.rows.map((row) => row.ticker)).toEqual(["NVDA", "SNOW"]);
  });

  it("falls back to the latest usable member snapshot when the newest snapshot is an error", async () => {
    const { env } = createMutableScansEnv({
      presets: [
        { ...topGainersPreset, id: "preset-a", name: "Leaders" },
        { ...topGainersPreset, id: "preset-b", name: "Breakouts", sortField: "close" },
      ],
      snapshots: [
        { id: "snap-a-usable", presetId: "preset-a", providerLabel: "TV", generatedAt: "2026-03-18T01:00:00.000Z", rowCount: 1, status: "ok", error: null },
        { id: "snap-a-error", presetId: "preset-a", providerLabel: "TV", generatedAt: "2026-03-18T02:00:00.000Z", rowCount: 0, status: "error", error: "TV unavailable" },
        { id: "snap-b-usable", presetId: "preset-b", providerLabel: "TV", generatedAt: "2026-03-18T03:00:00.000Z", rowCount: 1, status: "ok", error: null },
      ],
      rowsBySnapshotId: {
        "snap-a-usable": [
          { ticker: "NVDA", name: "NVIDIA", sector: "Technology", industry: "Semiconductors", change1d: 4.2, marketCap: 1, relativeVolume: null, price: 100, avgVolume: 10, priceAvgVolume: 1000, rawJson: JSON.stringify({ relative_volume_10d_calc: 2.1 }) },
        ],
        "snap-b-usable": [
          { ticker: "SNOW", name: "Snowflake", sector: "Technology", industry: "Software", change1d: 3.1, marketCap: 1, relativeVolume: null, price: 30, avgVolume: 10, priceAvgVolume: 300, rawJson: JSON.stringify({ relative_volume_10d_calc: 1.8 }) },
        ],
      },
    });

    const result = await loadCompiledScansSnapshot(env, ["preset-a", "preset-b"]);

    expect(result.rows.map((row) => row.ticker)).toEqual(["NVDA", "SNOW"]);
    expect(result.generatedAt).toBe("2026-03-18T03:00:00.000Z");
  });

  it("refreshes every compile preset member, falls back on member failure, and reports outcomes", async () => {
    const presetA = { ...topGainersPreset, id: "preset-a", name: "Leaders", sortField: "change" } satisfies ScanPreset;
    const presetB = { ...topGainersPreset, id: "preset-b", name: "Breakouts", sortField: "close" } satisfies ScanPreset;
    const { env } = createMutableScansEnv({
      presets: [presetA, presetB],
      compilePresets: [{
        id: "compile-daily",
        name: "Daily",
        createdAt: "",
        updatedAt: "",
        members: [
          { scanPresetId: "preset-a", scanPresetName: "Leaders", sortOrder: 1 },
          { scanPresetId: "preset-b", scanPresetName: "Breakouts", sortOrder: 2 },
        ],
      }],
      snapshots: [
        { id: "snap-b-prev", presetId: "preset-b", providerLabel: "TV", generatedAt: "2026-03-18T01:00:00.000Z", rowCount: 1, status: "ok", error: null },
      ],
      rowsBySnapshotId: {
        "snap-b-prev": [
          { ticker: "OLDB", name: "Old Breakout", sector: "Technology", industry: "Software", change1d: 1.5, marketCap: 1, relativeVolume: null, price: 10, avgVolume: 10, priceAvgVolume: 100, rawJson: JSON.stringify({ relative_volume_10d_calc: 1.1 }) },
        ],
      },
    });

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { sort?: { sortBy?: string } };
      if (payload.sort?.sortBy === "change") {
        return {
          ok: true,
          json: async () => ({
            data: [
              {
                s: "NASDAQ:NVDA",
                d: ["NVIDIA", "Technology", "Semiconductors", 5.2, 1, 2.3, 120, 10, 1200, 10, "NASDAQ", "stock"],
              },
            ],
          }),
        };
      }
      return {
        ok: false,
        status: 503,
        text: async () => "upstream unavailable",
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshScanCompilePreset(env, "compile-daily");

    expect(result.compilePresetName).toBe("Daily");
    expect(result.refreshedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.memberResults.map((row) => [row.presetName, row.status, row.usedFallback, row.includedInCompiled])).toEqual([
      ["Leaders", "ok", false, true],
      ["Breakouts", "error", true, true],
    ]);
    expect(result.memberResults[1]?.usableSnapshot?.rows.map((row) => row.ticker)).toEqual(["OLDB"]);
    expect(result.snapshot.rows.map((row) => row.ticker)).toEqual(["NVDA", "OLDB"]);

    vi.unstubAllGlobals();
  });

  it("reports failed members with no prior usable snapshot as omitted from the compiled result", async () => {
    const presetA = { ...topGainersPreset, id: "preset-a", name: "Leaders", sortField: "change" } satisfies ScanPreset;
    const presetB = { ...topGainersPreset, id: "preset-b", name: "Breakouts", sortField: "close" } satisfies ScanPreset;
    const { env } = createMutableScansEnv({
      presets: [presetA, presetB],
      compilePresets: [{
        id: "compile-daily",
        name: "Daily",
        createdAt: "",
        updatedAt: "",
        members: [
          { scanPresetId: "preset-a", scanPresetName: "Leaders", sortOrder: 1 },
          { scanPresetId: "preset-b", scanPresetName: "Breakouts", sortOrder: 2 },
        ],
      }],
    });

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { sort?: { sortBy?: string } };
      if (payload.sort?.sortBy === "change") {
        return {
          ok: true,
          json: async () => ({
            data: [
              {
                s: "NASDAQ:NVDA",
                d: ["NVIDIA", "Technology", "Semiconductors", 5.2, 1, 2.3, 120, 10, 1200, 10, "NASDAQ", "stock"],
              },
            ],
          }),
        };
      }
      return {
        ok: false,
        status: 503,
        text: async () => "upstream unavailable",
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshScanCompilePreset(env, "compile-daily");

    expect(result.failedCount).toBe(1);
    expect(result.memberResults[1]).toMatchObject({
      presetName: "Breakouts",
      status: "error",
      usedFallback: false,
      includedInCompiled: false,
      usableSnapshot: null,
    });
    expect(result.snapshot.rows.map((row) => row.ticker)).toEqual(["NVDA"]);

    vi.unstubAllGlobals();
  });

  it("blocks deleting a scan preset that is used by a compile preset", async () => {
    const env = {
      DB: {
        prepare(query: string) {
          return {
            bind(value: string) {
              return {
                async first() {
                  if (query.includes("FROM scan_presets WHERE id = ?")) {
                    return { id: value, name: "Leaders", isDefault: 0, isActive: 1, rulesJson: "[]", sortField: "change", sortDirection: "desc", rowLimit: 100, createdAt: "", updatedAt: "" };
                  }
                  return null;
                },
                async all() {
                  if (query.includes("FROM scan_compile_presets cp")) {
                    return { results: [{ name: "Daily" }] };
                  }
                  return { results: [] };
                },
              };
            },
            async batch() {
              throw new Error("batch should not be called");
            },
          };
        },
      },
    } as any;

    await expect(deleteScanPreset(env, "preset-a")).rejects.toThrow(
      "Cannot delete scan preset because it is used by compile presets: Daily",
    );
  });
});
