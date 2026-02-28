import { GroupPanel } from "@/components/group-panel";
import { StatusBar } from "@/components/status-bar";
import { getDashboard, getStatus } from "@/lib/api";

export const revalidate = 0;

export default async function HomePage() {
  const [status, dashboard] = await Promise.all([getStatus(), getDashboard()]);
  const focusedSections = dashboard.sections.filter((s) => s.title.includes("Macro") || s.title.includes("Equities"));
  return (
    <div className="space-y-4">
      <StatusBar
        asOfDate={status.asOfDate}
        lastUpdated={status.lastUpdated}
        timezone={status.timezone}
        autoRefreshLabel={status.autoRefreshLabel}
        providerLabel={status.providerLabel}
      />
      <div className="grid gap-3 md:grid-cols-2">
        {focusedSections.map((section) => (
          <div key={section.id} className="card p-4">
            <div className="text-xs uppercase tracking-[0.16em] text-accent">{section.title.slice(0, 2)}</div>
            <h2 className="mt-2 text-xl font-semibold">{section.title.replace(/^\d+\s*/, "")}</h2>
            <p className="mt-1 text-sm text-slate-400">{section.description}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-4">
        {focusedSections.map((section) => (
          <section key={section.id} className="space-y-3">
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
