import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sector Tracker",
};

export default function SectorsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
