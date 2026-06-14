import { cookies } from "next/headers";
import {
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_MAX_AGE_SECONDS,
  readCookieValue,
  type AdminSessionVerification,
  verifyAdminSessionValue,
} from "./admin-auth-core";

type AdminAuthConfig = {
  configured: boolean;
  password: string;
  sessionSecret: string;
  missing: string[];
};

type AdminWorkerConfig = {
  configured: boolean;
  apiBase: string;
  adminSecret: string;
  missing: string[];
};

type AdminSessionFailureReason = Extract<AdminSessionVerification, { valid: false }>["reason"];

type AdminRequestAuthentication =
  | { configured: false; authenticated: false; missing: string[] }
  | { configured: true; authenticated: true }
  | { configured: true; authenticated: false; reason: AdminSessionFailureReason };

export function getAdminAuthConfig(env: NodeJS.ProcessEnv = process.env): AdminAuthConfig {
  const password = String(env.ADMIN_PASSWORD ?? "");
  const sessionSecret = String(env.ADMIN_SESSION_SECRET ?? "");
  const missing = [
    password ? null : "ADMIN_PASSWORD",
    sessionSecret ? null : "ADMIN_SESSION_SECRET",
  ].filter((value): value is string => Boolean(value));

  return {
    configured: missing.length === 0,
    password,
    sessionSecret,
    missing,
  };
}

export function getAdminWorkerConfig(env: NodeJS.ProcessEnv = process.env): AdminWorkerConfig {
  const apiBase = String(env.WORKER_API_BASE ?? env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8787");
  const adminSecret = String(env.ADMIN_SECRET ?? "");
  const missing = adminSecret ? [] : ["ADMIN_SECRET"];

  return {
    configured: missing.length === 0,
    apiBase,
    adminSecret,
    missing,
  };
}

export function adminSessionCookieOptions(maxAge = ADMIN_SESSION_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

export async function getAdminSessionStatus(): Promise<{
  configured: boolean;
  authenticated: boolean;
  missing: string[];
}> {
  const config = getAdminAuthConfig();
  if (!config.configured) {
    return { configured: false, authenticated: false, missing: config.missing };
  }

  const cookieStore = await cookies();
  const sessionValue = cookieStore.get(ADMIN_SESSION_COOKIE_NAME)?.value ?? null;
  const verification = verifyAdminSessionValue(sessionValue, config.sessionSecret);
  return {
    configured: true,
    authenticated: verification.valid,
    missing: [],
  };
}

export function isAdminRequestAuthenticated(request: Request): boolean {
  return verifyAdminRequestAuthentication(request).authenticated;
}

export function verifyAdminRequestAuthentication(request: Request): AdminRequestAuthentication {
  const config = getAdminAuthConfig();
  if (!config.configured) {
    return { configured: false, authenticated: false, missing: config.missing };
  }

  const sessionValue = readCookieValue(request.headers.get("cookie"), ADMIN_SESSION_COOKIE_NAME);
  const verification = verifyAdminSessionValue(sessionValue, config.sessionSecret);
  if (verification.valid) return { configured: true, authenticated: true };
  return { configured: true, authenticated: false, reason: verification.reason };
}
