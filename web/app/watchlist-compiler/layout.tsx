import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Watchlist Compiler",
};

export default function WatchlistCompilerLayout({ children }: { children: React.ReactNode }) {
  return children;
}
