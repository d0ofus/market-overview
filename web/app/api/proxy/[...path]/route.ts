import { NextRequest } from "next/server";

const WORKER_BASE = process.env.NEXT_PUBLIC_API_BASE ?? process.env.API_BASE ?? "http://127.0.0.1:8787";

async function forward(req: NextRequest, parts: string[]) {
  const path = parts.join("/");
  const query = req.nextUrl.search || "";
  const target = `${WORKER_BASE}/${path}${query}`;
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();

  const headers = new Headers();
  const incomingAuth = req.headers.get("authorization");
  if (incomingAuth) {
    headers.set("authorization", incomingAuth);
  } else {
    const serverSecret = process.env.ADMIN_SECRET ?? process.env.NEXT_PUBLIC_ADMIN_SECRET ?? "";
    if (serverSecret) headers.set("authorization", `Bearer ${serverSecret}`);
  }
  const incomingContentType = req.headers.get("content-type");
  if (incomingContentType) headers.set("content-type", incomingContentType);

  const response = await fetch(target, {
    method: req.method,
    headers,
    body,
    cache: "no-store",
  });

  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
  });
}

export async function GET(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return forward(req, path);
}

export async function POST(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return forward(req, path);
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return forward(req, path);
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return forward(req, path);
}

