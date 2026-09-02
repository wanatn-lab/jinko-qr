import { setSessionCookies, signInWithPassword } from "../_auth.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const email = String(req.body?.email || "").trim();
  const password = String(req.body?.password || "");
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: "กรุณากรอกอีเมลและรหัสผ่าน" });
  }

  try {
    const session = await signInWithPassword(email, password);
    if (!session) {
      return res.status(401).json({ ok: false, error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
    }

    setSessionCookies(res, session);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("login failed", error);
    return res.status(500).json({ ok: false, error: "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่" });
  }
}
