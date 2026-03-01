"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown, Loader2, X } from "lucide-react";
import { adminFetch, getEtfConstituents, getIndustryEtfs, getSectorCalendar, getSectorEntries, getSectorEtfs, getSectorSymbolOptions } from "@/lib/api";
import { TradingViewWidget } from "./tradingview-widget";

const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const pctCls = (n: number) => (n >= 0 ? "text-pos" : "text-neg");

type EntrySymbol = { ticker: string; name: string | null };
type SectorEntry = {
  id: string;
  sectorName: string;
  eventDate: string;
  trendScore: number;
  notes: string | null;
  symbols: EntrySymbol[];
};

type WatchlistEtf = {
  listType: "sector" | "industry";
  parentSector: string | null;
  industry: string | null;
  ticker: string;
  fundName: string;
  sortOrder: number;
  change1d: number;
  lastPrice: number;
};

type EtfConstituent = {
  ticker: string;
  name: string | null;
  weight: number | null;
};

function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
  rightSlot,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
  rightSlot?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="card overflow-hidden">
      <Collapsible.Trigger className="flex w-full items-center justify-between border-b border-borderSoft/70 px-4 py-3 text-left">
        <div className="flex items-center gap-3">
          <span className="text-base font-semibold">{title}</span>
          {rightSlot}
        </div>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </Collapsible.Trigger>
      <Collapsible.Content className="p-4">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

