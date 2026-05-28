"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ADMIN_SESSION_COOKIE_NAME,
  createAdminSessionValue,
  verifyAdminPassword,
} from "@/lib/admin-auth-core";
import {
  adminSessionCookieOptions,
  getAdminAuthConfig,
} from "@/lib/admin-auth";

export type AdminLoginState = {
  error: string | null;
};

function adminRedirectPath(value: FormDataEntryValue | null): string {
  if (typeof value !== "string") return "/admin";
  const path = value.trim();
  if (path === "/admin" || path.startsWith("/admin/")) return path;
  return "/admin";
}

export async function loginAdmin(_state: AdminLoginState, formData: FormData): Promise<AdminLoginState> {
  const config = getAdminAuthConfig();
  if (!config.configured) {
    return {
      error: `Admin login is missing server environment variables: ${config.missing.join(", ")}.`,
    };
  }

  const password = formData.get("password");
  if (typeof password !== "string" || !verifyAdminPassword(password, config.password)) {
    return { error: "Incorrect admin password." };
  }

  const cookieStore = await cookies();
  cookieStore.set(
    ADMIN_SESSION_COOKIE_NAME,
    createAdminSessionValue(config.sessionSecret),
    adminSessionCookieOptions(),
  );

  redirect(adminRedirectPath(formData.get("redirectTo")));
}

export async function logoutAdmin(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_SESSION_COOKIE_NAME, "", {
    ...adminSessionCookieOptions(0),
    expires: new Date(0),
  });

  redirect("/admin");
}
