import { AdminLoginScreen } from "@/components/admin/admin-login-screen";
import { ResearchLabDashboard } from "@/components/research-lab-dashboard";
import { getAdminSessionStatus } from "@/lib/admin-auth";

export default async function ResearchLabPage() {
  const auth = await getAdminSessionStatus();
  if (!auth.configured || !auth.authenticated) {
    return <AdminLoginScreen missing={auth.missing} redirectTo="/research-lab" />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Research Lab</h2>
        <p className="text-sm text-slate-400">
          Test the new isolated stock research flow with live per-ticker logging, persisted evidence artifacts, and strict no-fallback synthesis.
        </p>
      </div>
      <ResearchLabDashboard />
    </div>
  );
}
