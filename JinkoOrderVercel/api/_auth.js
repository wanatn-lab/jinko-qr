const ACCESS_COOKIE = "__Host-jinko_admin_access";
const REFRESH_COOKIE = "__Host-jinko_admin_refresh";
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60;

function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY");
  }

  return { url: url.replace(/\/$/, ""), key };
}

function parseCookies(cookieHeader = "") {
  return cookieHeader.split(";").reduce((cookies, part) => {
    const separator = part.indexOf("=");
    if (separator === -1) return cookies;

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) return cookies;

    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
    return cookies;
  }, {});
}

function sessionCookie(name, value, maxAge) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export function sessionCookies(session) {
  const accessMaxAge = Math.max(60, Number(session.expires_in) || 3600);
  return [
    sessionCookie(ACCESS_COOKIE, session.access_token, accessMaxAge),
    sessionCookie(REFRESH_COOKIE, session.refresh_token, REFRESH_MAX_AGE),
  ];
}

export function expiredSessionCookies() {
  return [
    sessionCookie(ACCESS_COOKIE, "", 0),
    sessionCookie(REFRESH_COOKIE, "", 0),
  ];
}

export function setSessionCookies(res, session) {
  res.setHeader("Set-Cookie", sessionCookies(session));
}

export function clearSessionCookies(res) {
  res.setHeader("Set-Cookie", expiredSessionCookies());
}

export async function getUser(accessToken) {
  if (!accessToken) return null;

  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });

  if (!response.ok) return null;
  return response.json();
}

export async function refreshSession(refreshToken) {
  if (!refreshToken) return null;

  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: {
      apikey: key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
    cache: "no-store",
  });

  if (!response.ok) return null;
  const session = await response.json();
  if (!session.access_token || !session.refresh_token) return null;
  return session;
}

export async function signInWithPassword(email, password) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });

  if (!response.ok) return null;
  const session = await response.json();
  if (!session.access_token || !session.refresh_token || !session.user) return null;
  return session;
}

export async function sessionFromCookieHeader(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  const accessToken = cookies[ACCESS_COOKIE];
  const refreshToken = cookies[REFRESH_COOKIE];

  const user = await getUser(accessToken);
  if (user) return { user, session: null };

  const session = await refreshSession(refreshToken);
  if (!session) return null;

  return { user: session.user, session };
}

export async function requireAdmin(req, res) {
  try {
    const result = await sessionFromCookieHeader(req.headers.cookie || "");
    if (!result) {
      clearSessionCookies(res);
      res.status(401).json({ ok: false, error: "กรุณาเข้าสู่ระบบ" });
      return null;
    }

    if (result.session) setSessionCookies(res, result.session);
    return result.user;
  } catch (error) {
    console.error("admin auth failed", error);
    res.status(500).json({ ok: false, error: "ตรวจสอบสิทธิ์ไม่สำเร็จ" });
    return null;
  }
}
