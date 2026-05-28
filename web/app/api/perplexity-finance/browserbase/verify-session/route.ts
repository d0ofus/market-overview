import { NextResponse } from "next/server";
import {
  browserbaseConfigurationError,
  createBrowserbaseVerificationSession,
} from "@/lib/perplexity-browser-provider";
import { isAdminRequestAuthenticated } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unable to create Browserbase verification session.";
}

export async function POST(request: Request) {
  if (!isAdminRequestAuthenticated(request)) {
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
