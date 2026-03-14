"use client";

import { useEffect, useMemo, useState } from "react";
import { adminFetch } from "@/lib/api";
import type { SnapshotResponse } from "@/types/dashboard";

const rankingOptions = ["1D", "5D", "1W", "YTD", "52W"] as const;
const allColumns = ["ticker", "name", "price", "1D", "1W", "3M", "6M", "5D", "YTD", "pctFrom52WHigh", "sparkline"];
const refreshTimezoneOptions = [
  { label: "Melbourne", value: "Australia/Melbourne" },
  { label: "Sydney", value: "Australia/Sydney" },
  { label: "Singapore", value: "Asia/Singapore" },
  { label: "New York", value: "America/New_York" },
] as const;
const DEFAULT_REFRESH_TIME = "08:15";
const DEFAULT_REFRESH_TIMEZONE = "Australia/Melbourne";
function adminSectionAnchor(title: string): string | undefined {
  if (title.includes("Macro Overview")) return "admin-macro-overview";
  if (title.includes("Equities Overview")) return "admin-equities-overview";
  if (title.includes("Market Breadth & Sentiment")) return "admin-market-breadth-sentiment";
  return undefined;
}

function isOverviewAdminSection(title: string): boolean {
  return title.includes("Macro Overview") || title.includes("Equities Overview") || title.includes("Market Breadth & Sentiment");
}

const buildRefreshLabel = (localTime: string, timezone: string) => `${localTime} ${timezone} (prev US close)`;

function formatDateTimeCompact(value: string | null | undefined): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

