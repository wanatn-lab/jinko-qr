import { redis } from "./_redis.js";

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const orders = (await redis.get("orders")) || [];
    // Only hand back the last 24h — the print agent polls this constantly
    // and the admin/customer history views only need recent activity.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = orders.filter((o) => new Date(o.createdAt).getTime() >= cutoff);
    return res.status(200).json(recent);
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const orders = (await redis.get("orders")) || [];

    // Mark an existing order done (used once the kitchen has served it).
    if (body.action === "done" && body.id) {
      const updated = orders.map((o) => (o.id === body.id ? { ...o, status: "done" } : o));
      await redis.set("orders", updated.slice(-1000));
      return res.status(200).json({ ok: true });
    }

    // New order from a customer.
    if (!body.table || !Array.isArray(body.items) || !body.items.length) {
      return res.status(400).json({ ok: false, error: "missing table or items" });
    }
    // Each item starts life "cooking" for the table-status board; harmless
    // for any caller that doesn't look at kitchenStatus.
    const items = body.items.map((it) => ({
      ...it,
      kitchenStatus: it.kitchenStatus || "cooking",
    }));
    const order = {
      id: genId(),
      table: body.table,
      items,
      note: body.note || "",
      status: "new",
      createdAt: new Date().toISOString(),
    };
    orders.push(order);
    await redis.set("orders", orders.slice(-1000));
    return res.status(200).json({ ok: true, order });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method not allowed");
}
