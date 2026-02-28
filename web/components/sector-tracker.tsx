"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { adminFetch, getSectorCalendar, getSectorEntries, getSectorSymbolOptions, getSectorTrending } from "@/lib/api";
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

export function SectorTracker() {
  const [lookback, setLookback] = useState(30);
  const [view, setView] = useState<"list" | "calendar">("list");
  const [month, setMonth] = useState(monthKey());
  const [trending, setTrending] = useState<any[]>([]);
  const [entries, setEntries] = useState<SectorEntry[]>([]);
  const [calendarRows, setCalendarRows] = useState<SectorEntry[]>([]);
  const [symbolOptions, setSymbolOptions] = useState<Array<{ ticker: string; name: string | null }>>([]);

  const [sectorNarrative, setSectorNarrative] = useState("");
  const [eventDate, setEventDate] = useState(new Date().toISOString().slice(0, 10));
  const [trendScore, setTrendScore] = useState(0);
  const [notes, setNotes] = useState("");
  const [tickerInput, setTickerInput] = useState("");
  const [selectedTickers, setSelectedTickers] = useState<string[]>([]);
  const [activeChartTicker, setActiveChartTicker] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = async () => {
    const [trendRes, entriesRes, calRes, symbolRes] = await Promise.all([
      getSectorTrending(lookback),
      getSectorEntries(),
      getSectorCalendar(month),
      getSectorSymbolOptions(),
    ]);
    setTrending(trendRes.sectors ?? []);
    setEntries(entriesRes.rows ?? []);
    setCalendarRows(calRes.rows ?? []);
    setSymbolOptions(symbolRes.rows ?? []);
  };

  useEffect(() => {
    void load();
  }, [lookback, month]);

  const symbolLookup = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const s of symbolOptions) map.set(s.ticker.toUpperCase(), s.name ?? null);
    return map;
  }, [symbolOptions]);

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

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h3 className="mb-2 text-base font-semibold">Trending Sectors ({lookback}D)</h3>
        <div className="mb-3 flex gap-2">
          {[30, 60, 90].map((d) => (
            <button key={d} className={`rounded px-2 py-1 text-xs ${lookback === d ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`} onClick={() => setLookback(d)}>
              {d}D
            </button>
          ))}
          <button className={`rounded px-2 py-1 text-xs ${view === "list" ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`} onClick={() => setView("list")}>List</button>
          <button className={`rounded px-2 py-1 text-xs ${view === "calendar" ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`} onClick={() => setView("calendar")}>Calendar</button>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/60">
              <tr>
                {["Sector", "Trend 5D", "Symbols"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trending.slice(0, 20).map((s) => (
                <tr key={s.sector} className="border-t border-borderSoft/60">
                  <td className="px-3 py-2 text-slate-200">{s.sector}</td>
                  <td className={`px-3 py-2 ${pctCls(s.trend5d)}`}>{s.trend5d.toFixed(2)}%</td>
                  <td className="px-3 py-2 text-slate-300">{s.symbolCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4">
        <h3 className="mb-3 text-base font-semibold">Add Sector/Narrative</h3>
        <div className="grid gap-2 md:grid-cols-3">
          <input className="rounded border border-borderSoft bg-panelSoft px-2 py-1 md:col-span-2" placeholder="Sector/Narrative (e.g. AI Datacenter Buildout)" value={sectorNarrative} onChange={(e) => setSectorNarrative(e.target.value)} />
          <input type="date" className="rounded border border-borderSoft bg-panelSoft px-2 py-1" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
          <input type="number" className="rounded border border-borderSoft bg-panelSoft px-2 py-1" placeholder="Trend score (optional)" value={trendScore} onChange={(e) => setTrendScore(Number(e.target.value))} />
          <div className="flex gap-2 md:col-span-2">
            <input
              className="w-full rounded border border-borderSoft bg-panelSoft px-2 py-1"
              placeholder="Add tickers, comma-separated (e.g. NVDA, AMD, TSM)"
              value={tickerInput}
              onChange={(e) => setTickerInput(e.target.value)}
              list="sector-symbol-options"
            />
            <button
              className="rounded border border-borderSoft px-3 py-1 text-sm text-slate-200"
              onClick={() => {
                addTicker(tickerInput);
                setTickerInput("");
              }}
            >
              Add
            </button>
          </div>
          <textarea className="rounded border border-borderSoft bg-panelSoft px-2 py-1 md:col-span-3" placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
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
        <button
          className="mt-3 rounded bg-accent/20 px-3 py-1 text-sm text-accent"
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
          Add Sector/Narrative
        </button>
      </div>

      {view === "list" ? (
        <div className="card p-4">
          <h3 className="mb-2 text-base font-semibold">Tracked Sector/Narrative Entries</h3>
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
        </div>
      ) : (
        <div className="card p-4">
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
                <div key={date} className="min-h-24 rounded border border-borderSoft/70 bg-panelSoft/40 p-1">
                  <div className="text-xs text-slate-400">{day}</div>
                  <div className="mt-1 space-y-1">
                    {items.slice(0, 3).map((it) => (
                      <div key={it.id} className="rounded bg-slate-900/60 px-1 py-1 text-[10px] text-slate-200">
                        <div className={`font-semibold ${pctCls(it.trendScore)}`}>{it.sectorName}</div>
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {(it.symbols ?? []).slice(0, 4).map((s) => (
                            <button
                              key={`${it.id}-${s.ticker}`}
                              className="rounded bg-accent/15 px-1 py-0.5 text-[10px] text-accent hover:bg-accent/25"
                              onClick={() => setActiveChartTicker(s.ticker)}
                              title={s.name ?? s.ticker}
                            >
                              {s.ticker}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
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
