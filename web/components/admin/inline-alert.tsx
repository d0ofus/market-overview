"use client";

import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from "lucide-react";
import { clsx } from "clsx";
import type { ReactNode } from "react";

type Props = {
  tone?: "info" | "success" | "warning" | "danger";
  title?: string;
  children: ReactNode;
  className?: string;
};

const toneMap = {
  info: {
    className: "border-sky-400/20 bg-sky-500/10 text-sky-100",
    icon: Info,
  },
  success: {
    className: "border-emerald-400/20 bg-emerald-500/10 text-emerald-100",
    icon: CheckCircle2,
  },
  warning: {
    className: "border-amber-400/20 bg-amber-500/10 text-amber-100",
    icon: AlertTriangle,
  },
  danger: {
    className: "border-rose-400/20 bg-rose-500/10 text-rose-100",
    icon: OctagonAlert,
  },
} as const;

export function InlineAlert({ tone = "info", title, children, className }: Props) {
  const Icon = toneMap[tone].icon;
  return (
    <div className={clsx("flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm", toneMap[tone].className, className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}
