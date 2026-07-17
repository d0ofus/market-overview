"use client";

import { useEffect, useMemo, useState } from "react";
import { getPeerDirectory, type SectorFocusNarrative, type SectorFocusNarrativeUpdate } from "@/lib/api";
import {
  buildFocusTickerOptions,
  normalizeFocusTickers,
  parseFocusTickerInput,
  previewFocusName,
} from "@/lib/sector-focus-entry";

type SourceOption = {
  id: string;
  name: string;
  tickers: Array<{ ticker: string; name: string | null }>;
};

type Props = {
  entry?: SectorFocusNarrative | null;
  narratives: SourceOption[];
  peerGroups: SourceOption[];
  saving: boolean;
  error?: string | null;
  onCancel: () => void;
  onSave: (value: SectorFocusNarrativeUpdate) => void | Promise<void>;
};

export function SectorFocusEntryForm({ entry, narratives, peerGroups, saving, error, onCancel, onSave }: Props) {
  const [sourceNarrativeName, setSourceNarrativeName] = useState(entry?.sourceNarrativeName ?? "");
  const [sourcePeerGroupId, setSourcePeerGroupId] = useState(entry?.sourcePeerGroupId ?? "");
  const [manualName, setManualName] = useState(entry?.manualName ?? "");
  const [comment, setComment] = useState(entry?.comment ?? "");
  const [manualTickerInput, setManualTickerInput] = useState("");
  const [manualTickers, setManualTickers] = useState<string[]>(entry?.selectedTickers.map((row) => row.ticker) ?? []);
  const [selectedTickers, setSelectedTickers] = useState<string[]>(entry?.selectedTickers.map((row) => row.ticker) ?? []);
  const [peerTickers, setPeerTickers] = useState<Array<{ ticker: string; name: string | null }>>([]);
  const [peerTickersLoading, setPeerTickersLoading] = useState(false);
  const [peerTickersError, setPeerTickersError] = useState<string | null>(null);

  const narrative = narratives.find((row) => row.id === sourceNarrativeName) ?? null;
  const peerGroupBase = peerGroups.find((row) => row.id === sourcePeerGroupId) ?? null;
  const peerGroup = peerGroupBase ? { ...peerGroupBase, tickers: peerTickers } : null;

  useEffect(() => {
    if (!sourcePeerGroupId) {
      setPeerTickers([]);
      setPeerTickersError(null);
      setPeerTickersLoading(false);
      return;
    }
    let cancelled = false;
    setPeerTickers([]);
    setPeerTickersLoading(true);
    setPeerTickersError(null);
    void (async () => {
      const values: Array<{ ticker: string; name: string | null }> = [];
      const seen = new Set<string>();
      let offset = 0;
      let total = 0;
      do {
        const response = await getPeerDirectory({ groupId: sourcePeerGroupId, limit: 100, offset });
        if (cancelled) return;
        for (const row of response.rows ?? []) {
          const ticker = row.ticker.trim().toUpperCase();
          if (!ticker || seen.has(ticker)) continue;
          seen.add(ticker);
          values.push({ ticker, name: row.name ?? null });
        }
        const responseLimit = Math.max(1, Number(response.limit ?? 100));
        total = Number(response.total ?? 0);
        offset += responseLimit;
        if ((response.rows ?? []).length === 0) break;
      } while (offset < total);
      values.sort((left, right) => left.ticker.localeCompare(right.ticker));
      if (!cancelled) setPeerTickers(values);
    })().catch((loadError) => {
      if (!cancelled) setPeerTickersError(loadError instanceof Error ? loadError.message : "Failed to load peer-group tickers.");
    }).finally(() => {
      if (!cancelled) setPeerTickersLoading(false);
    });
    return () => { cancelled = true; };
  }, [sourcePeerGroupId]);
  const options = useMemo(() => buildFocusTickerOptions({
    narrativeTickers: narrative?.tickers ?? [],
    peerGroupTickers: peerGroup?.tickers ?? [],
    manualTickers: normalizeFocusTickers([...manualTickers, ...selectedTickers]),
  }), [manualTickers, narrative, peerGroup, selectedTickers]);
  const preview = useMemo(() => previewFocusName({
    sourceNarrativeName: narrative?.name ?? null,
    narrativeTickers: narrative?.tickers.map((row) => row.ticker) ?? [],
    sourcePeerGroupName: peerGroup?.name ?? null,
    peerGroupTickers: peerGroup?.tickers.map((row) => row.ticker) ?? [],
    selectedTickers,
    manualName,
  }), [manualName, narrative, peerGroup, selectedTickers]);

  const toggleTicker = (ticker: string) => {
    setSelectedTickers((current) => current.includes(ticker)
      ? current.filter((value) => value !== ticker)
      : [...current, ticker]);
  };
  const addManualTickers = () => {
    const values = parseFocusTickerInput(manualTickerInput);
    if (values.length === 0) return;
    setManualTickers((current) => normalizeFocusTickers([...current, ...values]));
    setSelectedTickers((current) => normalizeFocusTickers([...current, ...values]));
    setManualTickerInput("");
  };
  const selectAllSuggestions = () => {
    setSelectedTickers(normalizeFocusTickers(options.map((row) => row.ticker)));
  };

  const submit = async () => {
    if (!preview.valid || selectedTickers.length === 0) return;
    await onSave({
      id: entry?.id,
      sectorName: preview.displayName,
      sourceNarrativeName: sourceNarrativeName || null,
      sourcePeerGroupId: sourcePeerGroupId || null,
      manualName: manualName.trim() || null,
      selectedTickers: normalizeFocusTickers(selectedTickers),
      comment: comment.trim(),
    });
  };

  return (
    <div className="rounded-2xl border border-cyan-400/30 bg-cyan-950/10 p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-cyan-100">{entry ? "Edit Focus Now entry" : "Add Focus Now entry"}</h4>
          <p className="mt-1 text-xs text-slate-400">Choose either source or both, then select only the tickers you want. Suggestions are not selected automatically.</p>
        </div>
        <button type="button" onClick={onCancel} className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-slate-500">Cancel</button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-xs text-slate-300">
          Existing narrative
          <select
            value={sourceNarrativeName}
            onChange={(event) => setSourceNarrativeName(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          >
            <option value="">None</option>
            {narratives.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-300">
          Existing peer group
          <select
            value={sourcePeerGroupId}
            onChange={(event) => setSourcePeerGroupId(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          >
            <option value="">None</option>
            {peerGroups.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </select>
        </label>
      </div>

      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Ticker selection ({selectedTickers.length})</div>
          <div className="flex gap-2">
            <button type="button" onClick={selectAllSuggestions} disabled={options.length === 0} className="text-xs text-cyan-300 disabled:text-slate-600">Select all shown</button>
            <button type="button" onClick={() => setSelectedTickers([])} disabled={selectedTickers.length === 0} className="text-xs text-slate-400 disabled:text-slate-700">Clear</button>
          </div>
        </div>
        {peerTickersLoading ? <p className="mt-3 text-xs text-slate-400">Loading peer-group tickers…</p> : null}
        {peerTickersError ? <p className="mt-3 text-xs text-rose-300">{peerTickersError}</p> : null}
        {options.length > 0 ? (
          <div className="mt-3 flex max-h-56 flex-wrap gap-2 overflow-y-auto">
            {options.map((row) => {
              const selected = selectedTickers.includes(row.ticker);
              return (
                <button
                  type="button"
                  key={row.ticker}
                  onClick={() => toggleTicker(row.ticker)}
                  className={`rounded-lg border px-2.5 py-1.5 text-left text-xs ${selected ? "border-cyan-400 bg-cyan-500/15 text-cyan-100" : "border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500"}`}
                >
                  <span className="font-semibold">{row.ticker}</span>
                  {row.name && row.name !== row.ticker ? <span className="ml-1 text-slate-500">{row.name}</span> : null}
                  <span className="ml-2 text-[9px] uppercase tracking-wide text-slate-500">
                    {row.inNarrative && row.inPeerGroup ? "Both" : row.inPeerGroup ? "Peer" : row.inNarrative ? "Narrative" : "Manual"}
                  </span>
                </button>
              );
            })}
          </div>
        ) : <p className="mt-3 text-xs text-slate-500">Choose a source or add tickers manually.</p>}
        <div className="mt-3 flex gap-2">
          <input
            value={manualTickerInput}
            onChange={(event) => setManualTickerInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addManualTickers();
              }
            }}
            placeholder="Add tickers: NVDA, VRT, AVGO"
            className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
          />
          <button type="button" onClick={addManualTickers} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-cyan-500/50">Add</button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="text-xs text-slate-300">
          Manual entry name {preview.manualNameRequired ? <span className="text-amber-300">(required)</span> : <span className="text-slate-600">(only for mixed/custom sets)</span>}
          <input value={manualName} onChange={(event) => setManualName(event.target.value)} maxLength={120} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
        </label>
        <label className="text-xs text-slate-300">
          Saved name
          <div className={`mt-1 rounded-lg border px-3 py-2 text-sm ${preview.valid ? "border-emerald-500/30 bg-emerald-950/20 text-emerald-200" : "border-slate-700 bg-slate-950 text-slate-500"}`}>
            {preview.displayName || (selectedTickers.length === 0 ? "Select at least one ticker" : "Enter a manual name")}
          </div>
        </label>
      </div>
      <label className="mt-3 block text-xs text-slate-300">
        Comment
        <textarea value={comment} onChange={(event) => setComment(event.target.value)} maxLength={1000} rows={3} className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
      </label>
      {error ? <p className="mt-3 text-xs text-rose-300">{error}</p> : null}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving || !preview.valid || selectedTickers.length === 0}
          className="rounded-lg border border-cyan-400/40 bg-cyan-500/15 px-4 py-2 text-sm font-semibold text-cyan-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Saving…" : entry ? "Save changes" : "Add entry"}
        </button>
      </div>
    </div>
  );
}
