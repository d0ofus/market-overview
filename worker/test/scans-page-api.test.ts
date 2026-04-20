import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

type MutableSnapshot = {
  id: string;
  presetId: string;
  providerLabel: string;
  generatedAt: string;
  rowCount: number;
  matchedRowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
};

type MutablePreset = {
  id: string;
  name: string;
  scanType?: "tradingview" | "relative-strength";
  isDefault: boolean;
  isActive: boolean;
  rules: Array<{ id: string; field: string; operator: string; value: unknown }>;
  prefilterRules?: Array<{ id: string; field: string; operator: string; value: unknown }>;
  benchmarkTicker?: string | null;
  verticalOffset?: number;
  rsMaLength?: number;
  rsMaType?: "SMA" | "EMA";
  newHighLookback?: number;
  outputMode?: "all" | "rs_new_high_only" | "rs_new_high_before_price_only" | "both";
  sortField: string;
  sortDirection: "asc" | "desc";
  rowLimit: number;
  createdAt: string;
  updatedAt: string;
};

type MutableCompilePreset = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  members: Array<{ scanPresetId: string; scanPresetName: string; sortOrder: number }>;
};

function createApiScansEnv(input?: {
  presets?: MutablePreset[];
  compilePresets?: MutableCompilePreset[];
  snapshots?: MutableSnapshot[];
  rowsBySnapshotId?: Record<string, Array<Record<string, unknown>>>;
  adminSecret?: string;
}): Env {
  const presets = [...(input?.presets ?? [])];
  const compilePresets = [...(input?.compilePresets ?? [])];
  const snapshots = [...(input?.snapshots ?? [])];
  const rowsBySnapshotId = new Map<string, Array<Record<string, unknown>>>(
    Object.entries(input?.rowsBySnapshotId ?? {}).map(([snapshotId, rows]) => [snapshotId, [...rows]]),
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

  return {
    ADMIN_SECRET: input?.adminSecret,
    DB: {
      prepare(sql: string) {
        const makeBound = (args: unknown[]) => ({
          __sql: sql,
          __args: args,
          async first<T>() {
            if (sql.includes("FROM scan_presets WHERE id = ?")) {
              return (presets.find((row) => row.id === args[0]) ?? null) as T;
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
              return { results: ((rowsBySnapshotId.get(String(args[0] ?? "")) ?? []) as T[]) };
            }
            return { results: [] as T[] };
          },
          async run() {
            if (sql.includes("INSERT INTO scan_snapshots")) {
              const [id, presetId, providerLabel, rowCountArg, matchedRowCountArg, statusArg, errorArg] = args;
              const isErrorInsert = args.length === 4;
              snapshots.push({
                id: String(id),
                presetId: String(presetId),
                providerLabel: String(providerLabel),
                generatedAt: nextGeneratedAt(),
                rowCount: isErrorInsert ? 0 : Number(rowCountArg ?? 0),
                matchedRowCount: isErrorInsert ? 0 : Number(matchedRowCountArg ?? rowCountArg ?? 0),
                status: (isErrorInsert ? "error" : String(statusArg ?? "ok")) as MutableSnapshot["status"],
                error: isErrorInsert ? String(rowCountArg ?? "") : (errorArg == null ? null : String(errorArg)),
              });
            }
            return {};
          },
        });

        return {
          bind(...args: unknown[]) {
            return makeBound(args);
          },
          async all<T>() {
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
            const [id, presetId, providerLabel, rowCount, matchedRowCount, status, error] = statement.__args ?? [];
            snapshots.push({
              id: String(id),
              presetId: String(presetId),
              providerLabel: String(providerLabel),
              generatedAt: nextGeneratedAt(),
              rowCount: Number(rowCount ?? 0),
              matchedRowCount: Number(matchedRowCount ?? rowCount ?? 0),
              status: String(status ?? "ok") as MutableSnapshot["status"],
              error: error == null ? null : String(error),
            });
            continue;
          }
          if (statement.__sql.includes("INSERT INTO scan_rows")) {
            const [, snapshotId, ticker, name, sector, industry, change1d, marketCap, price, avgVolume, priceAvgVolume, rawJson] = statement.__args ?? [];
            const rows = rowsBySnapshotId.get(String(snapshotId)) ?? [];
            rows.push({
              ticker,
              name,
              sector,
              industry,
              change1d,
              marketCap,
              price,
              avgVolume,
              priceAvgVolume,
              rawJson,
            });
            rowsBySnapshotId.set(String(snapshotId), rows);
          }
        }
        return [];
      },
    } as D1Database,
  } as Env;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("scans page API", () => {
  it("exports single scan files with the scan filename format", async () => {
    const env = createApiScansEnv({
      presets: [{
        id: "preset-a",
        name: "Daily",
        scanType: "tradingview",
        isDefault: true,
        isActive: true,
        rules: [],
        prefilterRules: [],
        benchmarkTicker: null,
        verticalOffset: 30,
        rsMaLength: 21,
        rsMaType: "EMA",
        newHighLookback: 252,
        outputMode: "all",
        sortField: "change",
        sortDirection: "desc",
        rowLimit: 100,
        createdAt: "",
        updatedAt: "",
      }],
      snapshots: [{
        id: "snap-a",
        presetId: "preset-a",
        providerLabel: "TV",
        generatedAt: "2026-03-18T01:00:00.000Z",
        rowCount: 2,
        matchedRowCount: 2,
        status: "ok",
        error: null,
      }],
      rowsBySnapshotId: {
        "snap-a": [
          {
            ticker: "NVDA",
            name: "NVIDIA",
            sector: "Technology",
            industry: "Semiconductors",
            change1d: 5.3,
            marketCap: 1,
            price: 120,
            avgVolume: 10,
            priceAvgVolume: 1200,
            rawJson: JSON.stringify({ relative_volume_10d_calc: 2.1 }),
          },
          {
            ticker: "META",
            name: "Meta Platforms",
            sector: "Communication Services",
            industry: "Internet Content & Information",
            change1d: 3.1,
            marketCap: 1,
            price: 500,
            avgVolume: 10,
            priceAvgVolume: 5000,
            rawJson: JSON.stringify({ relative_volume_10d_calc: 1.4 }),
          },
        ],
      },
    });

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/scans/export.txt?presetId=preset-a&dateSuffix=2026-03-18"),
      env as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Scan-Daily_03_18.txt"',
    );
    await expect(response.text()).resolves.toBe("NVDA\nMETA");
  });

  it("exports compiled preset files with the compiled-scan filename format", async () => {
    const env = createApiScansEnv({
      presets: [{
        id: "preset-a",
        name: "Leaders",
        scanType: "tradingview",
        isDefault: true,
        isActive: true,
        rules: [],
        prefilterRules: [],
        benchmarkTicker: null,
        verticalOffset: 30,
        rsMaLength: 21,
        rsMaType: "EMA",
        newHighLookback: 252,
        outputMode: "all",
        sortField: "change",
        sortDirection: "desc",
        rowLimit: 100,
        createdAt: "",
        updatedAt: "",
      }],
      compilePresets: [{
        id: "compile-daily",
        name: "Daily",
        createdAt: "",
        updatedAt: "",
        members: [
          { scanPresetId: "preset-a", scanPresetName: "Leaders", sortOrder: 1 },
        ],
      }],
      snapshots: [{
        id: "snap-a",
        presetId: "preset-a",
        providerLabel: "TV",
        generatedAt: "2026-03-18T01:00:00.000Z",
        rowCount: 2,
        matchedRowCount: 2,
        status: "ok",
        error: null,
      }],
      rowsBySnapshotId: {
        "snap-a": [
          {
            ticker: "NVDA",
            name: "NVIDIA",
            sector: "Technology",
            industry: "Semiconductors",
            change1d: 5.3,
            marketCap: 1,
            price: 120,
            avgVolume: 10,
            priceAvgVolume: 1200,
            rawJson: JSON.stringify({ relative_volume_10d_calc: 2.1 }),
          },
          {
            ticker: "META",
            name: "Meta Platforms",
            sector: "Communication Services",
            industry: "Internet Content & Information",
            change1d: 3.1,
            marketCap: 1,
            price: 500,
            avgVolume: 10,
            priceAvgVolume: 5000,
            rawJson: JSON.stringify({ relative_volume_10d_calc: 1.4 }),
          },
        ],
      },
    });

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/scans/compile-presets/compile-daily/export.txt?dateSuffix=2026-03-18"),
      env as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Compiled-Scan-Daily_03_18.txt"',
    );
    await expect(response.text()).resolves.toBe("NVDA\nMETA");
  });

  it("rejects compiled preset refresh when unauthorized", async () => {
    const env = createApiScansEnv({ adminSecret: "secret" });

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/admin/scans/compile-presets/compile-daily/refresh", { method: "POST" }),
      env as never,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "Unauthorized" });
  });

  it("returns 404 when the compiled preset does not exist", async () => {
    const env = createApiScansEnv({ adminSecret: "secret" });

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/admin/scans/compile-presets/missing/refresh", {
        method: "POST",
        headers: { authorization: "Bearer secret" },
      }),
      env as never,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "Scan compile preset not found." });
  });

  it("refreshes a compiled preset and returns member-level outcomes", async () => {
    const env = createApiScansEnv({
      adminSecret: "secret",
      presets: [
        {
          id: "preset-a",
          name: "Leaders",
          scanType: "tradingview",
          isDefault: true,
          isActive: true,
          rules: [{ id: "change", field: "change", operator: "gt", value: 3 }],
          prefilterRules: [],
          benchmarkTicker: null,
          verticalOffset: 30,
          rsMaLength: 21,
          rsMaType: "EMA",
          newHighLookback: 252,
          outputMode: "all",
          sortField: "change",
          sortDirection: "desc",
          rowLimit: 100,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "preset-b",
          name: "Breakouts",
          scanType: "tradingview",
          isDefault: false,
          isActive: true,
          rules: [{ id: "close", field: "close", operator: "gt", value: 10 }],
          prefilterRules: [],
          benchmarkTicker: null,
          verticalOffset: 30,
          rsMaLength: 21,
          rsMaType: "EMA",
          newHighLookback: 252,
          outputMode: "all",
          sortField: "close",
          sortDirection: "desc",
          rowLimit: 100,
          createdAt: "",
          updatedAt: "",
        },
      ],
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
        {
          id: "snap-b-prev",
          presetId: "preset-b",
          providerLabel: "TV",
          generatedAt: "2026-03-18T01:00:00.000Z",
          rowCount: 1,
          matchedRowCount: 1,
          status: "ok",
          error: null,
        },
      ],
      rowsBySnapshotId: {
        "snap-b-prev": [
          {
            ticker: "OLDB",
            name: "Old Breakout",
            sector: "Technology",
            industry: "Software",
            change1d: 1.2,
            marketCap: 1,
            price: 10,
            avgVolume: 10,
            priceAvgVolume: 100,
            rawJson: JSON.stringify({ relative_volume_10d_calc: 1.1 }),
          },
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
                d: ["NVIDIA", "Technology", "Semiconductors", 5.3, 1, 2.1, 120, 10, 1200, 10, "NASDAQ", "stock"],
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

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/admin/scans/compile-presets/compile-daily/refresh", {
        method: "POST",
        headers: { authorization: "Bearer secret" },
      }),
      env as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      refreshedCount: number;
      failedCount: number;
      memberResults: Array<{ presetName: string; status: string; usedFallback: boolean }>;
      snapshot: { rows: Array<{ ticker: string }> };
    };

    expect(body.ok).toBe(true);
    expect(body.refreshedCount).toBe(1);
    expect(body.failedCount).toBe(1);
    expect(body.memberResults.map((row) => [row.presetName, row.status, row.usedFallback])).toEqual([
      ["Leaders", "ok", false],
      ["Breakouts", "error", true],
    ]);
    expect(body.snapshot.rows.map((row) => row.ticker)).toEqual(["NVDA", "OLDB"]);
  });
});
