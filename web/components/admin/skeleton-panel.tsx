"use client";

import { clsx } from "clsx";

type Props = {
  lines?: number;
  className?: string;
};

export function SkeletonPanel({ lines = 4, className }: Props) {
  return (
    <div className={clsx("admin-surface px-5 py-5", className)}>
      <div className="space-y-3 animate-pulse">
        <div className="h-5 w-40 rounded bg-panelSoft/80" />
        {Array.from({ length: lines }).map((_, index) => (
          <div key={index} className="h-10 rounded-xl bg-panelSoft/65" />
        ))}
      </div>
    </div>
  );
}
