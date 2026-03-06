import { GroupPanel } from "@/components/group-panel";
import { StatusBar } from "@/components/status-bar";
import { ManualRefreshButton } from "@/components/manual-refresh-button";
import { getDashboard, getStatus } from "@/lib/api";

export const revalidate = 0;

export default async function HomePage() {
  const [status, dashboard] = await Promise.allSettled([getStatus(), getDashboard()]);
  const statusValue =
    status.status === "fulfilled"
      ? status.value
      : {
          timezone: "Australia/Melbourne",
          autoRefreshLabel: "08:15 Australia/Melbourne",
          autoRefreshLocalTime: "08:15",
          lastUpdated: null,
          asOfDate: null,
          providerLabel: "Alpaca (IEX Delayed Daily Bars)",
        };
  const dashboardValue = dashboard.status === "fulfilled" ? dashboard.value : null;
  const focusedSections = (dashboardValue?.sections ?? []).filter((s) => s.title.includes("Macro") || s.title.includes("Equities"));
  const sectionAnchorId = (sectionId: string) => `overview-section-${sectionId}`;

  return (
    <div className="space-y-4">
      <StatusBar
        asOfDate={statusValue.asOfDate}
        lastUpdated={statusValue.lastUpdated}
        timezone={statusValue.timezone}
        autoRefreshLabel={statusValue.autoRefreshLabel}
        providerLabel={statusValue.providerLabel}
      />
      <div className="flex justify-end">
        <ManualRefreshButton page="overview" />
      </div>
      {focusedSections.length > 0 && (
        <div className="card p-3">
          <div className="flex flex-wrap gap-2">
            {focusedSections.map((section) => (
              <a
                key={`overview-jump-${section.id}`}
                className="rounded bg-slate-800 px-3 py-1.5 text-sm text-slate-300 hover:bg-accent/20 hover:text-accent"
                href={`#${sectionAnchorId(section.id)}`}
              >
                {section.title.replace(/^\d+\s*/, "")}
              </a>
            ))}
          </div>
        </div>
      )}
      {!dashboardValue && (
        <div className="card p-4 text-sm text-red-300">Overview data is temporarily unavailable. Try refreshing from Admin.</div>
      )}
      <div className="grid gap-4">
        {focusedSections.map((section) => (
          <section key={section.id} id={sectionAnchorId(section.id)} className="space-y-3">
            {(() => {
              const groups = [...section.groups];
              const thematic = groups.find((group) => group.title === "Thematic ETFs") ?? null;
              const sector = groups.find((group) => group.title === "Sector ETFs") ?? null;
              const sectorEq = groups.find((group) => group.title === "Sector ETFs (Equal Weight)") ?? null;
              const base = groups.filter((group) => group !== thematic && group !== sector && group !== sectorEq);
              return (
                <>
                  {base.map((group) => (
                    <GroupPanel
                      key={group.id}
                      title={group.title}
                      rows={group.rows}
                      columns={group.columns}
                      defaultOpen
                      pinTop10={group.pinTop10}
                    />
                  ))}
                  {(sector || sectorEq) && (
                    <div className="grid gap-3 lg:grid-cols-2">
                      {sector && (
                        <GroupPanel
                          key={sector.id}
                          title={sector.title}
                          rows={sector.rows}
                          columns={sector.columns}
                          defaultOpen
                          pinTop10={sector.pinTop10}
                        />
                      )}
                      {sectorEq && (
                        <GroupPanel
                          key={sectorEq.id}
                          title={sectorEq.title}
                          rows={sectorEq.rows}
                          columns={sectorEq.columns}
                          defaultOpen
                          pinTop10={sectorEq.pinTop10}
                        />
                      )}
                    </div>
                  )}
                  {thematic && (
                    <GroupPanel
                      key={thematic.id}
                      title={thematic.title}
                      rows={thematic.rows}
                      columns={thematic.columns}
                      defaultOpen
                      pinTop10={thematic.pinTop10}
                    />
                  )}
                </>
              );
            })()}
          </section>
        ))}
      </div>
      <p className="text-xs text-slate-400">Research dashboard only. Not investment advice.</p>
    </div>
  );
}
