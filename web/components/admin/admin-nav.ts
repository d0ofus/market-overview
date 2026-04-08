export type AdminNavItem = {
  href: string;
  label: string;
  description: string;
};

export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  {
    href: "/admin",
    label: "Operations",
    description: "Refresh actions, schedule controls, and admin health.",
  },
  {
    href: "/admin/overview",
    label: "Overview",
    description: "Dashboard sections, groups, tickers, and ETF universe controls.",
  },
  {
    href: "/admin/peer-groups",
    label: "Peer Groups",
    description: "Group maintenance, symbol directory management, and peer seeding.",
  },
  {
    href: "/admin/watchlist-compiler",
    label: "Watchlist Compiler",
    description: "Saved watchlist sets, source URLs, and compile controls.",
  },
  {
    href: "/admin/research-lab",
    label: "AI Research",
    description: "Research profile, prompt, evidence, synthesis, and version control.",
  },
];

export function getAdminRouteMeta(pathname: string) {
  const exactMatch = ADMIN_NAV_ITEMS.find((item) => item.href === pathname);
  if (exactMatch) return exactMatch;

  const nestedMatch = [...ADMIN_NAV_ITEMS]
    .sort((left, right) => right.href.length - left.href.length)
    .find((item) => item.href !== "/admin" && pathname.startsWith(item.href));

  return nestedMatch ?? ADMIN_NAV_ITEMS[0];
}
