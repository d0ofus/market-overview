"use client";

import { clsx } from "clsx";
import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  className?: string;
};

export function AdminToolbar({ children, className }: Props) {
  return (
    <div className={clsx("flex flex-wrap items-center gap-3", className)}>
      {children}
    </div>
  );
}
