import { NextRequest } from "next/server";

const RAW_API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "https://coolfix-omni-api.onrender.com/api";
const API_BASE = RAW_API_BASE.replace(/\/$/, "").endsWith("/api")
  ? RAW_API_BASE.replace(/\/$/, "")
  : `${RAW_API_BASE.replace(/\/$/, "")}/api`;

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

async function proxy(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  const target = new URL(`${API_BASE}/${path.join("/")}`);
  target.search = request.nextUrl.search;

  const init: RequestInit = {
    method: request.method,
    headers: {
      "Content-Type": request.headers.get("Content-Type") ?? "application/json",
    },
    cache: "no-store",
  };

  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = await request.text();
  }

  const response = await fetch(target, init);
  const contentType = response.headers.get("Content-Type") ?? "application/json";
  return new Response(await response.text(), {
    status: response.status,
    headers: { "Content-Type": contentType },
  });
}

export function GET(request: NextRequest, context: RouteContext) {
  return proxy(request, context);
}

export function POST(request: NextRequest, context: RouteContext) {
  return proxy(request, context);
}

export function PATCH(request: NextRequest, context: RouteContext) {
  return proxy(request, context);
}

export function DELETE(request: NextRequest, context: RouteContext) {
  return proxy(request, context);
}
