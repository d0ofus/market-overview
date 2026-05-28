import { SectorTracker } from "@/components/sector-tracker";
import { OverviewRefreshMenu } from "@/components/overview-refresh-menu";
import { getStatus } from "@/lib/api";

export default async function SectorPage() {
  const status = await getStatus("sectors").catch(() => ({
    timezone: "Australia/Melbourne",
    autoRefreshLabel: "08:15 Australia/Melbourne",
    autoRefreshLocalTime: "08:15",
    lastUpdated: null,
    asOfDate: null,
    providerLabel: "Alpaca (IEX Delayed Daily Bars)",
  }));

  return (
    <div className="space-y-4">
      <SectorTracker
        navActions={(
          <OverviewRefreshMenu
            status={{
              asOfDate: status.asOfDate,
              lastUpdated: status.lastUpdated,
              timezone: status.timezone,
              autoRefreshLabel: status.autoRefreshLabel,
              providerLabel: status.providerLabel,
            }}
            refreshPage="sectors"
          />
        )}
      />
    </div>
  );
}
