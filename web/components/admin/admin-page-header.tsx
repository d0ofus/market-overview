"use client";

import type { ReactNode } from "react";
import { AdminToolbar } from "./admin-toolbar";

type Props = {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
};

export function AdminPageHeader({ eyebrow, title, description, actions }: Props) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2">
        {eyebrow ? <p className="text-xs font-semibold uppercase tracking-[0.28em] text-accent/80">{eyebrow}</p> : null}
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight text-text sm:text-3xl">{title}</h2>
          <p className="max-w-3xl text-sm text-slate-400 sm:text-base">{description}</p>
        </div>
      </div>
      {actions ? <AdminToolbar className="justify-end">{actions}</AdminToolbar> : null}
    </div>
  );
}
