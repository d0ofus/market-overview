import { LockKeyhole } from "lucide-react";
import { AdminLoginForm } from "./admin-login-form";

type Props = {
  missing?: string[];
  redirectTo?: string;
};

export function AdminLoginScreen({ missing = [], redirectTo }: Props) {
  const configurationError = missing.length > 0
    ? `Missing server environment variables: ${missing.join(", ")}.`
    : null;

  return (
    <div className="flex min-h-[calc(100vh-3rem)] items-center justify-center py-10">
      <section className="admin-surface w-full max-w-md px-6 py-6">
        <div className="mb-6 flex items-start gap-4">
          <div className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-accent/25 bg-accent/15 text-accent">
            <LockKeyhole className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.32em] text-accent/80">Admin Workspace</p>
            <h1 className="text-2xl font-semibold tracking-tight text-text">Admin access</h1>
            <p className="text-sm text-slate-400">Enter the shared admin password to continue.</p>
          </div>
        </div>
        {configurationError ? (
          <p className="mb-4 rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            {configurationError}
          </p>
        ) : null}
        <AdminLoginForm disabled={Boolean(configurationError)} redirectTo={redirectTo} />
      </section>
    </div>
  );
}
