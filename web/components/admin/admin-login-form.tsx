"use client";

import { useActionState } from "react";
import { usePathname } from "next/navigation";
import { LogIn } from "lucide-react";
import { loginAdmin, type AdminLoginState } from "@/app/admin/actions";

const initialState: AdminLoginState = {
  error: null,
};

type Props = {
  disabled?: boolean;
  redirectTo?: string;
};

function defaultRedirectPath(pathname: string | null): string {
  if (pathname === "/research-lab") return pathname;
  if (pathname === "/admin" || pathname?.startsWith("/admin/")) return pathname;
  return "/admin";
}

export function AdminLoginForm({ disabled = false, redirectTo }: Props) {
  const pathname = usePathname();
  const nextPath = redirectTo ?? defaultRedirectPath(pathname);
  const [state, formAction, pending] = useActionState(loginAdmin, initialState);
  const formDisabled = disabled || pending;

  return (
    <form action={formAction} className="space-y-4">
      <input name="redirectTo" type="hidden" value={nextPath} />
      <div className="space-y-2">
        <label className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400" htmlFor="admin-password">
          Password
        </label>
        <input
          autoComplete="current-password"
          autoFocus
          className="h-12 w-full rounded-2xl border border-borderSoft/80 bg-panelSoft/70 px-4 text-base text-text outline-none transition placeholder:text-slate-500 focus:border-accent/70 focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={formDisabled}
          id="admin-password"
          name="password"
          placeholder="Admin password"
          type="password"
        />
      </div>
      {state.error ? (
        <p className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <button
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-accent px-4 text-sm font-semibold text-slate-950 shadow-lg shadow-accent/20 transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={formDisabled}
        type="submit"
      >
        <LogIn className="h-4 w-4" aria-hidden="true" />
        {pending ? "Unlocking..." : "Unlock admin"}
      </button>
    </form>
  );
}
