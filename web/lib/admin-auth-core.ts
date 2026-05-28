import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ADMIN_SESSION_COOKIE_NAME = "market_admin_session";
export const ADMIN_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

type AdminSessionPayload = {
  v: 1;
  iat: number;
  exp: number;
  nonce: string;
};

export type AdminSessionVerification =
  | { valid: true; payload: AdminSessionPayload }
  | { valid: false; reason: "missing" | "malformed" | "signature" | "expired" };

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function signSessionPayload(encodedPayload: string, sessionSecret: string): string {
  return createHmac("sha256", sessionSecret).update(encodedPayload).digest("base64url");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function verifyAdminPassword(candidatePassword: string, expectedPassword: string): boolean {
  if (!candidatePassword || !expectedPassword) return false;
  return constantTimeEqual(candidatePassword, expectedPassword);
}

export function createAdminSessionValue(
  sessionSecret: string,
  options: { now?: number; maxAgeSeconds?: number; nonce?: string } = {},
): string {
  if (!sessionSecret) throw new Error("Admin session secret is required.");

  const now = options.now ?? Date.now();
  const maxAgeSeconds = options.maxAgeSeconds ?? ADMIN_SESSION_MAX_AGE_SECONDS;
  const payload: AdminSessionPayload = {
    v: 1,
    iat: now,
    exp: now + maxAgeSeconds * 1000,
    nonce: options.nonce ?? randomBytes(18).toString("base64url"),
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return `${encodedPayload}.${signSessionPayload(encodedPayload, sessionSecret)}`;
}

export function verifyAdminSessionValue(
  sessionValue: string | null | undefined,
  sessionSecret: string,
  now = Date.now(),
): AdminSessionVerification {
  if (!sessionValue || !sessionSecret) return { valid: false, reason: "missing" };

  const parts = sessionValue.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { valid: false, reason: "malformed" };

  const [encodedPayload, signature] = parts;
  const expectedSignature = signSessionPayload(encodedPayload, sessionSecret);
  if (!constantTimeEqual(signature, expectedSignature)) return { valid: false, reason: "signature" };

  const decodedPayload = base64UrlDecode(encodedPayload);
  if (!decodedPayload) return { valid: false, reason: "malformed" };

  let payload: AdminSessionPayload;
  try {
    payload = JSON.parse(decodedPayload) as AdminSessionPayload;
  } catch {
    return { valid: false, reason: "malformed" };
  }

  if (
    payload.v !== 1 ||
    !Number.isFinite(payload.iat) ||
    !Number.isFinite(payload.exp) ||
    typeof payload.nonce !== "string" ||
    !payload.nonce
  ) {
    return { valid: false, reason: "malformed" };
  }

  if (payload.exp <= now) return { valid: false, reason: "expired" };

  return { valid: true, payload };
}

export function readCookieValue(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName !== name) continue;
    const value = rawValue.join("=");
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}
