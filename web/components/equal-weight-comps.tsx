"use client";

import { TradingViewWidget } from "./tradingview-widget";

const pairs = [
  { title: "SPY vs RSP", base: "AMEX:SPY", compare: "AMEX:RSP" },
  { title: "QQQ vs QQQE", base: "NASDAQ:QQQ", compare: "NASDAQ:QQQE" },
  { title: "IWM (Russell 2000) vs EQAL (Russell 1000 equal weight)", base: "AMEX:IWM", compare: "AMEX:EQAL" },
];

export function EqualWeightComps() {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold">Equal-weight Comps</h3>
        <p className="text-sm text-slate-400">Independent TradingView chart comparisons. SPY/RSP and QQQ/QQQE share index universes; IWM/EQAL compare different market-cap universes. Chart timing and adjustments can differ from the dated EOD tables.</p>
      </div>
      <div className="space-y-4">
        {pairs.map((pair) => (
          <div key={pair.title} className="card p-3">
            <div className="mb-2 text-sm font-medium text-slate-200">{pair.title}</div>
            <TradingViewWidget ticker={pair.base} compareSymbol={pair.compare} compact />
          </div>
        ))}
      </div>
    </div>
  );
}
