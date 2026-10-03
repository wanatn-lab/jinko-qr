import { redis } from "./_redis.js";

const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BILLS = 1000;
const MAX_PRINT_JOBS = 300;

function isCancelled(bill) {
  return Boolean(bill && (bill.cancelledAt || bill.status === "cancelled"));
}

function summaryFor(history) {
  const cancelledBills = history.filter(isCancelled);
  const validBills = history.filter((bill) => !isCancelled(bill));
  return {
    allBills: history.length,
    validBills: validBills.length,
    cancelledBills: cancelledBills.length,
    validTotal: validBills.reduce((sum, bill) => sum + (Number(bill.total) || 0), 0),
  };
}

function recentBills(value, now = Date.now()) {
  const earliest = now - HISTORY_WINDOW_MS;
  return (Array.isArray(value) ? value : [])
    .filter((bill) => bill && bill.id && new Date(bill.createdAt).getTime() >= earliest)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, MAX_BILLS);
}

function safeBill(bill) {
  const items = Array.isArray(bill.items) ? bill.items.map((item) => ({
    name: String(item.name || "รายการ"),
    qty: Math.max(1, Number(item.qty) || 1),
    price: Number(item.price) || 0,
    lineTotal: Number.isFinite(Number(item.lineTotal))
      ? Number(item.lineTotal)
      : (Number(item.price) || 0) * Math.max(1, Number(item.qty) || 1),
  })) : [];
  return {
    id: String(bill.id),
    billNo: String(bill.billNo || bill.id),
    table: String(bill.table || "-"),
    createdAt: bill.createdAt,
    settledAt: bill.settledAt || bill.createdAt,
    shopName: String(bill.shopName || "จิ๊นโค"),
    phone: String(bill.phone || "085-529-8799"),
    total: Number(bill.total) || 0,
    cancelled: isCancelled(bill),
    cancelledAt: bill.cancelledAt || null,
    items,
  };
}

export default async function handler(req, res) {
  const now = Date.now();
  const history = recentBills(await redis.get("billHistory"), now);

  if (req.method === "GET") {
    return res.status(200).json({
      days: 7,
      bills: history.map(safeBill),
      summary: summaryFor(history),
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).end("Method not allowed");
  }

  const body = req.body || {};
  if (!body.action || !body.id) {
    return res.status(400).json({ ok: false, error: "unknown action" });
  }

  const bill = history.find((entry) => entry.id === body.id);
  if (!bill) return res.status(404).json({ ok: false, error: "bill not found" });

  if (body.action === "cancel") {
    if (isCancelled(bill)) {
      return res.status(200).json({
        ok: true,
        alreadyCancelled: true,
        bill: safeBill(bill),
        summary: summaryFor(history),
      });
    }

    const cancelledAt = new Date(now).toISOString();
    bill.status = "cancelled";
    bill.cancelledAt = cancelledAt;

    // A queued receipt must not print after its bill was voided. A print that
    // has already completed cannot be physically recalled, but it remains
    // clearly marked cancelled in the bill record for reconciliation.
    const storedJobs = await redis.get("printJobs");
    const jobs = Array.isArray(storedJobs) ? storedJobs : [];
    jobs.forEach((job) => {
      const belongsToBill = job && job.type === "receipt" &&
        (job.id === bill.id || job.reprintOf === bill.id);
      if (belongsToBill && job.status !== "printed") {
        job.status = "cancelled";
        job.cancelledAt = cancelledAt;
      }
    });

    await Promise.all([
      redis.set("billHistory", recentBills(history, now)),
      redis.set("printJobs", jobs.slice(-MAX_PRINT_JOBS)),
    ]);
    return res.status(200).json({
      ok: true,
      bill: safeBill(bill),
      summary: summaryFor(history),
    });
  }

  if (body.action !== "reprint") {
    return res.status(400).json({ ok: false, error: "unknown action" });
  }

  if (isCancelled(bill)) {
    return res.status(409).json({ ok: false, error: "bill is cancelled" });
  }
  if (!Array.isArray(bill.items) || bill.items.length === 0) {
    return res.status(409).json({ ok: false, error: "bill has no items" });
  }

  const storedJobs = await redis.get("printJobs");
  const jobs = Array.isArray(storedJobs) ? storedJobs : [];
  const existing = jobs.find((job) =>
    job && job.type === "receipt" && job.reprintOf === bill.id && job.status !== "printed" &&
    new Date(job.queuedAt || job.createdAt).getTime() > now - 2 * 60 * 1000,
  );
  if (existing) {
    return res.status(200).json({ ok: true, receiptJobId: existing.id, alreadyQueued: true });
  }

  const receiptJob = {
    ...bill,
    id: `reprint-${bill.id}-${now}`,
    type: "receipt",
    status: "queued",
    reprintOf: bill.id,
    queuedAt: new Date(now).toISOString(),
  };
  jobs.push(receiptJob);
  await Promise.all([
    redis.set("billHistory", history.slice(0, MAX_BILLS)),
    redis.set("printJobs", jobs.slice(-MAX_PRINT_JOBS)),
  ]);
  return res.status(200).json({ ok: true, receiptJobId: receiptJob.id });
}
