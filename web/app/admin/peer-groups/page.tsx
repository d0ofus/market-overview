import type { Metadata } from "next";
import { PeerGroupsAdminPanel } from "@/components/peer-groups-admin-panel";

export const metadata: Metadata = {
  title: "Peer Groups Admin",
};

export default function AdminPeerGroupsPage() {
  return <PeerGroupsAdminPanel />;
}
