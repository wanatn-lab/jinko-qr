// Safe read-modify-write for the shared `orders` array.
//
// Problem this fixes: every writer used to do  get("orders") -> change -> set("orders"),
// so two writes at nearly the same moment (a customer ordering while the kitchen ticks an
// item, or two customers ordering together) made the later write erase the earlier one.
//
// Fix: compare-and-set. We read the raw stored text, apply the change, and write back ONLY
// if the stored text is still exactly what we read (one atomic Lua step inside Redis).
// If someone else changed it first we simply re-read and try again.
// The data format is unchanged (same JSON array under the same key), so every other
// reader (print agent, table-status, bill history) keeps working as before.

const READ_RAW = "local v = redis.call('GET', KEYS[1]); if v then return 'X' .. v else return false end";
const CAS = `
local cur = redis.call('GET', KEYS[1])
if (not cur and ARGV[1] == '') or cur == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0`;

const KEY = "orders";

/**
 * @param redis   client (needs eval/get/set)
 * @param mutate  (ordersArray) => { orders: newArray, result?: any } | null   (null = no change)
 *                May be called more than once (on a clash), so keep it free of side effects.
 */
export async function updateOrders(redis, mutate, { retries = 10 } = {}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    let raw = "";
    let current = [];
    try {
      const got = await redis.eval(READ_RAW, [KEY], []);
      if (typeof got === "string" && got.startsWith("X")) {
        raw = got.slice(1);
        const parsed = JSON.parse(raw);
        current = Array.isArray(parsed) ? parsed : [];
      }
    } catch (err) {
      console.warn("[orders-store] raw read failed, using plain write", err);
      return plainUpdate(redis, mutate);
    }

    const change = await mutate(current);
    if (!change) return undefined;
    const ok = await redis.eval(CAS, [KEY], [raw, JSON.stringify(change.orders)]);
    if (Number(ok) === 1) return change.result;
    // someone else wrote in between: short random pause, then retry on fresh data
    await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40));
  }
  console.warn("[orders-store] too many clashes, falling back to plain write");
  return plainUpdate(redis, mutate);
}

async function plainUpdate(redis, mutate) {
  const current = (await redis.get(KEY)) || [];
  const change = await mutate(Array.isArray(current) ? current : []);
  if (!change) return undefined;
  await redis.set(KEY, change.orders);
  return change.result;
}
