"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AdminSubnav } from "./admin-subnav";
import { getAdminRouteMeta } from "./admin-nav";

type Props = {
  children: ReactNode;
};

export function AdminShell({ children }: Props) {
  const pathname = usePathname();
  const current = getAdminRouteMeta(pathname);

  return (
    <div className="space-y-6">
      <section className="admin-surface px-6 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.32em] text-accent/80">Admin Workspace</p>
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-tight text-text sm:text-4xl">{current.label}</h1>
              <p className="max-w-3xl text-sm text-slate-400 sm:text-base">{current.description}</p>
            </div>
          </div>
          <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/50 px-4 py-3 text-xs text-slate-400">
            Operational tooling for Market Command Centre.
          </div>
        </div>
      </section>
      <AdminSubnav />
      <div className="space-y-6">{children}</div>
    </div>
  );
}
