import { redis as defaultRedis } from "./_redis.js";
import { bangkokDay } from "./_kitchen-logic.js";
import { updateOrders } from "./_orders-store.js";

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

    // Mark an existing order done (used once the kitchen has served it).
    if (body.action === "done" && body.id) {
      await updateOrders(redis, (orders) => ({
        orders: orders.map((o) => (o.id === body.id ? { ...o, status: "done" } : o)).slice(-1000),
      }));
      return res.status(200).json({ ok: true });
    }

    // New order from a customer.
    if (!body.table || !Array.isArray(body.items) || !body.items.length) {
      return res.status(400).json({ ok: false, error: "missing table or items" });
    }
    const nowDate = new Date();
    const nowIso = nowDate.toISOString();
    const today = bangkokDay(nowDate);
    const clears = (await redis.get("tableClears")) || {};
    const clearedAt = clears[body.table] ? new Date(clears[body.table]).getTime() : 0;
    const orderId = genId();
    let queueNo; // allocated at most once, even if the write has to be retried

    const order = await updateOrders(redis, async (orders) => {
      // Is this table already open today (ordered, not yet cleared)? Then this order is
      // an add-on ("สั่งเพิ่ม") to the same table. Extra fields only; nothing existing changes.
      const tableIsOpen = orders.some(
        (o) =>
          String(o.table) === String(body.table) &&
          bangkokDay(new Date(o.createdAt)) === today &&
          new Date(o.createdAt).getTime() > clearedAt,
      );
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
      const next = {
        id: orderId,
        table: body.table,
        items,
        note: body.note || "",
        status: "new",
        createdAt: nowIso,
        ...(tableIsOpen ? { isAddOn: true } : {}),
      };
      if (!tableIsOpen) {
        if (queueNo === undefined) {
          // Running number for the day, shown as the card's "#" on the kitchen screen.
          // Best-effort: a failure here must never block a customer's order.
          try {
            const counterKey = `queueNo:${today}`;
            queueNo = await redis.incr(counterKey);
            await redis.expire(counterKey, 3 * 24 * 60 * 60);
          } catch (err) {
            console.warn("[orders] queueNo counter failed", err);
            queueNo = null;
          }
        }
        if (queueNo != null) next.queueNo = queueNo;
      }
      return { orders: [...orders, next].slice(-1000), result: next };
    });
    return res.status(200).json({ ok: true, order });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method not allowed");
  };
}

export default createOrdersHandler();
