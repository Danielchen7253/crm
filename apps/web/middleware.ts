import { NextResponse, type NextRequest } from "next/server";

const mobileUserAgent = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i;

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname !== "/") return NextResponse.next();

  const userAgent = request.headers.get("user-agent") ?? "";
  if (!mobileUserAgent.test(userAgent)) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/mobile/inbox";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: "/",
};
