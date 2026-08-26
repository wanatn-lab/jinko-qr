import { redis } from "./_redis.js";

// Seed — matches what was already live before this migration.
const SEED_SETTINGS = { tableCount: 20, shopName: "จิ๊นโค", paperWidthMm: 80, printers: [] };

export default async function handler(req, res) {
  if (req.method === "GET") {
    let settings = await redis.get("settings");
    if (!settings) {
      settings = SEED_SETTINGS;
      await redis.set("settings", settings);
    }
    return res.status(200).json({ ...SEED_SETTINGS, ...settings });
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const current = (await redis.get("settings")) || SEED_SETTINGS;
    const merged = { ...current, ...body };
    await redis.set("settings", merged);
    return res.status(200).json({ ok: true, settings: merged });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method not allowed");
}
