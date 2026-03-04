"use client";

import { TradingViewWidget } from "./tradingview-widget";

const pairs = [
  { title: "SPY vs RSP", base: "AMEX:SPY", compare: "AMEX:RSP" },
  { title: "QQQ vs QQQE", base: "NASDAQ:QQQ", compare: "NASDAQ:QQQE" },
  { title: "IWM vs EQAL", base: "AMEX:IWM", compare: "AMEX:EQAL" },
];

export function EqualWeightComps() {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold">Equal-weight Comps</h3>
        <p className="text-sm text-slate-400">Vertical chart comparisons with equal-weight companions for breadth confirmation.</p>
      </div>
      <div className="space-y-4">
        {pairs.map((pair) => (
          <div key={pair.title} className="card p-3">
            <div className="mb-2 text-sm font-medium text-slate-200">{pair.title}</div>
            <TradingViewWidget ticker={pair.base} compareSymbol={pair.compare} compact initialRange="12M" />
          </div>
        ))}
      </div>
    </div>
  );
}