export function SectorTracker() {
  const [view, setView] = useState<"list" | "calendar">("list");
  const [month, setMonth] = useState(monthKey());
  const [entries, setEntries] = useState<SectorEntry[]>([]);
  const [calendarRows, setCalendarRows] = useState<SectorEntry[]>([]);
  const [symbolOptions, setSymbolOptions] = useState<Array<{ ticker: string; name: string | null }>>([]);
  const [sectorEtfs, setSectorEtfs] = useState<WatchlistEtf[]>([]);
  const [industryEtfs, setIndustryEtfs] = useState<WatchlistEtf[]>([]);

  const [sectorNarrative, setSectorNarrative] = useState("");
  const [eventDate, setEventDate] = useState(new Date().toISOString().slice(0, 10));
  const [trendScore, setTrendScore] = useState(0);
  const [notes, setNotes] = useState("");
  const [tickerInput, setTickerInput] = useState("");
  const [selectedTickers, setSelectedTickers] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const [activeEtf, setActiveEtf] = useState<{ ticker: string; fundName?: string | null } | null>(null);
  const [constituents, setConstituents] = useState<EtfConstituent[]>([]);
  const [constituentWarning, setConstituentWarning] = useState<string | null>(null);
  const [constituentLoading, setConstituentLoading] = useState(false);
  const [activeChartTicker, setActiveChartTicker] = useState<string | null>(null);

  const load = async () => {
    const [entriesRes, calRes, symbolRes, sectorEtfRes, industryEtfRes] = await Promise.all([
      getSectorEntries(),
      getSectorCalendar(month),
      getSectorSymbolOptions(),
      getSectorEtfs(),
      getIndustryEtfs(),
    ]);
    setEntries(entriesRes.rows ?? []);
    setCalendarRows(calRes.rows ?? []);
    setSymbolOptions(symbolRes.rows ?? []);
    setSectorEtfs((sectorEtfRes.rows ?? []) as WatchlistEtf[]);
    setIndustryEtfs((industryEtfRes.rows ?? []) as WatchlistEtf[]);
  };

  useEffect(() => {
    void load();
  }, [month]);

  const openEtfPopup = async (ticker: string, fundName?: string | null) => {
    setActiveEtf({ ticker, fundName: fundName ?? null });
    setConstituentLoading(true);
    setConstituentWarning(null);
    setConstituents([]);
    try {
      const res = await getEtfConstituents(ticker);
      setConstituents((res.rows ?? []) as EtfConstituent[]);
      setConstituentWarning(res.warning ?? null);
    } catch (error) {
      setConstituentWarning(error instanceof Error ? error.message : "Failed to load ETF constituents.");
    } finally {
      setConstituentLoading(false);
    }
  };

  const addTicker = (inputRaw: string) => {
    const parsed = inputRaw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .filter((s) => /^[A-Z.\-^]{1,20}$/.test(s));
    if (parsed.length === 0) return;
    setSelectedTickers((prev) => Array.from(new Set([...prev, ...parsed])));
  };

  const daysInMonth = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    return new Date(y, m, 0).getDate();
  }, [month]);

  const calendarMap = useMemo(() => {
    const map = new Map<string, SectorEntry[]>();
    for (const row of calendarRows) {
      const arr = map.get(row.eventDate) ?? [];
      arr.push(row);
      map.set(row.eventDate, arr);
    }
    return map;
  }, [calendarRows]);

  const industryGroups = useMemo(() => {
    const groups = new Map<string, { rows: WatchlistEtf[]; maxChange: number }>();
    for (const row of industryEtfs) {
      const key = `${row.parentSector ?? "Other"} :: ${row.industry ?? "General"}`;
      const existing = groups.get(key) ?? { rows: [], maxChange: Number.NEGATIVE_INFINITY };
      existing.rows.push(row);
      existing.maxChange = Math.max(existing.maxChange, row.change1d ?? 0);
      groups.set(key, existing);
    }
    return [...groups.entries()]
      .map(([key, value]) => ({
        key,
        maxChange: value.maxChange === Number.NEGATIVE_INFINITY ? 0 : value.maxChange,
        rows: [...value.rows].sort((a, b) => b.change1d - a.change1d),
      }))
      .sort((a, b) => b.maxChange - a.maxChange);
  }, [industryEtfs]);

  return (
    <div className="space-y-4">
      <div className="card p-3" id="section-selector">
        <label className="mb-1 block text-xs uppercase tracking-[0.08em] text-slate-400">Jump To Section</label>
        <select
          className="w-full rounded border border-borderSoft bg-panelSoft px-2 py-1 text-sm md:max-w-sm"
          defaultValue=""
          onChange={(e) => {
            const id = e.target.value;
            if (!id) return;
            const el = document.getElementById(id);
            if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        >
          <option value="">Select section...</option>
          <option value="sector-etfs">Sector ETFs</option>
          <option value="industry-etfs">Industry ETFs</option>
          <option value="key-movers-tracker">Key Movers Tracker</option>
        </select>
      </div>

      <div id="sector-etfs">
      <CollapsibleSection title="Sector ETFs" rightSlot={<span className="rounded bg-accent/10 px-2 py-0.5 text-xs text-accent">{sectorEtfs.length} ETFs</span>}>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {sectorEtfs.map((etf) => (
            <div key={etf.ticker} className="rounded-xl border border-borderSoft/70 bg-panelSoft/30 p-2">
              <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                <button className="text-sm font-semibold text-accent hover:underline" onClick={() => void openEtfPopup(etf.ticker, etf.fundName)}>
                  {etf.ticker}
                </button>
                <p className="line-clamp-2 text-xs text-slate-400">{etf.fundName}</p>
                </div>
                <div className="text-right text-xs">
                  <div className={pctCls(etf.change1d ?? 0)}>{(etf.change1d ?? 0).toFixed(2)}%</div>
                  <div className="text-slate-400">{(etf.lastPrice ?? 0).toFixed(2)}</div>
                </div>
              </div>
              <TradingViewWidget ticker={etf.ticker} size="small" className="!border-0 !bg-transparent !shadow-none !p-0" />
            </div>
          ))}
        </div>
      </CollapsibleSection>
      </div>

      <div id="industry-etfs">
      <CollapsibleSection title="Industry ETFs" rightSlot={<span className="rounded bg-accent/10 px-2 py-0.5 text-xs text-accent">{industryEtfs.length} ETFs</span>}>
        <div className="space-y-4">
          {industryGroups.map(({ key, rows, maxChange }) => {
            const [parentSector, industry] = key.split(" :: ");
            return (
              <div key={key} className="rounded-xl border border-borderSoft/70 p-2">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div>
                  <h4 className="text-sm font-semibold text-slate-200">{industry}</h4>
                  <p className="text-xs text-slate-400">{parentSector}</p>
                  </div>
                  <div className={`text-xs ${pctCls(maxChange)}`}>Top: {maxChange.toFixed(2)}%</div>
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  {rows.map((etf) => (
                    <div key={`${key}-${etf.ticker}`} className="rounded-lg border border-borderSoft/60 bg-panelSoft/20 p-2">
                      <div className="mb-2 flex items-start justify-between gap-2">
                        <div>
                        <button className="text-sm font-semibold text-accent hover:underline" onClick={() => void openEtfPopup(etf.ticker, etf.fundName)}>
                          {etf.ticker}
                        </button>
                        <p className="line-clamp-2 text-xs text-slate-400">{etf.fundName}</p>
                        </div>
                        <div className="text-right text-xs">
                          <div className={pctCls(etf.change1d ?? 0)}>{(etf.change1d ?? 0).toFixed(2)}%</div>
                          <div className="text-slate-400">{(etf.lastPrice ?? 0).toFixed(2)}</div>
                        </div>
                      </div>
                      <TradingViewWidget ticker={etf.ticker} size="small" className="!border-0 !bg-transparent !shadow-none !p-0" />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </CollapsibleSection>
      </div>

      <div id="key-movers-tracker">
      <CollapsibleSection title="Key Movers Tracker">
        <div className="mb-3 rounded-xl border border-borderSoft/70 bg-panelSoft/25 p-3">
          <h4 className="mb-2 text-sm font-semibold text-slate-200">Add Sector/Narrative</h4>
          <div className="grid gap-2 md:grid-cols-6">
            <input className="rounded border border-borderSoft bg-panelSoft px-2 py-1 md:col-span-2" placeholder="Sector/Narrative" value={sectorNarrative} onChange={(e) => setSectorNarrative(e.target.value)} />
            <input type="date" className="rounded border border-borderSoft bg-panelSoft px-2 py-1" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
            <input type="number" className="rounded border border-borderSoft bg-panelSoft px-2 py-1" placeholder="Trend score" value={trendScore} onChange={(e) => setTrendScore(Number(e.target.value))} />
            <input
              className="rounded border border-borderSoft bg-panelSoft px-2 py-1 md:col-span-2"
              placeholder="Add tickers (comma-separated)"
              value={tickerInput}
              onChange={(e) => setTickerInput(e.target.value)}
              list="sector-symbol-options"
            />
            <textarea className="rounded border border-borderSoft bg-panelSoft px-2 py-1 md:col-span-5" placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            <button
              className="rounded border border-borderSoft px-3 py-1 text-sm text-slate-200"
              onClick={() => {
                addTicker(tickerInput);
                setTickerInput("");
              }}
            >
              Add Tickers
            </button>
          </div>
          <datalist id="sector-symbol-options">
            {symbolOptions.map((s) => (
              <option key={s.ticker} value={s.ticker}>{s.name ? `${s.ticker} - ${s.name}` : s.ticker}</option>
            ))}
          </datalist>
          <div className="mt-2 flex flex-wrap gap-2">
            {selectedTickers.map((ticker) => (
              <span key={ticker} className="inline-flex items-center gap-1 rounded bg-slate-800/70 px-2 py-1 text-xs text-slate-200">
                {ticker}
                <button
                  className="rounded px-1 text-slate-400 hover:text-slate-100"
                  onClick={() => setSelectedTickers((prev) => prev.filter((t) => t !== ticker))}
                  aria-label={`Remove ${ticker}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          {formError && <p className="mt-2 text-xs text-red-300">{formError}</p>}
          <div className="mt-2">
            <button
              className="rounded bg-accent/20 px-3 py-1 text-sm text-accent"
              onClick={async () => {
                setFormError(null);
                if (!sectorNarrative.trim() || !eventDate) {
                  setFormError("Sector/Narrative and date are required.");
                  return;
                }
                try {
                  await adminFetch("/api/sectors/entries", {
                    method: "POST",
                    body: JSON.stringify({
                      sectorName: sectorNarrative.trim(),
                      eventDate,
                      trendScore: Number.isFinite(trendScore) ? trendScore : 0,
                      notes: notes.trim() || null,
                      symbols: selectedTickers,
                    }),
                  });
                  setSectorNarrative("");
                  setNotes("");
                  setSelectedTickers([]);
                  setTickerInput("");
                  setTrendScore(0);
                  await load();
                } catch (err) {
                  setFormError(err instanceof Error ? err.message : "Failed to add sector/narrative entry.");
                }
              }}
            >
              Save Entry
            </button>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap gap-2">
          <button className={`rounded px-2 py-1 text-xs ${view === "list" ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`} onClick={() => setView("list")}>List</button>
          <button className={`rounded px-2 py-1 text-xs ${view === "calendar" ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`} onClick={() => setView("calendar")}>Calendar</button>
        </div>
        {view === "list" ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900/60">
                <tr>
                  {["Date", "Sector/Narrative", "Trend", "Tickers", "Notes"].map((h) => (
                    <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-t border-borderSoft/60">
                    <td className="px-3 py-2">{e.eventDate}</td>
                    <td className="px-3 py-2">{e.sectorName}</td>
                    <td className={`px-3 py-2 ${pctCls(e.trendScore)}`}>{e.trendScore.toFixed(1)}</td>
                    <td className="px-3 py-2 text-slate-300">
                      <div className="flex flex-wrap gap-1">
                        {(e.symbols ?? []).length === 0 && <span>-</span>}
                        {(e.symbols ?? []).map((s) => (
                          <button
                            key={`${e.id}-${s.ticker}`}
                            className="rounded bg-accent/15 px-2 py-0.5 text-xs text-accent hover:bg-accent/25"
                            onClick={() => setActiveChartTicker(s.ticker)}
                            title={s.name ?? s.ticker}
                          >
                            {s.ticker}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-slate-300">{e.notes ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold">Sector/Narrative Calendar</h3>
              <input type="month" className="rounded border border-borderSoft bg-panelSoft px-2 py-1 text-sm" value={month} onChange={(e) => setMonth(e.target.value)} />
            </div>
            <div className="grid grid-cols-7 gap-2 text-xs text-slate-400">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                <div key={d} className="px-1 py-1 text-center">{d}</div>
              ))}
            </div>
            <div className="mt-1 grid grid-cols-7 gap-2">
              {Array.from({ length: daysInMonth }, (_, i) => {
                const day = i + 1;
                const date = `${month}-${String(day).padStart(2, "0")}`;
                const items = calendarMap.get(date) ?? [];
                return (
                  <div key={date} className="min-h-48 rounded border border-borderSoft/70 bg-panelSoft/40 p-1.5">
                    <div className="text-xs text-slate-400">{day}</div>
                    <div className="mt-1 space-y-1.5">
                      {items.slice(0, 3).map((it) => (
                        <div key={it.id} className="rounded bg-slate-900/60 px-1.5 py-1 text-[10px] text-slate-200">
                          <div className={`font-semibold ${pctCls(it.trendScore)}`}>{it.sectorName}</div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {(it.symbols ?? []).map((s) => (
                              <button
                                key={`${it.id}-${s.ticker}`}
                                className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/25"
                                onClick={() => setActiveChartTicker(s.ticker)}
                                title={s.name ?? s.ticker}
                              >
                                {s.ticker}
                              </button>
                            ))}
                          </div>
                          {it.notes && <p className="mt-1 whitespace-normal break-words text-[10px] leading-snug text-slate-300">{it.notes}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CollapsibleSection>
      </div>

      {activeEtf && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-950/70 p-4" onClick={() => setActiveEtf(null)}>
          <div className="w-full max-w-6xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between rounded border border-borderSoft bg-panel px-3 py-2">
              <h4 className="text-sm font-semibold text-slate-100">
                {activeEtf.ticker} Constituents {activeEtf.fundName ? `- ${activeEtf.fundName}` : ""}
              </h4>
              <button className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-200" onClick={() => setActiveEtf(null)}>
                Close
              </button>
            </div>
            {constituentWarning && (
              <div className="mb-2 rounded border border-yellow-700/50 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-200">
                Constituent sync warning: {constituentWarning}
              </div>
            )}
            {constituentLoading ? (
              <div className="card flex items-center gap-2 p-4 text-sm text-slate-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading constituents...
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {constituents.map((row) => (
                  <div key={`${activeEtf.ticker}-${row.ticker}`} className="card p-2">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-semibold text-accent">{row.ticker}</span>
                      <span className="text-xs text-slate-400">{row.weight != null ? `${row.weight.toFixed(2)}%` : "-"}</span>
                    </div>
                    <p className="mb-2 line-clamp-2 text-xs text-slate-400">{row.name ?? row.ticker}</p>
                    <TradingViewWidget ticker={row.ticker} size="small" className="!border-0 !bg-transparent !shadow-none !p-0" />
                  </div>
                ))}
                {constituents.length === 0 && (
                  <div className="card p-4 text-sm text-slate-300">No constituents available for this ETF.</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {activeChartTicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4" onClick={() => setActiveChartTicker(null)}>
          <div className="w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between rounded border border-borderSoft bg-panel px-3 py-2">
              <h4 className="text-sm font-semibold text-slate-100">TradingView: {activeChartTicker}</h4>
              <button className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-200" onClick={() => setActiveChartTicker(null)}>
                Close
              </button>
            </div>
            <TradingViewWidget ticker={activeChartTicker} />
          </div>
        </div>
      )}
    </div>
  );
}
