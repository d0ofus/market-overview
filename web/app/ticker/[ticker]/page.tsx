import { getTicker } from "@/lib/api";
import { Sparkline } from "@/components/sparkline";
import { TradingViewWidget } from "@/components/tradingview-widget";

export default async function TickerPage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  const data = await getTicker(ticker.toUpperCase());
  const prices = data.series.map((s) => s.c);
  const latest = prices[prices.length - 1] ?? 0;
  const prev = prices[prices.length - 2] ?? latest;
  const change = prev ? ((latest - prev) / prev) * 100 : 0;
  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h2 className="text-2xl font-semibold">
          {data.symbol.ticker} <span className="text-base text-slate-400">{data.symbol.name}</span>
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          Last close: {latest.toFixed(2)} ({change.toFixed(2)}%)
        </p>
        <div className="mt-3">
          <Sparkline values={prices.slice(-120)} width={360} height={80} />
        </div>
      </div>
      {data.tradingViewEnabled && <TradingViewWidget ticker={data.symbol.ticker} />}
    </div>
  );
}
