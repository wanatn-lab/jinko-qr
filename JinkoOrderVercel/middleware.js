import { next } from "@vercel/functions";
import {
  expiredSessionCookies,
  sessionCookies,
  sessionFromCookieHeader,
} from "./api/_auth.js";

function loginRedirect(request) {
  const requestUrl = new URL(request.url);
  const loginUrl = new URL("/login", requestUrl);
  loginUrl.searchParams.set("next", `${requestUrl.pathname}${requestUrl.search}`);

  const response = new Response(null, {
    status: 307,
    headers: { Location: loginUrl.toString() },
  });
  expiredSessionCookies().forEach((cookie) => response.headers.append("Set-Cookie", cookie));
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export default async function middleware(request) {
  try {
    const result = await sessionFromCookieHeader(request.headers.get("cookie") || "");
    if (!result) return loginRedirect(request);

    const response = next();
    response.headers.set("Cache-Control", "private, no-store");
    if (result.session) {
      sessionCookies(result.session).forEach((cookie) => response.headers.append("Set-Cookie", cookie));
    }
    return response;
  } catch (error) {
    console.error("routing auth failed", error);
    return loginRedirect(request);
  }
}

export const config = {
  matcher: [
    "/admin",
    "/admin.html",
    "/table-status",
    "/table-status.html",
    "/counter-print",
    "/counter-print.html",
  ],
};
