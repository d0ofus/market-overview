"use client";

import { useEffect, useMemo, useState } from "react";
import { adminFetch } from "@/lib/api";
import type { EtfDiagnosticsResult, EtfListRow, EtfSyncStatusRow } from "./overview-admin-shared";
import { formatDateTimeCompact } from "./overview-admin-shared";

type Message = {
  tone: "success" | "danger" | "info";
  text: string;
} | null;

export function useOverviewEtfAdmin() {
  const [sectorEtfs, setSectorEtfs] = useState<EtfListRow[]>([]);
  const [industryEtfs, setIndustryEtfs] = useState<EtfListRow[]>([]);
  const [etfSyncStatus, setEtfSyncStatus] = useState<EtfSyncStatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<Message>(null);
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
  const [diagTicker, setDiagTicker] = useState("TAN");
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [diagMsg, setDiagMsg] = useState<string | null>(null);
  const [diagResult, setDiagResult] = useState<EtfDiagnosticsResult | null>(null);
  const [diagSourceUrl, setDiagSourceUrl] = useState("");
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null);

  const flashMessage = (next: NonNullable<Message>, timeoutMs = 4000) => {
    setMessage(next);
    window.setTimeout(() => {
      setMessage((current) => (current?.text === next.text ? null : current));
    }, timeoutMs);
  };

  const load = async () => {
    setLoading(true);
    try {
      const [sectorRes, industryRes, syncRes] = await Promise.all([
        adminFetch<{ rows: EtfListRow[] }>("/api/etfs/sector"),
        adminFetch<{ rows: EtfListRow[] }>("/api/etfs/industry"),
        adminFetch<{ rows: EtfSyncStatusRow[] }>("/api/admin/etf-sync-status?limit=200"),
      ]);
      setSectorEtfs(sectorRes.rows ?? []);
      setIndustryEtfs(industryRes.rows ?? []);
      setEtfSyncStatus(syncRes.rows ?? []);
    } catch (error) {
      flashMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to load ETF admin data." }, 5000);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const parentSectorOptions = useMemo(() => {
    const options = new Set<string>();
    for (const row of [...sectorEtfs, ...industryEtfs]) {
      if (row.parentSector) options.add(String(row.parentSector));
    }
    return Array.from(options).sort((left, right) => left.localeCompare(right));
  }, [industryEtfs, sectorEtfs]);

  const industryOptions = useMemo(() => {
    const options = new Set<string>();
    for (const row of industryEtfs) {
      if (row.industry) options.add(String(row.industry));
    }
    return Array.from(options).sort((left, right) => left.localeCompare(right));
  }, [industryEtfs]);

  const industryCategoryGroups = useMemo(() => {
    const grouped = new Map<string, { parentSector: string; industry: string; rows: EtfListRow[] }>();
    for (const row of industryEtfs) {
      const parent = row.parentSector ?? "Other";
      const industry = row.industry ?? "General";
      const key = `${parent}::${industry}`;
      const current = grouped.get(key) ?? { parentSector: parent, industry, rows: [] as EtfListRow[] };
      current.rows.push(row);
      grouped.set(key, current);
    }
    return Array.from(grouped.values()).sort((left, right) => {
      const parentCompare = left.parentSector.localeCompare(right.parentSector);
      if (parentCompare !== 0) return parentCompare;
      return left.industry.localeCompare(right.industry);
    });
  }, [industryEtfs]);

  const resolveFundName = async (tickerInput: string, form: "sector" | "industry") => {
    const ticker = tickerInput.trim().toUpperCase();
    if (!ticker) return;
    try {
      const meta = await adminFetch<{ name: string | null }>(`/api/admin/ticker-meta/${ticker}`);
      if (!meta?.name) return;
      if (form === "sector") {
        setSectorEtfForm((current) => ({ ...current, ticker, fundName: current.fundName.trim() ? current.fundName : meta.name ?? "" }));
      } else {
        setIndustryEtfForm((current) => ({ ...current, ticker, fundName: current.fundName.trim() ? current.fundName : meta.name ?? "" }));
      }
    } catch {
      // keep manual path available
    }
  };

  const deleteEtf = async (listType: "sector" | "industry", ticker: string) => {
    await adminFetch(`/api/admin/etfs/${listType}/${ticker}`, { method: "DELETE" });
    await load();
    flashMessage({ tone: "success", text: `${ticker} removed from ${listType} ETFs.` });
  };

  const addSectorEtf = async () => {
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
    flashMessage({ tone: "success", text: "Sector ETF added." });
  };

  const addIndustryEtf = async () => {
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
    flashMessage({ tone: "success", text: "Industry ETF added." });
  };

  const runBackfill = async () => {
    try {
      setBackfillMsg(null);
      const result = await adminFetch<{ ok: boolean; attempted: number; synced: number; failed: Array<{ ticker: string; error: string }> }>("/api/admin/etf-sync-backfill", {
        method: "POST",
        body: JSON.stringify({ limit: 3 }),
      });
      setBackfillMsg(
        result.failed.length > 0
          ? `Synced ${result.synced}/${result.attempted}. Failed: ${result.failed.map((row) => row.ticker).join(", ")}`
          : `Synced ${result.synced}/${result.attempted} ETFs.`,
      );
      await load();
    } catch (error) {
      setBackfillMsg(error instanceof Error ? error.message : "Failed to run ETF constituent backfill.");
    }
  };

  const runDiagnostics = async (syncFirst = false) => {
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
        const syncResult = await adminFetch<{ ok: boolean; ticker: string; count: number; source: string }>(`/api/admin/etf/${ticker}/sync`, {
          method: "POST",
        });
        setDiagMsg(`Synced ${syncResult.ticker}: ${syncResult.count} constituents from ${syncResult.source}.`);
      }
      const result = await adminFetch<EtfDiagnosticsResult>(`/api/admin/etf-sync-diagnostics?ticker=${encodeURIComponent(ticker)}`);
      setDiagResult(result);
      setDiagSourceUrl(String(result.sourceUrl ?? result.watchlists?.[0]?.sourceUrl ?? ""));
    } catch (error) {
      setDiagError(error instanceof Error ? error.message : "Failed to run ETF diagnostics.");
    } finally {
      setDiagLoading(false);
    }
  };

  const saveSourceUrl = async (syncAfterSave = false) => {
    try {
      const ticker = diagTicker.trim().toUpperCase();
      setDiagError(null);
      setDiagMsg(null);
      await adminFetch(`/api/admin/etf-source/${ticker}`, {
        method: "PATCH",
        body: JSON.stringify({ sourceUrl: diagSourceUrl.trim() || null }),
      });
      flashMessage({ tone: "success", text: `Saved source URL override for ${ticker}.` });
      if (syncAfterSave) {
        await runDiagnostics(true);
      } else {
        await runDiagnostics(false);
      }
    } catch (error) {
      setDiagError(error instanceof Error ? error.message : "Failed to save ETF source URL.");
    }
  };

  const moveIndustryTicker = async (ticker: string, parentSector: string, industry: string) => {
    const row = industryEtfs.find((entry) => String(entry.ticker).toUpperCase() === ticker.toUpperCase());
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
    flashMessage({ tone: "success", text: `${ticker} moved to ${parentSector} / ${industry}.` });
  };

  return {
    sectorEtfs,
    industryEtfs,
    etfSyncStatus,
    loading,
    message,
    setMessage,
    sectorEtfForm,
    setSectorEtfForm,
    industryEtfForm,
    setIndustryEtfForm,
    parentSectorOptions,
    industryOptions,
    industryCategoryGroups,
    dragTicker,
    setDragTicker,
    moveTarget,
    setMoveTarget,
    diagTicker,
    setDiagTicker,
    diagLoading,
    diagError,
    diagMsg,
    diagResult,
    diagSourceUrl,
    setDiagSourceUrl,
    backfillMsg,
    load,
    resolveFundName,
    deleteEtf,
    addSectorEtf,
    addIndustryEtf,
    runBackfill,
    runDiagnostics,
    saveSourceUrl,
    moveIndustryTicker,
    formatDateTimeCompact,
  };
}
