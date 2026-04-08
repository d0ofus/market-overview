import type { Metadata } from "next";
import { OverviewAdminWorkspace } from "@/components/admin/overview-admin-workspace";

export const metadata: Metadata = {
  title: "Overview Admin",
};

export default function AdminOverviewPage() {
  return <OverviewAdminWorkspace />;
}
