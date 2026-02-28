"use client";

import { useEffect, useMemo, useState } from "react";
import { adminFetch, getSectorCalendar, getSectorEntries, getSectorNarratives, getSectorSymbolOptions, getSectorTrending } from "@/lib/api";

const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const pctCls = (n: number) => (n >= 0 ? "text-pos" : "text-neg");

type SectorEntry = {
  id: string;
  sectorName: string;
  eventDate: string;
  trendScore: number;
  notes: string | null;
  narrativeId: string | null;
  narrativeTitle: string | null;
  symbols: Array<{ ticker: string; name: string | null }>;
};

export function SectorTracker() {
  const [lookback, setLookback] = useState(30);
  const [view, setView] = useState<"list" | "calendar">("list");
  const [month, setMonth] = useState(monthKey());
  const [trending, setTrending] = useState<any[]>([]);
  const [entries, setEntries] = useState<SectorEntry[]>([]);
  const [calendarRows, setCalendarRows] = useState<any[]>([]);
  const [narratives, setNarratives] = useState<any[]>([]);
  const [symbolOptions, setSymbolOptions] = useState<any[]>([]);

  const [narrativeTitle, setNarrativeTitle] = useState("");
  const [narrativeDesc, setNarrativeDesc] = useState("");
  const [sectorName, setSectorName] = useState("");
  const [eventDate, setEventDate] = useState(new Date().toISOString().slice(0, 10));
  const [trendScore, setTrendScore] = useState(0);
  const [notes, setNotes] = useState("");
  const [narrativeId, setNarrativeId] = useState<string>("");
  const [selectedTickers, setSelectedTickers] = useState<string[]>([]);

  const load = async () => {
    const [trendRes, entriesRes, calRes, narRes] = await Promise.all([
      getSectorTrending(lookback),
      getSectorEntries(),
      getSectorCalendar(month),
      getSectorNarratives(),
    ]);
    setTrending(trendRes.sectors ?? []);
    setEntries(entriesRes.rows ?? []);
    setCalendarRows(calRes.rows ?? []);
    setNarratives(narRes.rows ?? []);
  };

  useEffect(() => {
    void load();
  }, [lookback, month]);

  useEffect(() => {
    if (!sectorName.trim()) return;
    void getSectorSymbolOptions(sectorName).then((r) => setSymbolOptions(r.rows ?? []));
  }, [sectorName]);

  const daysInMonth = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    return new Date(y, m, 0).getDate();
  }, [month]);

  const calendarMap = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const row of calendarRows) {
      const d = row.eventDate;
      const arr = map.get(d) ?? [];
      arr.push(row);
      map.set(d, arr);
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
        <h3 className="mb-2 text-base font-semibold">Narratives</h3>
        <div className="mb-3 grid gap-2 md:grid-cols-3">
          <input className="rounded border border-borderSoft bg-panelSoft px-2 py-1" placeholder="Narrative title" value={narrativeTitle} onChange={(e) => setNarrativeTitle(e.target.value)} />
          <input className="rounded border border-borderSoft bg-panelSoft px-2 py-1 md:col-span-2" placeholder="Description" value={narrativeDesc} onChange={(e) => setNarrativeDesc(e.target.value)} />
        </div>
        <button
          className="rounded bg-accent/20 px-3 py-1 text-sm text-accent"
          onClick={async () => {
            if (!narrativeTitle.trim()) return;
            await adminFetch("/api/sectors/narratives", { method: "POST", body: JSON.stringify({ title: narrativeTitle, description: narrativeDesc }) });
            setNarrativeTitle("");
            setNarrativeDesc("");
            await load();
          }}
        >
          Add Narrative
        </button>
        <div className="mt-3 flex flex-wrap gap-2">
          {narratives.map((n) => (
            <span key={n.id} className="rounded bg-slate-800/70 px-2 py-1 text-xs text-slate-300">
              {n.title}
            </span>
          ))}
        </div>
      </div>

      <div className="card p-4">
        <h3 className="mb-3 text-base font-semibold">Add Sector Event</h3>
        <div className="grid gap-2 md:grid-cols-3">
          <input className="rounded border border-borderSoft bg-panelSoft px-2 py-1" placeholder="Sector (e.g. Semiconductors)" value={sectorName} onChange={(e) => setSectorName(e.target.value)} />
          <input type="date" className="rounded border border-borderSoft bg-panelSoft px-2 py-1" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
          <input type="number" className="rounded border border-borderSoft bg-panelSoft px-2 py-1" placeholder="Trend score" value={trendScore} onChange={(e) => setTrendScore(Number(e.target.value))} />
          <select className="rounded border border-borderSoft bg-panelSoft px-2 py-1 md:col-span-3" value={narrativeId} onChange={(e) => setNarrativeId(e.target.value)}>
            <option value="">No Narrative</option>
            {narratives.map((n) => (
              <option key={n.id} value={n.id}>
                {n.title}
              </option>
            ))}
          </select>
          <textarea className="rounded border border-borderSoft bg-panelSoft px-2 py-1 md:col-span-3" placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <select
            multiple
            className="min-h-32 rounded border border-borderSoft bg-panelSoft px-2 py-1 md:col-span-3"
            value={selectedTickers}
            onChange={(e) => {
              const values = Array.from(e.target.selectedOptions).map((o) => o.value);
              setSelectedTickers(values);
            }}
          >
            {symbolOptions.map((s) => (
              <option key={s.ticker} value={s.ticker}>
                {s.ticker} - {s.name}
              </option>
            ))}
          </select>
        </div>
        <button
          className="mt-3 rounded bg-accent/20 px-3 py-1 text-sm text-accent"
          onClick={async () => {
            if (!sectorName.trim() || !eventDate) return;
            await adminFetch("/api/sectors/entries", {
              method: "POST",
              body: JSON.stringify({
                sectorName: sectorName.trim(),
                eventDate,
                trendScore,
                notes,
                narrativeId: narrativeId || null,
                symbols: selectedTickers,
              }),
            });
            setNotes("");
            setSelectedTickers([]);
            await load();
          }}
        >
          Add Sector Event
        </button>
      </div>

      {view === "list" ? (
        <div className="card p-4">
          <h3 className="mb-2 text-base font-semibold">Tracked Sector Events</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900/60">
                <tr>
                  {["Date", "Sector", "Trend", "Narrative", "Symbols", "Notes"].map((h) => (
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
                    <td className="px-3 py-2 text-slate-300">{e.narrativeTitle ?? "-"}</td>
                    <td className="px-3 py-2 text-slate-300">{e.symbols.map((s) => s.ticker).join(", ") || "-"}</td>
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
            <h3 className="text-base font-semibold">Sector Calendar</h3>
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
                      <div key={it.id} className={`rounded px-1 py-0.5 text-[10px] ${pctCls(it.trendScore)}`}>
                        {it.sectorName}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
