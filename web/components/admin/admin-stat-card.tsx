"use client";

import { clsx } from "clsx";

type Props = {
  label: string;
  value: string | number;
  helper?: string;
  tone?: "default" | "success" | "warning" | "danger" | "info";
};

const toneClassName: Record<NonNullable<Props["tone"]>, string> = {
  default: "border-borderSoft/70 bg-panelSoft/55",
  success: "border-emerald-400/20 bg-emerald-500/10",
  warning: "border-amber-400/20 bg-amber-500/10",
  danger: "border-rose-400/20 bg-rose-500/10",
  info: "border-sky-400/20 bg-sky-500/10",
};

export function AdminStatCard({ label, value, helper, tone = "default" }: Props) {
  return (
    <div className={clsx("rounded-2xl border px-4 py-4", toneClassName[tone])}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-text">{value}</p>
      {helper ? <p className="mt-2 text-xs text-slate-400">{helper}</p> : null}
    </div>
  );
}
