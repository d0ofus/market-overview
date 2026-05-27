import { NextResponse } from "next/server";
import {
  browserbaseConfigurationError,
  createBrowserbaseVerificationSession,
} from "@/lib/perplexity-browser-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

function adminSecrets(): string[] {
  return Array.from(new Set([
    process.env.ADMIN_SECRET,
    process.env.NEXT_PUBLIC_ADMIN_SECRET,
  ].map((value) => String(value ?? "").trim()).filter(Boolean)));
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unable to create Browserbase verification session.";
}

export async function POST(request: Request) {
  const secrets = adminSecrets();
  if (secrets.length === 0) {
    return NextResponse.json(
      { error: "Admin secret is not configured for Browserbase verification sessions." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!secrets.includes(bearerToken(request))) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const configError = browserbaseConfigurationError();
  if (configError) {
    return NextResponse.json(
      { error: configError },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const session = await createBrowserbaseVerificationSession();
    return NextResponse.json(
      { ok: true, ...session },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: errorMessage(error) },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
