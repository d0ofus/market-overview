import { NextResponse } from "next/server";
import { getAdminWorkerConfig, verifyAdminRequestAuthentication } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

function workerPathFromParts(parts: string[]): string {
  if (parts[0] === "proxy" && parts[1] === "api") {
    return `/${parts.slice(1).map(encodeURIComponent).join("/")}`;
  }

  return `/api/admin/${parts.map(encodeURIComponent).join("/")}`;
}

function requestHeadersForWorker(request: Request, adminSecret: string): Headers {
  const headers = new Headers();
  const accept = request.headers.get("accept");
  const contentType = request.headers.get("content-type");
  if (accept) headers.set("accept", accept);
  if (contentType) headers.set("content-type", contentType);
  headers.set("authorization", `Bearer ${adminSecret}`);
  return headers;
}

function responseHeadersFromWorker(response: Response): Headers {
  const headers = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");
  return headers;
}

function adminSessionErrorMessage(reason: "missing" | "malformed" | "signature" | "expired"): string {
  if (reason === "expired") {
    return "Admin session expired. Open /admin and log in again from this same site.";
  }
  if (reason === "missing") {
    return "Admin session cookie is missing. Open /admin and log in again from this same site.";
  }
  return "Admin session is invalid. Open /admin and log in again from this same site.";
}

async function proxyAdminRequest(request: Request, context: RouteContext) {
  const auth = verifyAdminRequestAuthentication(request);
  if (!auth.configured) {
    return NextResponse.json(
      { error: `Admin auth is missing server environment variables: ${auth.missing.join(", ")}.` },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!auth.authenticated) {
    return NextResponse.json(
      { error: adminSessionErrorMessage(auth.reason) },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const worker = getAdminWorkerConfig();
  if (!worker.configured) {
    return NextResponse.json(
      { error: `Admin worker proxy is missing server environment variables: ${worker.missing.join(", ")}.` },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { path } = await context.params;
  const requestUrl = new URL(request.url);
  const workerPath = workerPathFromParts(path);
  const upstreamUrl = new URL(`${workerPath}${requestUrl.search}`, worker.apiBase);
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();

  const upstream = await fetch(upstreamUrl, {
    method,
    headers: requestHeadersForWorker(request, worker.adminSecret),
    body,
    cache: "no-store",
    redirect: "manual",
  });

  if (upstream.status === 401 && workerPath.startsWith("/api/admin/")) {
    return NextResponse.json(
      { error: "Worker admin authentication failed. Verify the web ADMIN_SECRET matches the Worker ADMIN_SECRET." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeadersFromWorker(upstream),
  });
}

export const GET = proxyAdminRequest;
export const POST = proxyAdminRequest;
export const PATCH = proxyAdminRequest;
export const PUT = proxyAdminRequest;
export const DELETE = proxyAdminRequest;
export const HEAD = proxyAdminRequest;
