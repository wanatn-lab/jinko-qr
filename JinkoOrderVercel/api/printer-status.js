import { redis } from "./_redis.js";

// The print agent (running on the shop's own computer) POSTs here every poll
// cycle with a fresh connectivity check for each configured printer. The
// admin page's "เครื่องพิมพ์ครัว" tab GETs this to show live status dots.
export default async function handler(req, res) {
  if (req.method === "POST") {
    const body = req.body || {};
    const payload = {
      updatedAt: new Date().toISOString(),
      printers: Array.isArray(body.printers) ? body.printers : [],
    };
    await redis.set("printer-status", payload);
    return res.status(200).json({ ok: true });
  }

  if (req.method === "GET") {
    const status = (await redis.get("printer-status")) || { updatedAt: null, printers: [] };
    return res.status(200).json(status);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method not allowed");
}
