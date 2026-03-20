import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "13F Tracker",
};

export default function ThirteenFLayout({ children }: { children: React.ReactNode }) {
  return children;
}
