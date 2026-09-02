import { clearSessionCookies } from "../_auth.js";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  clearSessionCookies(res);
  return res.redirect(303, "/login");
}
