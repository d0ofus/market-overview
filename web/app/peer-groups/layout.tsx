import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Peer Groups",
};

export default function PeerGroupsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
