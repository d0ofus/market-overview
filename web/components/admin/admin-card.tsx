"use client";

import { clsx } from "clsx";
import type { ReactNode } from "react";

type Props = {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
};

export function AdminCard({ title, description, actions, children, className, bodyClassName }: Props) {
  return (
    <section className={clsx("admin-surface", className)}>
      {title || description || actions ? (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-borderSoft/70 px-5 py-4">
          <div className="space-y-1">
            {title ? <h3 className="text-base font-semibold text-text">{title}</h3> : null}
            {description ? <p className="max-w-3xl text-sm text-slate-400">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={clsx("px-5 py-5", bodyClassName)}>{children}</div>
    </section>
  );
}
