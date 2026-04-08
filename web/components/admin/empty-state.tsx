"use client";

import type { ReactNode } from "react";

type Props = {
  title: string;
  description: string;
  action?: ReactNode;
};

export function EmptyState({ title, description, action }: Props) {
  return (
    <div className="rounded-2xl border border-dashed border-borderSoft/80 bg-panelSoft/35 px-5 py-8 text-center">
      <div className="mx-auto max-w-md space-y-2">
        <h3 className="text-base font-semibold text-text">{title}</h3>
        <p className="text-sm text-slate-400">{description}</p>
        {action ? <div className="pt-2">{action}</div> : null}
      </div>
    </div>
  );
}
