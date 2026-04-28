import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/register", "/auth/callback"];

export async function middleware(req: NextRequest) {
  const res = NextResponse.next({ request: { headers: req.headers } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get: (name) => req.cookies.get(name)?.value,
        set: (name, value, options) => res.cookies.set({ name, value, ...options }),
        remove: (name, options) => res.cookies.set({ name, value: "", ...options }),
      },
    }
  );

  const { data: { session } } = await supabase.auth.getSession();
  const { pathname } = req.nextUrl;

  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  if (!session && !isPublic) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (session && (pathname === "/login" || pathname === "/register")) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  return res;
}

export const config = {
  // Only protect page routes. Exclude static assets and all /api/* routes
  // so existing Twilio/IVR API endpoints continue to work without auth headers.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
