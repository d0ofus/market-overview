"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import { ADMIN_NAV_ITEMS } from "./admin-nav";

export function AdminSubnav() {
  const pathname = usePathname();

  return (
    <div className="sticky top-4 z-20">
      <nav className="admin-surface overflow-x-auto px-3 py-3 backdrop-blur-xl">
        <div className="flex min-w-max gap-2">
          {ADMIN_NAV_ITEMS.map((item) => {
            const active = pathname === item.href || (item.href !== "/admin" && pathname.startsWith(item.href));

            return (
              <Link
                key={item.href}
                href={item.href}
                className={clsx(
                  "rounded-2xl px-4 py-2 text-sm font-medium transition",
                  active
                    ? "bg-accent text-slate-950 shadow-lg shadow-accent/20"
                    : "text-slate-300 hover:bg-panelSoft/70 hover:text-text",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
