import { redis as defaultRedis } from "./_redis.js";
import { bangkokDay } from "./_kitchen-logic.js";

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function createOrdersHandler({ redis = defaultRedis } = {}) {
  return async function handler(req, res) {
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
    // Is this table already open today (ordered, not yet cleared)? Then this order is
    // an add-on ("สั่งเพิ่ม") to the same table. Extra fields only; nothing existing changes.
    const nowDate = new Date();
    const nowIso = nowDate.toISOString();
    const clears = (await redis.get("tableClears")) || {};
    const clearedAt = clears[body.table] ? new Date(clears[body.table]).getTime() : 0;
    const today = bangkokDay(nowDate);
    const tableIsOpen = orders.some(
      (o) =>
        String(o.table) === String(body.table) &&
        bangkokDay(new Date(o.createdAt)) === today &&
        new Date(o.createdAt).getTime() > clearedAt,
    );
    const orderId = genId();
    // Each item starts life "cooking" for the table-status board; harmless
    // for any caller that doesn't look at kitchenStatus.
    // lineId = stable id of this line, used by the kitchen screen (item index is
    // not stable because admin can remove a line).
    const items = body.items.map((it, index) => ({
      ...it,
      kitchenStatus: it.kitchenStatus || "cooking",
      lineId: `${orderId}-${index}`,
      ...(tableIsOpen ? { isAddOn: true, addedAt: nowIso } : {}),
    }));
    const order = {
      id: orderId,
      table: body.table,
      items,
      note: body.note || "",
      status: "new",
      createdAt: nowIso,
      ...(tableIsOpen ? { isAddOn: true } : {}),
    };
    if (!tableIsOpen) {
      // Running number for the day, shown as the card's "#" on the kitchen screen.
      // A failure here must never block a customer's order, so it is best-effort.
      try {
        const counterKey = `queueNo:${today}`;
        order.queueNo = await redis.incr(counterKey);
        await redis.expire(counterKey, 3 * 24 * 60 * 60);
      } catch (err) {
        console.warn("[orders] queueNo counter failed", err);
      }
    }
    orders.push(order);
    await redis.set("orders", orders.slice(-1000));
    return res.status(200).json({ ok: true, order });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method not allowed");
  };
}

export default createOrdersHandler();
