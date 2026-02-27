import { GroupPanel } from "@/components/group-panel";
import { StatusBar } from "@/components/status-bar";
import { getDashboard, getStatus } from "@/lib/api";

export const revalidate = 0;

export default async function HomePage() {
  const [status, dashboard] = await Promise.all([getStatus(), getDashboard()]);
  return (
    <div className="space-y-4">
      <StatusBar
        asOfDate={status.asOfDate}
        lastUpdated={status.lastUpdated}
        timezone={status.timezone}
        autoRefreshLabel={status.autoRefreshLabel}
        providerLabel={status.providerLabel}
      />
      <div className="grid gap-4">
        {dashboard.sections
          .filter((s) => s.title.includes("Macro") || s.title.includes("Equities"))
          .map((section) => (
            <section key={section.id} className="space-y-3">
              <div>
                <h2 className="text-xl font-semibold">{section.title}</h2>
                <p className="text-sm text-slate-400">{section.description}</p>
              </div>
              {section.groups.map((group) => (
                <GroupPanel
                  key={group.id}
                  title={group.title}
                  rows={group.rows}
                  columns={group.columns}
                  defaultOpen
                  pinTop10={group.pinTop10}
                />
              ))}
            </section>
          ))}
      </div>
      <p className="text-xs text-slate-400">Research dashboard only. Not investment advice.</p>
    </div>
  );
}
