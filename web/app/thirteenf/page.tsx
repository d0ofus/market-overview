import { get13fManager, get13fOverview } from "@/lib/api";

const money = (n?: number) => {
  if (!n) return "-";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(n);
};

export default async function ThirteenFPage() {
  const overview = await get13fOverview();
  const managers = overview.managers ?? [];
  const details = await Promise.all(
    managers.slice(0, 4).map(async (m: any) => ({
      id: m.id,
      data: await get13fManager(m.id),
    })),
  );

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">13F Tracker</h2>
      <p className="text-sm text-slate-400">
        Top institutional holdings snapshot from recent 13F reports. Use as narrative context, not a timing signal.
      </p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {managers.slice(0, 4).map((m: any) => (
          <div key={m.id} className="card p-4">
            <div className="text-xs uppercase tracking-[0.1em] text-slate-400">{m.reportQuarter ?? "Latest"}</div>
            <div className="mt-1 text-base font-semibold">{m.name}</div>
            <div className="mt-2 text-sm text-slate-300">13F Value: {money(m.totalValueUsd)}</div>
            <div className="text-sm text-slate-300">AUM: {money(m.aumUsd)}</div>
            <div className="text-xs text-slate-500">Filed: {m.filedDate ?? "-"}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {details.map(({ id, data }) => (
          <div key={id} className="card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold">{data.manager.name}</h3>
              <span className="rounded bg-accent/15 px-2 py-1 text-xs text-accent">
                {data.reports[0]?.reportQuarter ?? "Latest"}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-900/60">
                  <tr>
                    {["Ticker", "Issuer", "Weight", "Value"].map((h) => (
                      <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.latestHoldings.slice(0, 10).map((h: any) => (
                    <tr key={h.ticker} className="border-t border-borderSoft/60">
                      <td className="px-3 py-2 font-semibold text-accent">{h.ticker}</td>
                      <td className="px-3 py-2 text-slate-300">{h.issuerName}</td>
                      <td className="px-3 py-2 text-slate-300">{h.weightPct?.toFixed(2)}%</td>
                      <td className="px-3 py-2 text-slate-300">{money(h.valueUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      <div className="card p-4">
        <h3 className="mb-2 text-base font-semibold">Largest Reported Holdings (Cross-Manager)</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/60">
              <tr>
                {["Ticker", "Issuer", "Weight", "Value"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {overview.topHoldings.slice(0, 20).map((h: any, idx: number) => (
                <tr key={`${h.reportId}:${h.ticker}:${idx}`} className="border-t border-borderSoft/60">
                  <td className="px-3 py-2 font-semibold text-accent">{h.ticker}</td>
                  <td className="px-3 py-2 text-slate-300">{h.issuerName}</td>
                  <td className="px-3 py-2 text-slate-300">{h.weightPct?.toFixed(2)}%</td>
                  <td className="px-3 py-2 text-slate-300">{money(h.valueUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
