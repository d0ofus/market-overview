import type { Metadata } from "next";
import { AdminShell } from "@/components/admin/admin-shell";
import { AdminLoginScreen } from "@/components/admin/admin-login-screen";
import { getAdminSessionStatus } from "@/lib/admin-auth";

export const metadata: Metadata = {
  title: "Admin",
};

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const auth = await getAdminSessionStatus();
  if (!auth.configured || !auth.authenticated) {
    return <AdminLoginScreen missing={auth.missing} />;
  }

  return <AdminShell>{children}</AdminShell>;
}
