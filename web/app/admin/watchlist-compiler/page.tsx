import type { Metadata } from "next";
import { WatchlistCompilerAdminPanel } from "@/components/watchlist-compiler-admin-panel";

export const metadata: Metadata = {
  title: "Watchlist Compiler Admin",
};

export default function AdminWatchlistCompilerPage() {
  return <WatchlistCompilerAdminPanel />;
}
