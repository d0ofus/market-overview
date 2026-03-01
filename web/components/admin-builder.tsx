"use client";

import { useEffect, useMemo, useState } from "react";
import { adminFetch } from "@/lib/api";
import type { SnapshotResponse } from "@/types/dashboard";

const rankingOptions = ["1D", "5D", "1W", "YTD", "52W"] as const;
const allColumns = ["ticker", "name", "price", "1D", "1W", "5D", "YTD", "pctFrom52WHigh", "sparkline"];

export function AdminBuilder() {
  const [data, setData] = useState<SnapshotResponse["config"] | null>(null);
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

  const load = async () => {
    const [config, sectorRes, industryRes, syncRes] = await Promise.all([
      adminFetch<SnapshotResponse["config"]>("/api/admin/config"),
      adminFetch<{ rows: any[] }>("/api/etfs/sector"),
      adminFetch<{ rows: any[] }>("/api/etfs/industry"),
      adminFetch<{ rows: any[] }>("/api/admin/etf-sync-status?limit=200"),
    ]);
    setData(config);
    setSectorEtfs(sectorRes.rows ?? []);
    setIndustryEtfs(industryRes.rows ?? []);
    setEtfSyncStatus(syncRes.rows ?? []);
  };
  useEffect(() => {
    void load();
  }, []);

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
      }),
    });
    await load();
  };

  if (!data) return <div className="card p-4">Loading admin config...</div>;

  return (
    <div className="space-y-4">
      <div className="card p-3">
        <h3 className="mb-2 text-base font-semibold">ETF Watchlists</h3>
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
                  {["Ticker", "Status", "Records", "Source", "Last Synced", "Error"].map((h) => (
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
                    <td className="px-2 py-1">{row.source ?? "-"}</td>
                    <td className="px-2 py-1">{row.lastSyncedAt ?? "-"}</td>
                    <td className="max-w-[420px] truncate px-2 py-1 text-red-300" title={row.error ?? ""}>{row.error ?? "-"}</td>
                  </tr>
                ))}
                {etfSyncStatus.length === 0 && (
                  <tr>
                    <td className="px-2 py-2 text-slate-400" colSpan={6}>No sync status rows found.</td>
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
      {data.sections.map((section) => (
        <div key={section.id} className="card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-lg font-semibold">{section.title}</h3>
            <button className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-300" onClick={async () => {
              await adminFetch("/api/admin/section/" + section.id, { method: "DELETE" });
              await load();
            }}>
              Delete section
            </button>
          </div>
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
                <div className="flex flex-wrap gap-2">
                  {group.items.map((item, ii) => (
                    <span key={item.id} className="rounded bg-panelSoft px-2 py-1 text-xs">
                      {item.ticker}
                      <button className="ml-2 text-red-400" onClick={() => removeItem(item.id)}>
                        x
                      </button>
                      <button
                        className="ml-2 text-slate-400"
                        onClick={() => move("item", group.items.map((i) => i.id), ii, -1)}
                      >
                        ^
                      </button>
                      <button
                        className="ml-1 text-slate-400"
                        onClick={() => move("item", group.items.map((i) => i.id), ii, 1)}
                      >
                        v
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
