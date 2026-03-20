import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Gappers",
};

export default function GappersLayout({ children }: { children: React.ReactNode }) {
  return children;
}
