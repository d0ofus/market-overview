import { AdminLoginScreen } from "@/components/admin/admin-login-screen";
import { OptionsDashboard } from "@/components/options-dashboard";
import { getAdminSessionStatus } from "@/lib/admin-auth";

type OptionsPageProps = {
  searchParams?: Promise<{
    setId?: string;
    runId?: string;
  }>;
};

export default async function OptionsPage({ searchParams }: OptionsPageProps) {
  const params = await searchParams;
  const initialSetId = typeof params?.setId === "string" ? params.setId : null;
  const initialRunId = typeof params?.runId === "string" ? params.runId : null;
  const redirectParams = new URLSearchParams();
  if (initialSetId) redirectParams.set("setId", initialSetId);
  if (initialRunId) redirectParams.set("runId", initialRunId);
  const redirectTo = redirectParams.toString() ? `/options?${redirectParams.toString()}` : "/options";

  const auth = await getAdminSessionStatus();
  if (!auth.configured || !auth.authenticated) {
    return <AdminLoginScreen missing={auth.missing} redirectTo={redirectTo} />;
  }

  return (
    <div className="space-y-5">
      <div className="card px-5 py-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-3xl">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">Options Workflow</div>
            <h2 className="mt-1 text-2xl font-semibold text-slate-100">Options Decision Support</h2>
            <p className="mt-1 text-sm text-slate-400">
              Discover listed options from the current TradingView watchlist, rank liquid contracts and debit spreads, and audit RTH bid/ask spread quality through the private IBKR bridge.
            </p>
          </div>
          <div className="rounded-full border border-borderSoft/70 bg-panelSoft/50 px-3 py-1.5 text-xs font-medium text-slate-300">
            IBKR bridge primary
          </div>
        </div>
      </div>
      <OptionsDashboard initialSetId={initialSetId} initialRunId={initialRunId} />
    </div>
  );
}
