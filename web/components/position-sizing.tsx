"use client";

import { useMemo, useState } from "react";

function calc(account: number, riskPct: number, entry: number, stop: number) {
  const maxRisk = account * (riskPct / 100);
  const riskPerShare = Math.abs(entry - stop);
  const shares = riskPerShare > 0 ? Math.floor(maxRisk / riskPerShare) : 0;
  const value = shares * entry;
  const equityUsed = account > 0 ? (value / account) * 100 : 0;
  return { maxRisk, riskPerShare, shares, value, equityUsed };
}

export function PositionSizing() {
  const [side, setSide] = useState<"long" | "short">("long");
  const [account, setAccount] = useState(100000);
  const [riskPct, setRiskPct] = useState(1);
  const [entry, setEntry] = useState(100);
  const [stop, setStop] = useState(95);

  const out = useMemo(() => calc(account, riskPct, entry, stop), [account, riskPct, entry, stop]);

  const stagger = useMemo(() => {
    const span = Math.abs(entry - stop);
    return [0.5, 0.75, 1].map((f) => {
      const s = side === "long" ? entry - span * f : entry + span * f;
      return { level: f, stop: s, shares: Math.floor(out.maxRisk / Math.abs(entry - s || 1)) };
    });
  }, [entry, stop, side, out.maxRisk]);

  return (
    <div className="card p-4">
      <h2 className="mb-4 text-lg font-semibold">Risk-Based Position Sizing</h2>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
        <input className="rounded border border-borderSoft bg-panelSoft p-2" value={account} onChange={(e) => setAccount(Number(e.target.value))} />
        <input className="rounded border border-borderSoft bg-panelSoft p-2" value={riskPct} onChange={(e) => setRiskPct(Number(e.target.value))} />
        <input className="rounded border border-borderSoft bg-panelSoft p-2" value={entry} onChange={(e) => setEntry(Number(e.target.value))} />
        <input className="rounded border border-borderSoft bg-panelSoft p-2" value={stop} onChange={(e) => setStop(Number(e.target.value))} />
        <select className="rounded border border-borderSoft bg-panelSoft p-2" value={side} onChange={(e) => setSide(e.target.value as "long" | "short")}>
          <option value="long">Long</option>
          <option value="short">Short</option>
        </select>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-5">
        <div className="card p-3">Shares: {out.shares}</div>
        <div className="card p-3">Max risk $: {out.maxRisk.toFixed(2)}</div>
        <div className="card p-3">Risk/share: {out.riskPerShare.toFixed(2)}</div>
        <div className="card p-3">Position value: {out.value.toFixed(2)}</div>
        <div className="card p-3">% Equity: {out.equityUsed.toFixed(2)}%</div>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-300">
              <th>Stop tier</th>
              <th>Stop price</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {stagger.map((s) => (
              <tr key={s.level} className="border-t border-borderSoft">
                <td>{Math.round(s.level * 100)}%</td>
                <td>{s.stop.toFixed(2)}</td>
                <td>{s.shares}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-slate-400">Educational use only. Validate fills, liquidity, and slippage before live orders.</p>
    </div>
  );
}
