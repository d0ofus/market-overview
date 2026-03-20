import type { Metadata } from "next";

export async function generateMetadata({ params }: { params: Promise<{ ticker: string }> }): Promise<Metadata> {
  const { ticker } = await params;
  return {
    title: `${ticker.toUpperCase()} Ticker`,
  };
}

export default function TickerLayout({ children }: { children: React.ReactNode }) {
  return children;
}