export function AdminBuilder() {
  const [data, setData] = useState<SnapshotResponse["config"] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tickerInput, setTickerInput] = useState<Record<string, string>>({});
  const [newSectionTitle, setNewSectionTitle] = useState("");
  const [newGroupTitle, setNewGroupTitle] = useState<Record<string, string>>({});
  const [tickerErrors, setTickerErrors] = useState<Record<string, string | null>>({});
  const [sectorEtfs, setSectorEtfs] = useState<any[]>([]);
  const [industryEtfs, setIndustryEtfs] = useState<any[]>([]);
  const [etfSyncStatus, setEtfSyncStatus] = useState<any[]>([]);
  const [etfError, setEtfError] = useState<string | null>(null);
  const [sectorEtfForm, setSectorEtfForm] = useState({ ticker: "", fundName: "", parentSectorSelect: "", parentSectorNew: "" });
  const [industryEtfForm, setIndustryEtfForm] = useState({
    ticker: "",
    fundName: "",
    parentSectorSelect: "",
    parentSectorNew: "",
    industrySelect: "",
    industryNew: "",
  });
  const [dragTicker, setDragTicker] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState({
    parentSectorSelect: "",
    parentSectorNew: "",
    industrySelect: "",
    industryNew: "",
  });
  const [refreshConfig, setRefreshConfig] = useState({
    id: "default",
    name: "Default Swing Dashboard",
    timezone: DEFAULT_REFRESH_TIMEZONE,
    eodRunLocalTime: DEFAULT_REFRESH_TIME,
    eodRunTimeLabel: buildRefreshLabel(DEFAULT_REFRESH_TIME, DEFAULT_REFRESH_TIMEZONE),
  });
  const [refreshConfigMsg, setRefreshConfigMsg] = useState<string | null>(null);
  const [etfBackfillMsg, setEtfBackfillMsg] = useState<string | null>(null);
  const [schedulePageTarget, setSchedulePageTarget] = useState<"overview" | "breadth" | "sectors" | "thirteenf" | "admin" | "scanning" | "watchlist-compiler" | "gappers">("overview");
  const [diagTicker, setDiagTicker] = useState("TAN");
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [diagMsg, setDiagMsg] = useState<string | null>(null);
  const [diagResult, setDiagResult] = useState<any | null>(null);
  const [diagSourceUrl, setDiagSourceUrl] = useState("");
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [itemDisplayNames, setItemDisplayNames] = useState<Record<string, string>>({});
  const [itemDisplayNameStatus, setItemDisplayNameStatus] = useState<Record<string, string | null>>({});

  const load = async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const config = await adminFetch<SnapshotResponse["config"]>("/api/admin/config");
      setData(config);
      setRefreshConfig({
        id: config.id,
        name: config.name,
        timezone: config.timezone,
        eodRunLocalTime: config.eodRunLocalTime || DEFAULT_REFRESH_TIME,
        eodRunTimeLabel: buildRefreshLabel(config.eodRunLocalTime || DEFAULT_REFRESH_TIME, config.timezone || DEFAULT_REFRESH_TIMEZONE),
      });

      const [sectorRes, industryRes, syncRes] = await Promise.allSettled([
        adminFetch<{ rows: any[] }>("/api/etfs/sector"),
        adminFetch<{ rows: any[] }>("/api/etfs/industry"),
        adminFetch<{ rows: any[] }>("/api/admin/etf-sync-status?limit=200"),
      ]);
      setSectorEtfs(sectorRes.status === "fulfilled" ? (sectorRes.value.rows ?? []) : []);
      setIndustryEtfs(industryRes.status === "fulfilled" ? (industryRes.value.rows ?? []) : []);
      setEtfSyncStatus(syncRes.status === "fulfilled" ? (syncRes.value.rows ?? []) : []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load admin config.");
    } finally {
      setIsLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!data) return;
    const next: Record<string, string> = {};
    for (const section of data.sections) {
      for (const group of section.groups) {
        for (const item of group.items) {
          next[item.id] = item.displayName ?? "";
        }
      }
    }
    setItemDisplayNames(next);
  }, [data]);

  const patchGroup = async (groupId: string, patch: any) => {
    await adminFetch("/api/admin/group/" + groupId, { method: "PATCH", body: JSON.stringify(patch) });
    await load();
  };

  const addTicker = async (groupId: string) => {
    const list = (tickerInput[groupId] ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    setTickerErrors((s) => ({ ...s, [groupId]: null }));
    const failures: string[] = [];
    for (const t of list) {
      try {
        await adminFetch("/api/admin/group/" + groupId + "/items", {
          method: "POST",
          body: JSON.stringify({ ticker: t, tags: [] }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        failures.push(`${t} (${msg})`);
      }
    }
    setTickerInput((s) => ({ ...s, [groupId]: "" }));
    await load();
    if (failures.length > 0) {
      setTickerErrors((s) => ({
        ...s,
        [groupId]: `Could not add: ${failures.join(" | ")}`,
      }));
    }
  };

  const removeItem = async (itemId: string) => {
    await adminFetch("/api/admin/item/" + itemId, { method: "DELETE" });
    await load();
  };
  const updateItemDisplayName = async (itemId: string) => {
    try {
      setItemDisplayNameStatus((current) => ({ ...current, [itemId]: null }));
      await adminFetch("/api/admin/item/" + itemId, {
        method: "PATCH",
        body: JSON.stringify({ displayName: (itemDisplayNames[itemId] ?? "").trim() || null }),
      });
      setItemDisplayNameStatus((current) => ({ ...current, [itemId]: "Saved." }));
      await load();
    } catch (error) {
      setItemDisplayNameStatus((current) => ({
        ...current,
        [itemId]: error instanceof Error ? error.message : "Failed to save name.",
      }));
    } finally {
      setTimeout(() => {
        setItemDisplayNameStatus((current) => ({ ...current, [itemId]: null }));
      }, 3000);
    }
  };
  const addSection = async () => {
    if (!newSectionTitle.trim()) return;
    await adminFetch("/api/admin/section", { method: "POST", body: JSON.stringify({ title: newSectionTitle.trim() }) });
    setNewSectionTitle("");
    await load();
  };
  const addGroup = async (sectionId: string) => {
    const title = (newGroupTitle[sectionId] ?? "").trim();
    if (!title) return;
    await adminFetch("/api/admin/section/" + sectionId + "/group", { method: "POST", body: JSON.stringify({ title }) });
    setNewGroupTitle((s) => ({ ...s, [sectionId]: "" }));
    await load();
  };

  const saveRefreshConfig = async () => {
    try {
      const nextLabel = buildRefreshLabel(refreshConfig.eodRunLocalTime, refreshConfig.timezone);
      setRefreshConfigMsg(null);
      await adminFetch("/api/admin/config", {
        method: "PATCH",
        body: JSON.stringify({
          id: refreshConfig.id,
          name: refreshConfig.name.trim() || "Default Swing Dashboard",
          timezone: refreshConfig.timezone,
          eodRunLocalTime: refreshConfig.eodRunLocalTime,
          eodRunTimeLabel: nextLabel,
        }),
      });
      setRefreshConfig((s) => ({ ...s, eodRunTimeLabel: nextLabel }));
      setRefreshConfigMsg("Saved refresh schedule.");
      await load();
    } catch (err) {
      setRefreshConfigMsg(err instanceof Error ? err.message : "Failed to save refresh schedule.");
    } finally {
      setTimeout(() => setRefreshConfigMsg(null), 3000);
    }
  };

  const runSchedulePageRefresh = async () => {
    try {
      setRefreshConfigMsg(null);
      const res = await adminFetch<{ ok: boolean; refreshedTickers: number; notes?: string }>("/api/admin/refresh-page", {
        method: "POST",
        body: JSON.stringify({ page: schedulePageTarget }),
      });
      setRefreshConfigMsg(res.notes ?? `Ran ${schedulePageTarget} update: ${res.refreshedTickers} tickers refreshed.`);
      await load();
    } catch (err) {
      setRefreshConfigMsg(err instanceof Error ? err.message : "Failed to run selected page refresh.");
    } finally {
      setTimeout(() => setRefreshConfigMsg(null), 4000);
    }
  };

  const runEtfConstituentBackfill = async () => {
    try {
      setEtfBackfillMsg(null);
      const res = await adminFetch<{ ok: boolean; attempted: number; synced: number; failed: Array<{ ticker: string; error: string }> }>("/api/admin/etf-sync-backfill", {
        method: "POST",
        body: JSON.stringify({ limit: 3 }),
      });
      if (res.failed.length > 0) {
        setEtfBackfillMsg(`Synced ${res.synced}/${res.attempted}. Failed: ${res.failed.map((f) => f.ticker).join(", ")}`);
      } else {
        setEtfBackfillMsg(`Synced ${res.synced}/${res.attempted} ETFs.`);
      }
      await load();
    } catch (err) {
      setEtfBackfillMsg(err instanceof Error ? err.message : "Failed to run ETF constituent backfill.");
    } finally {
      setTimeout(() => setEtfBackfillMsg(null), 5000);
    }
  };

  const runEtfDiagnostics = async (syncFirst = false) => {
    const ticker = diagTicker.trim().toUpperCase();
    if (!/^[A-Z.\-^]{1,20}$/.test(ticker)) {
      setDiagError("Enter a valid ticker symbol.");
      return;
    }
    try {
      setDiagLoading(true);
      setDiagError(null);
      setDiagMsg(null);
      if (syncFirst) {
        const syncRes = await adminFetch<{ ok: boolean; ticker: string; count: number; source: string }>(`/api/admin/etf/${ticker}/sync`, {
          method: "POST",
        });
        setDiagMsg(`Synced ${syncRes.ticker}: ${syncRes.count} constituents from ${syncRes.source}.`);
      }
      const res = await adminFetch<{
        backendRevision: string;
        serverTimeUtc: string;
        dataProvider: string;
        ticker: string;
        db: { ok: boolean; error: string | null };
        watchlists: Array<{ listType: string; parentSector: string | null; industry: string | null; fundName: string | null; sourceUrl?: string | null }>;
        sourceUrl?: string | null;
        syncStatus: { status: string | null; source: string | null; lastSyncedAt: string | null; updatedAt: string | null; recordsCount: number; error: string | null } | null;
        constituentSummary: { count: number; latestAsOfDate: string | null; latestUpdatedAt: string | null };
        topConstituents: Array<{ ticker: string; name: string | null; weight: number | null }>;
      }>(`/api/admin/etf-sync-diagnostics?ticker=${encodeURIComponent(ticker)}`);
      setDiagResult(res);
      setDiagSourceUrl(String(res.sourceUrl ?? res.watchlists?.[0]?.sourceUrl ?? ""));
    } catch (err) {
      setDiagError(err instanceof Error ? err.message : "Failed to run ETF diagnostics.");
    } finally {
      setDiagLoading(false);
    }
  };

  const move = async (type: "group" | "item", ids: string[], index: number, dir: -1 | 1) => {
    const to = index + dir;
    if (to < 0 || to >= ids.length) return;
    const next = [...ids];
    const [el] = next.splice(index, 1);
    next.splice(to, 0, el);
    await adminFetch("/api/admin/reorder", { method: "POST", body: JSON.stringify({ type, orderedIds: next }) });
    await load();
  };

  const parentSectorOptions = useMemo(() => {
    const options = new Set<string>();
    for (const row of [...sectorEtfs, ...industryEtfs]) {
      if (row.parentSector) options.add(String(row.parentSector));
    }
    return Array.from(options).sort((a, b) => a.localeCompare(b));
  }, [sectorEtfs, industryEtfs]);

  const industryOptions = useMemo(() => {
    const options = new Set<string>();
    for (const row of industryEtfs) {
      if (row.industry) options.add(String(row.industry));
    }
    return Array.from(options).sort((a, b) => a.localeCompare(b));
  }, [industryEtfs]);

  const resolveFundName = async (tickerInput: string, form: "sector" | "industry") => {
    const ticker = tickerInput.trim().toUpperCase();
    if (!ticker) return;
    try {
      const meta = await adminFetch<{ name: string | null }>(`/api/admin/ticker-meta/${ticker}`);
      if (!meta?.name) return;
      if (form === "sector") {
        setSectorEtfForm((s) => ({ ...s, ticker, fundName: s.fundName.trim() ? s.fundName : meta.name ?? "" }));
      } else {
        setIndustryEtfForm((s) => ({ ...s, ticker, fundName: s.fundName.trim() ? s.fundName : meta.name ?? "" }));
      }
    } catch {
      // leave manual entry path available
    }
  };

  const deleteEtf = async (listType: "sector" | "industry", ticker: string) => {
    await adminFetch(`/api/admin/etfs/${listType}/${ticker}`, { method: "DELETE" });
    await load();
  };

  const industryCategoryGroups = useMemo(() => {
    const map = new Map<string, { parentSector: string; industry: string; rows: Array<{ ticker: string; fundName?: string | null; parentSector?: string | null; industry?: string | null }> }>();
    for (const row of industryEtfs) {
      const parent = row.parentSector ?? "Other";
      const industry = row.industry ?? "General";
      const key = `${parent}::${industry}`;
      const cur = map.get(key) ?? { parentSector: parent, industry, rows: [] as Array<{ ticker: string; fundName?: string | null; parentSector?: string | null; industry?: string | null }> };
      cur.rows.push(row);
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => {
      const p = a.parentSector.localeCompare(b.parentSector);
      if (p !== 0) return p;
      return a.industry.localeCompare(b.industry);
    });
  }, [industryEtfs]);

  const moveIndustryTicker = async (ticker: string, parentSector: string, industry: string) => {
    const row = industryEtfs.find((r) => String(r.ticker).toUpperCase() === ticker.toUpperCase());
    if (!row) return;
    await adminFetch("/api/admin/etfs", {
      method: "POST",
      body: JSON.stringify({
        listType: "industry",
        ticker: row.ticker,
        fundName: row.fundName ?? null,
        parentSector: parentSector || null,
        industry: industry || null,
        sourceUrl: row.sourceUrl ?? null,
      }),
    });
    await load();
  };

  const toggleSection = (sectionId: string) => {
    setCollapsedSections((current) => ({ ...current, [sectionId]: !current[sectionId] }));
  };

  if (isLoading) return <div className="card p-4">Loading admin config...</div>;
  if (loadError) {
    return (
      <div className="card p-4">
        <p className="text-sm text-rose-300">{loadError}</p>
        <button className="mt-3 rounded border border-borderSoft px-3 py-1 text-sm text-slate-200" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }
  if (!data) return <div className="card p-4">Admin config unavailable.</div>;

  const overviewSections = data.sections.filter((section) => isOverviewAdminSection(section.title));
  const otherSections = data.sections.filter((section) => !isOverviewAdminSection(section.title));

  return (
    <div className="space-y-4">
      <div className="card p-3">
        <h3 className="mb-2 text-base font-semibold">Daily Price Refresh Schedule</h3>
        <p className="mb-3 text-xs text-slate-400">
          Overview and Breadth refresh from the worker schedule at this configured local time each trading day.
        </p>
        <div className="grid gap-2 md:grid-cols-5">
          <input
            className="rounded border border-borderSoft bg-panelSoft px-2 py-1 md:col-span-2"
            value={refreshConfig.name}
            onChange={(e) => setRefreshConfig((s) => ({ ...s, name: e.target.value }))}
            placeholder="Dashboard config name"
          />
          <select
            className="rounded border border-borderSoft bg-panelSoft px-2 py-1"
            value={refreshConfig.timezone}
            onChange={(e) => setRefreshConfig((s) => ({ ...s, timezone: e.target.value }))}
          >
            {refreshTimezoneOptions.map((tz) => (
              <option key={tz.value} value={tz.value}>
                {tz.label}
              </option>
            ))}
          </select>
          <input
            type="time"
            className="rounded border border-borderSoft bg-panelSoft px-2 py-1"
            value={refreshConfig.eodRunLocalTime}
            onChange={(e) => setRefreshConfig((s) => ({ ...s, eodRunLocalTime: e.target.value }))}
          />
          <button className="rounded bg-accent/20 px-3 py-1 text-sm" onClick={saveRefreshConfig}>
            Save Schedule
          </button>
        </div>
        <div className="mt-2 grid gap-2 md:grid-cols-5">
          <div className="text-xs text-slate-400 md:col-span-2">Page Scope</div>
          <select
            className="rounded border border-borderSoft bg-panelSoft px-2 py-1 text-sm"
            value={schedulePageTarget}
            onChange={(e) => setSchedulePageTarget(e.target.value as "overview" | "breadth" | "sectors" | "thirteenf" | "admin" | "scanning" | "watchlist-compiler" | "gappers")}
          >
            <option value="overview">Overview</option>
            <option value="breadth">Breadth</option>
            <option value="sectors">Sector Tracker</option>
            <option value="thirteenf">13F Tracker</option>
            <option value="scanning">Scanning</option>
            <option value="watchlist-compiler">Watchlist Compiler</option>
            <option value="gappers">Gappers</option>
            <option value="admin">Admin</option>
          </select>
          <button className="rounded border border-borderSoft px-3 py-1 text-sm text-slate-200 md:col-span-2" onClick={runSchedulePageRefresh}>
            Run Selected Page Update Now
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-300">
          Current auto-refresh label: <span className="font-semibold">{refreshConfig.eodRunTimeLabel}</span>
        </p>
        {refreshConfigMsg && <p className="mt-2 text-xs text-slate-300">{refreshConfigMsg}</p>}
      </div>

      <div className="card p-3" id="admin-etf-watchlists">
        <h3 className="mb-2 text-base font-semibold">ETF Watchlists</h3>
        <div className="mb-3 flex items-center gap-2">
          <button className="rounded border border-borderSoft px-3 py-1 text-sm text-slate-200" onClick={runEtfConstituentBackfill}>
            Sync Missing ETF Constituents Now
          </button>
          {etfBackfillMsg && <span className="text-xs text-slate-300">{etfBackfillMsg}</span>}
        </div>
        <div className="mb-3 rounded border border-borderSoft p-2">
          <p className="mb-2 text-sm font-semibold">ETF Sync Diagnostics</p>
          <p className="mb-2 text-xs text-slate-400">
            Use this to verify the live worker and D1 state for one ticker (source, last synced, cached rows) and optionally run a manual sync first.
          </p>
          <div className="grid gap-2 md:grid-cols-4">
            <input
              className="rounded border border-borderSoft bg-panelSoft px-2 py-1"
              placeholder="Ticker (e.g. TAN)"
              value={diagTicker}
              onChange={(e) => setDiagTicker(e.target.value.toUpperCase())}
            />
            <button className="rounded border border-borderSoft px-3 py-1 text-sm text-slate-200" onClick={() => void runEtfDiagnostics(false)} disabled={diagLoading}>
              {diagLoading ? "Checking..." : "Check Backend + DB"}
            </button>
            <button className="rounded border border-accent/40 px-3 py-1 text-sm text-accent" onClick={() => void runEtfDiagnostics(true)} disabled={diagLoading}>
              {diagLoading ? "Syncing..." : "Sync Ticker + Verify"}
            </button>
          </div>
          {diagMsg && <p className="mt-2 text-xs text-slate-300">{diagMsg}</p>}
          {diagError && <p className="mt-2 text-xs text-red-300">{diagError}</p>}
          <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr),auto,auto]">
            <input
              className="rounded border border-borderSoft bg-panelSoft px-2 py-1 text-sm"
              placeholder="Official source URL override"
              value={diagSourceUrl}
              onChange={(e) => setDiagSourceUrl(e.target.value)}
            />
            <button
              className="rounded border border-borderSoft px-3 py-1 text-sm text-slate-200"
              onClick={async () => {
                try {
                  setDiagError(null);
                  setDiagMsg(null);
                  const ticker = diagTicker.trim().toUpperCase();
                  await adminFetch(`/api/admin/etf-source/${ticker}`, {
                    method: "PATCH",
                    body: JSON.stringify({ sourceUrl: diagSourceUrl.trim() || null }),
                  });
                  setDiagMsg(`Saved source URL override for ${ticker}.`);
                  await runEtfDiagnostics(false);
                } catch (err) {
                  setDiagError(err instanceof Error ? err.message : "Failed to save ETF source URL.");
                }
              }}
            >
              Save Source URL
            </button>
            <button
              className="rounded border border-accent/40 px-3 py-1 text-sm text-accent"
              onClick={async () => {
                try {
                  setDiagError(null);
                  setDiagMsg(null);
                  const ticker = diagTicker.trim().toUpperCase();
                  await adminFetch(`/api/admin/etf-source/${ticker}`, {
                    method: "PATCH",
                    body: JSON.stringify({ sourceUrl: diagSourceUrl.trim() || null }),
                  });
                  await runEtfDiagnostics(true);
                } catch (err) {
                  setDiagError(err instanceof Error ? err.message : "Failed to save ETF source URL.");
                }
              }}
              disabled={diagLoading}
            >
              Save + Sync
            </button>
          </div>
          {diagResult && (
            <div className="mt-2 overflow-auto rounded border border-borderSoft/70">
              <table className="min-w-full text-xs">
                <tbody>
                  <tr className="border-t border-borderSoft/60">
                    <td className="px-2 py-1 text-slate-400">Backend Revision</td>
                    <td className="px-2 py-1">{diagResult.backendRevision ?? "-"}</td>
                  </tr>
                  <tr className="border-t border-borderSoft/60">
                    <td className="px-2 py-1 text-slate-400">Configured Source URL</td>
                    <td className="px-2 py-1 break-all">{diagResult.sourceUrl ?? "-"}</td>
                  </tr>
                  <tr className="border-t border-borderSoft/60">
                    <td className="px-2 py-1 text-slate-400">Server Time (UTC)</td>
                    <td className="px-2 py-1">{formatDateTimeCompact(diagResult.serverTimeUtc)}</td>
                  </tr>
                  <tr className="border-t border-borderSoft/60">
                    <td className="px-2 py-1 text-slate-400">Database Connection</td>
                    <td className="px-2 py-1">{diagResult.db?.ok ? "OK" : `ERROR: ${diagResult.db?.error ?? "unknown"}`}</td>
                  </tr>
                  <tr className="border-t border-borderSoft/60">
                    <td className="px-2 py-1 text-slate-400">Watchlist Membership</td>
                    <td className="px-2 py-1">
                      {(diagResult.watchlists ?? []).length > 0
                        ? diagResult.watchlists.map((w: any) => w.listType).join(", ")
                        : "Not found in watchlists"}
                    </td>
                  </tr>
                  <tr className="border-t border-borderSoft/60">
                    <td className="px-2 py-1 text-slate-400">Sync Status</td>
                    <td className="px-2 py-1">{diagResult.syncStatus?.status ?? "-"}</td>
                  </tr>
                  <tr className="border-t border-borderSoft/60">
                    <td className="px-2 py-1 text-slate-400">Sync Source</td>
                    <td className="px-2 py-1">{diagResult.syncStatus?.source ?? "-"}</td>
                  </tr>
                  <tr className="border-t border-borderSoft/60">
                    <td className="px-2 py-1 text-slate-400">Last Synced</td>
                    <td className="px-2 py-1">{formatDateTimeCompact(diagResult.syncStatus?.lastSyncedAt)}</td>
                  </tr>
                  <tr className="border-t border-borderSoft/60">
                    <td className="px-2 py-1 text-slate-400">Cached Constituents</td>
                    <td className="px-2 py-1">{diagResult.constituentSummary?.count ?? 0}</td>
                  </tr>
                  <tr className="border-t border-borderSoft/60">
                    <td className="px-2 py-1 text-slate-400">Latest Constituents As-Of</td>
                    <td className="px-2 py-1">{diagResult.constituentSummary?.latestAsOfDate ?? "-"}</td>
                  </tr>
                  <tr className="border-t border-borderSoft/60">
                    <td className="px-2 py-1 text-slate-400">Sync Error</td>
                    <td className="px-2 py-1 text-red-300">{diagResult.syncStatus?.error ?? "-"}</td>
                  </tr>
                </tbody>
              </table>
              {(diagResult.topConstituents ?? []).length > 0 && (
                <div className="border-t border-borderSoft/60 p-2 text-xs text-slate-300">
                  Top constituents sample: {(diagResult.topConstituents ?? []).slice(0, 5).map((r: any) => `${r.ticker}${typeof r.weight === "number" ? ` (${r.weight.toFixed(2)}%)` : ""}`).join(", ")}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded border border-borderSoft p-2">
            <p className="mb-2 text-sm font-semibold">Add Sector ETF</p>
            <div className="grid gap-2">
              <input
                className="rounded border border-borderSoft bg-panelSoft px-2 py-1"
                placeholder="Ticker (e.g. XLF)"
                value={sectorEtfForm.ticker}
                onChange={(e) => setSectorEtfForm((s) => ({ ...s, ticker: e.target.value }))}
                onBlur={() => void resolveFundName(sectorEtfForm.ticker, "sector")}
              />
              <input className="rounded border border-borderSoft bg-panelSoft px-2 py-1" placeholder="Fund name (auto-filled if available)" value={sectorEtfForm.fundName} onChange={(e) => setSectorEtfForm((s) => ({ ...s, fundName: e.target.value }))} />
              <select className="rounded border border-borderSoft bg-panelSoft px-2 py-1" value={sectorEtfForm.parentSectorSelect} onChange={(e) => setSectorEtfForm((s) => ({ ...s, parentSectorSelect: e.target.value }))}>
                <option value="">Select existing parent sector...</option>
                {parentSectorOptions.map((opt) => (
                  <option key={`sector-parent-${opt}`} value={opt}>{opt}</option>
                ))}
              </select>
              <input className="rounded border border-borderSoft bg-panelSoft px-2 py-1" placeholder="Or enter new parent sector" value={sectorEtfForm.parentSectorNew} onChange={(e) => setSectorEtfForm((s) => ({ ...s, parentSectorNew: e.target.value }))} />
              <button className="rounded bg-accent/20 px-3 py-1 text-sm" onClick={async () => {
                try {
                  setEtfError(null);
                  const parentSector = (sectorEtfForm.parentSectorNew.trim() || sectorEtfForm.parentSectorSelect.trim()) || null;
                  await adminFetch("/api/admin/etfs", {
                    method: "POST",
                    body: JSON.stringify({
                      listType: "sector",
                      ticker: sectorEtfForm.ticker.trim().toUpperCase(),
                      fundName: sectorEtfForm.fundName.trim() || null,
                      parentSector,
                      industry: "Sector ETF",
                    }),
                  });
                  setSectorEtfForm({ ticker: "", fundName: "", parentSectorSelect: "", parentSectorNew: "" });
                  await load();
                } catch (err) {
                  setEtfError(err instanceof Error ? err.message : "Failed to add sector ETF.");
                }
              }}>
                Add Sector ETF
              </button>
            </div>
          </div>
          <div className="rounded border border-borderSoft p-2">
            <p className="mb-2 text-sm font-semibold">Add Industry ETF</p>
            <div className="grid gap-2">
              <input
                className="rounded border border-borderSoft bg-panelSoft px-2 py-1"
                placeholder="Ticker (e.g. SMH)"
                value={industryEtfForm.ticker}
                onChange={(e) => setIndustryEtfForm((s) => ({ ...s, ticker: e.target.value }))}
                onBlur={() => void resolveFundName(industryEtfForm.ticker, "industry")}
              />
              <input className="rounded border border-borderSoft bg-panelSoft px-2 py-1" placeholder="Fund name (auto-filled if available)" value={industryEtfForm.fundName} onChange={(e) => setIndustryEtfForm((s) => ({ ...s, fundName: e.target.value }))} />
              <select className="rounded border border-borderSoft bg-panelSoft px-2 py-1" value={industryEtfForm.parentSectorSelect} onChange={(e) => setIndustryEtfForm((s) => ({ ...s, parentSectorSelect: e.target.value }))}>
                <option value="">Select existing parent sector...</option>
                {parentSectorOptions.map((opt) => (
                  <option key={`industry-parent-${opt}`} value={opt}>{opt}</option>
                ))}
              </select>
              <input className="rounded border border-borderSoft bg-panelSoft px-2 py-1" placeholder="Or enter new parent sector" value={industryEtfForm.parentSectorNew} onChange={(e) => setIndustryEtfForm((s) => ({ ...s, parentSectorNew: e.target.value }))} />
              <select className="rounded border border-borderSoft bg-panelSoft px-2 py-1" value={industryEtfForm.industrySelect} onChange={(e) => setIndustryEtfForm((s) => ({ ...s, industrySelect: e.target.value }))}>
                <option value="">Select existing industry category...</option>
                {industryOptions.map((opt) => (
                  <option key={`industry-category-${opt}`} value={opt}>{opt}</option>
                ))}
              </select>
              <input className="rounded border border-borderSoft bg-panelSoft px-2 py-1" placeholder="Or enter new industry category" value={industryEtfForm.industryNew} onChange={(e) => setIndustryEtfForm((s) => ({ ...s, industryNew: e.target.value }))} />
              <button className="rounded bg-accent/20 px-3 py-1 text-sm" onClick={async () => {
                try {
                  setEtfError(null);
                  const parentSector = (industryEtfForm.parentSectorNew.trim() || industryEtfForm.parentSectorSelect.trim()) || null;
                  const industry = (industryEtfForm.industryNew.trim() || industryEtfForm.industrySelect.trim()) || null;
                  await adminFetch("/api/admin/etfs", {
                    method: "POST",
                    body: JSON.stringify({
                      listType: "industry",
                      ticker: industryEtfForm.ticker.trim().toUpperCase(),
                      fundName: industryEtfForm.fundName.trim() || null,
                      parentSector,
                      industry,
                    }),
                  });
                  setIndustryEtfForm({
                    ticker: "",
                    fundName: "",
                    parentSectorSelect: "",
                    parentSectorNew: "",
                    industrySelect: "",
                    industryNew: "",
                  });
                  await load();
                } catch (err) {
                  setEtfError(err instanceof Error ? err.message : "Failed to add industry ETF.");
                }
              }}>
                Add Industry ETF
              </button>
            </div>
          </div>
        </div>
        {etfError && <p className="mt-2 text-xs text-red-300">{etfError}</p>}
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <div>
            <p className="mb-1 text-xs uppercase tracking-[0.08em] text-slate-400">Sector ETFs ({sectorEtfs.length})</p>
            <div className="max-h-48 overflow-auto rounded border border-borderSoft p-2">
              {sectorEtfs.map((row) => (
                <div key={`s-${row.ticker}`} className="mb-1 flex items-center justify-between rounded bg-panelSoft px-2 py-1 text-xs">
                  <span>{row.ticker}</span>
                  <button className="rounded border border-red-500/40 px-1.5 py-0.5 text-[10px] text-red-300" onClick={async () => {
                    try {
                      setEtfError(null);
                      await deleteEtf("sector", row.ticker);
                    } catch (err) {
                      setEtfError(err instanceof Error ? err.message : `Failed to delete ${row.ticker}`);
                    }
                  }}>
                    Delete
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1 text-xs uppercase tracking-[0.08em] text-slate-400">Industry ETFs ({industryEtfs.length})</p>
            <div className="max-h-48 overflow-auto rounded border border-borderSoft p-2">
              {industryEtfs.map((row) => (
                <div key={`i-${row.ticker}-${row.industry}`} className="mb-1 flex items-center justify-between rounded bg-panelSoft px-2 py-1 text-xs">
                  <span>{row.ticker} {row.industry ? `(${row.industry})` : ""}</span>
                  <button className="rounded border border-red-500/40 px-1.5 py-0.5 text-[10px] text-red-300" onClick={async () => {
                    try {
                      setEtfError(null);
                      await deleteEtf("industry", row.ticker);
                    } catch (err) {
                      setEtfError(err instanceof Error ? err.message : `Failed to delete ${row.ticker}`);
                    }
                  }}>
                    Delete
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-3 rounded border border-borderSoft p-2">
          <p className="mb-2 text-xs uppercase tracking-[0.08em] text-slate-400">Industry ETF Category Organizer (Drag & Drop)</p>
          <div className="mb-2 grid gap-2 md:grid-cols-2">
            <select className="rounded border border-borderSoft bg-panelSoft px-2 py-1 text-xs" value={moveTarget.parentSectorSelect} onChange={(e) => setMoveTarget((s) => ({ ...s, parentSectorSelect: e.target.value }))}>
              <option value="">Target parent sector (existing)</option>
              {parentSectorOptions.map((opt) => (
                <option key={`move-parent-${opt}`} value={opt}>{opt}</option>
              ))}
            </select>
            <input className="rounded border border-borderSoft bg-panelSoft px-2 py-1 text-xs" placeholder="Or new parent sector" value={moveTarget.parentSectorNew} onChange={(e) => setMoveTarget((s) => ({ ...s, parentSectorNew: e.target.value }))} />
            <select className="rounded border border-borderSoft bg-panelSoft px-2 py-1 text-xs" value={moveTarget.industrySelect} onChange={(e) => setMoveTarget((s) => ({ ...s, industrySelect: e.target.value }))}>
              <option value="">Target industry (existing)</option>
              {industryOptions.map((opt) => (
                <option key={`move-industry-${opt}`} value={opt}>{opt}</option>
              ))}
            </select>
            <input className="rounded border border-borderSoft bg-panelSoft px-2 py-1 text-xs" placeholder="Or new industry category" value={moveTarget.industryNew} onChange={(e) => setMoveTarget((s) => ({ ...s, industryNew: e.target.value }))} />
          </div>
          <p className="mb-2 text-[11px] text-slate-400">Drag a ticker chip and drop into any category box below. To move into a brand-new category, use the target fields above and drop into the New Target box.</p>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {industryCategoryGroups.map((group) => (
              <div
                key={`drop-${group.parentSector}-${group.industry}`}
                className="rounded border border-borderSoft/70 bg-panelSoft/30 p-2"
                onDragOver={(e) => e.preventDefault()}
                onDrop={async (e) => {
                  e.preventDefault();
                  const ticker = e.dataTransfer.getData("text/plain") || dragTicker;
                  if (!ticker) return;
                  try {
                    setEtfError(null);
                    await moveIndustryTicker(ticker, group.parentSector, group.industry);
                  } catch (err) {
                    setEtfError(err instanceof Error ? err.message : `Failed to move ${ticker}`);
                  } finally {
                    setDragTicker(null);
                  }
                }}
              >
                <div className="mb-2 text-xs font-semibold text-slate-200">{group.parentSector} / {group.industry}</div>
                <div className="flex flex-wrap gap-1">
                  {group.rows.map((row) => (
                    <span
                      key={`drag-${group.parentSector}-${group.industry}-${row.ticker}`}
                      draggable
                      onDragStart={(e) => {
                        const ticker = String(row.ticker).toUpperCase();
                        setDragTicker(ticker);
                        e.dataTransfer.setData("text/plain", ticker);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      className="cursor-move rounded bg-slate-800 px-2 py-1 text-xs text-slate-100"
                      title="Drag to move category"
                    >
                      {row.ticker}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            <div
              className="rounded border border-dashed border-accent/50 bg-accent/5 p-2"
              onDragOver={(e) => e.preventDefault()}
              onDrop={async (e) => {
                e.preventDefault();
                const ticker = e.dataTransfer.getData("text/plain") || dragTicker;
                if (!ticker) return;
                const parentSector = (moveTarget.parentSectorNew.trim() || moveTarget.parentSectorSelect.trim());
                const industry = (moveTarget.industryNew.trim() || moveTarget.industrySelect.trim());
                if (!parentSector || !industry) {
                  setEtfError("Set target parent sector and industry before dropping into New Target.");
                  return;
                }
                try {
                  setEtfError(null);
                  await moveIndustryTicker(ticker, parentSector, industry);
                } catch (err) {
                  setEtfError(err instanceof Error ? err.message : `Failed to move ${ticker}`);
                } finally {
                  setDragTicker(null);
                }
              }}
            >
              <div className="mb-1 text-xs font-semibold text-accent">New Target Category</div>
              <div className="text-[11px] text-slate-300">Drop here to move dragged ticker into the target values above.</div>
            </div>
          </div>
        </div>
        <div className="mt-3">
          <p className="mb-1 text-xs uppercase tracking-[0.08em] text-slate-400">ETF Constituent Sync Status (Read-only)</p>
          <div className="max-h-64 overflow-auto rounded border border-borderSoft">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-900/60">
                <tr>
                  {["Ticker", "Status", "Records", "Cached Data", "Source", "Last Synced", "Error"].map((h) => (
                    <th key={h} className="px-2 py-1 text-left font-semibold text-slate-300">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {etfSyncStatus.map((row) => (
                  <tr key={`sync-${row.etfTicker}`} className="border-t border-borderSoft/60">
                    <td className="px-2 py-1">{row.etfTicker}</td>
                    <td className="px-2 py-1">{row.status ?? "-"}</td>
                    <td className="px-2 py-1">{row.recordsCount ?? 0}</td>
                    <td className="px-2 py-1">{(row.recordsCount ?? 0) > 0 ? "Yes" : "No"}</td>
                    <td className="px-2 py-1">{row.source ?? "-"}</td>
                    <td className="px-2 py-1">{formatDateTimeCompact(row.lastSyncedAt)}</td>
                    <td className="max-w-[420px] truncate px-2 py-1 text-red-300" title={row.error ?? ""}>{row.error ?? "-"}</td>
                  </tr>
                ))}
                {etfSyncStatus.length === 0 && (
                  <tr>
                    <td className="px-2 py-2 text-slate-400" colSpan={7}>No sync status rows found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="card flex flex-wrap gap-2 p-3">
        <input className="flex-1 rounded border border-borderSoft bg-panelSoft px-2 py-1" value={newSectionTitle} onChange={(e) => setNewSectionTitle(e.target.value)} placeholder="New section title" />
        <button className="rounded bg-accent/20 px-3 py-1 text-sm" onClick={addSection}>
          Add section
        </button>
      </div>
      {[...overviewSections, ...otherSections].map((section) => {
        const hideSectionChrome = isOverviewAdminSection(section.title);
        return (
        <div key={section.id} className="card scroll-mt-24 p-4" id={adminSectionAnchor(section.title)}>
          {hideSectionChrome ? null : (
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold">{section.title}</h3>
                {section.description ? <p className="text-xs text-slate-400">{section.description}</p> : null}
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="rounded border border-borderSoft px-2 py-1 text-xs"
                  onClick={() => toggleSection(section.id)}
                  type="button"
                >
                  {collapsedSections[section.id] ? "Expand" : "Collapse"}
                </button>
                <button className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-300" onClick={async () => {
                  await adminFetch("/api/admin/section/" + section.id, { method: "DELETE" });
                  await load();
                }}>
                  Delete section
                </button>
              </div>
            </div>
          )}
          {hideSectionChrome || !collapsedSections[section.id] ? (
            <>
          <div className="mb-3 flex gap-2">
            <input
              className="flex-1 rounded border border-borderSoft bg-panelSoft px-2 py-1"
              value={newGroupTitle[section.id] ?? ""}
              onChange={(e) => setNewGroupTitle((s) => ({ ...s, [section.id]: e.target.value }))}
              placeholder="New group title"
            />
            <button className="rounded bg-accent/20 px-3 py-1 text-sm" onClick={() => addGroup(section.id)}>
              Add group
            </button>
          </div>
          <div className="space-y-3">
            {section.groups.map((group, gi) => (
              <div key={group.id} className="rounded border border-borderSoft p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <input
                    className="rounded border border-borderSoft bg-panelSoft px-2 py-1"
                    value={group.title}
                    onChange={(e) => {
                      const next = structuredClone(data);
                      const target = next.sections.find((s) => s.id === section.id)?.groups.find((g) => g.id === group.id);
                      if (target) target.title = e.target.value;
                      setData(next);
                    }}
                  />
                  <select
                    className="rounded border border-borderSoft bg-panelSoft px-2 py-1"
                    value={group.rankingWindowDefault}
                    onChange={(e) => patchGroup(group.id, { ...group, rankingWindowDefault: e.target.value })}
                  >
                    {rankingOptions.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button className="rounded border border-borderSoft px-2 py-1 text-xs" onClick={() => move("group", section.groups.map((g) => g.id), gi, -1)}>
                    Up
                  </button>
                  <button className="rounded border border-borderSoft px-2 py-1 text-xs" onClick={() => move("group", section.groups.map((g) => g.id), gi, 1)}>
                    Down
                  </button>
                  <button className="rounded bg-accent/20 px-2 py-1 text-xs" onClick={() => patchGroup(group.id, group)}>
                    Save group
                  </button>
                  <button className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-300" onClick={async () => {
                    await adminFetch("/api/admin/group/" + group.id, { method: "DELETE" });
                    await load();
                  }}>
                    Delete group
                  </button>
                </div>
                <div className="mb-2 flex flex-wrap gap-2 text-xs">
                  {allColumns.map((col) => (
                    <label key={col} className="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={group.columns.includes(col)}
                        onChange={(e) => {
                          const nextCols = e.target.checked
                            ? [...group.columns, col]
                            : group.columns.filter((c) => c !== col);
                          patchGroup(group.id, { ...group, columns: nextCols });
                        }}
                      />
                      {col}
                    </label>
                  ))}
                </div>
                <div className="mb-2 flex gap-2">
                  <input
                    className="flex-1 rounded border border-borderSoft bg-panelSoft px-2 py-1"
                    value={tickerInput[group.id] ?? ""}
                    onChange={(e) => setTickerInput((s) => ({ ...s, [group.id]: e.target.value }))}
                    placeholder="Add tickers: XBI, TLT, EFA"
                  />
                  <button className="rounded bg-accent/20 px-3 py-1 text-sm" onClick={() => addTicker(group.id)}>
                    Add
                  </button>
                </div>
                {tickerErrors[group.id] && (
                  <p className="mb-2 text-xs text-red-300">{tickerErrors[group.id]}</p>
                )}
                <div className="space-y-2">
                  {group.items.map((item, ii) => (
                    <div key={item.id} className="flex flex-wrap items-center gap-2 rounded bg-panelSoft px-2 py-2 text-xs">
                      <span className="min-w-12 font-semibold text-slate-100">{item.ticker}</span>
                      <input
                        className="min-w-[16rem] flex-1 rounded border border-borderSoft bg-panel px-2 py-1 text-xs"
                        value={itemDisplayNames[item.id] ?? ""}
                        onChange={(e) => setItemDisplayNames((current) => ({ ...current, [item.id]: e.target.value }))}
                        placeholder="Current display name"
                      />
                      <button className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-200" onClick={() => void updateItemDisplayName(item.id)}>
                        Save Name
                      </button>
                      {itemDisplayNameStatus[item.id] ? (
                        <span className={`text-[11px] ${itemDisplayNameStatus[item.id] === "Saved." ? "text-emerald-300" : "text-red-300"}`}>
                          {itemDisplayNameStatus[item.id]}
                        </span>
                      ) : null}
                      <button
                        className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-300"
                        onClick={() => move("item", group.items.map((i) => i.id), ii, -1)}
                      >
                        Up
                      </button>
                      <button
                        className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-300"
                        onClick={() => move("item", group.items.map((i) => i.id), ii, 1)}
                      >
                        Down
                      </button>
                      <button className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-300" onClick={() => removeItem(item.id)}>
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
            </>
          ) : null}
          </div>
      );})}
    </div>
  );
}
