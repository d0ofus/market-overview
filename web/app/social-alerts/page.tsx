import { SocialAlertsDashboard } from "@/components/social-alerts-dashboard";

export default function SocialAlertsPage() {
  return (
    <div className="space-y-5">
      <div className="card px-5 py-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-3xl">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">Internal X Scanner</div>
            <h2 className="mt-1 text-2xl font-semibold text-slate-100">Social Alerts</h2>
            <p className="mt-1 text-sm text-slate-400">
              Scrape saved public X handles with Scweet, extract cashtags, and review tradeable ticker ideas in table or multi-chart mode.
            </p>
          </div>
          <div className="rounded-full border border-borderSoft/70 bg-panelSoft/50 px-3 py-1.5 text-xs font-medium text-slate-300">
            Scweet on demand
          </div>
        </div>
      </div>
      <SocialAlertsDashboard />
    </div>
  );
}
