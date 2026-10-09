import assert from "node:assert/strict";
import { test } from "node:test";

process.env.KV_REST_API_URL ||= "https://example.invalid";
process.env.KV_REST_API_TOKEN ||= "test-token";

const { createKitchenHandler } = await import("../api/kitchen.js");
const { createOrdersHandler } = await import("../api/orders.js");

function fakeRedis() {
  const kv = new Map();
  const hashes = new Map();
  const h = (k) => hashes.get(k) || hashes.set(k, {}).get(k);
  return {
    async get(k) { return structuredClone(kv.get(k)); },
    async set(k, v) { kv.set(k, structuredClone(v)); },
    async incr(k) { const n = (kv.get(k) || 0) + 1; kv.set(k, n); return n; },
    async expire() {},
    // minimal emulation of the two Lua scripts used by api/_orders-store.js
    async eval(script, keys, args) {
      const k = keys[0];
      if (script.includes("return 'X'")) { const v = kv.get(k); return v === undefined ? false : "X" + JSON.stringify(v); }
      const cur = kv.get(k);
      const curRaw = cur === undefined ? undefined : JSON.stringify(cur);
      if ((curRaw === undefined && args[0] === "") || curRaw === args[0]) { kv.set(k, JSON.parse(args[1])); return 1; }
      return 0;
    },
    async hgetall(k) { const v = hashes.get(k); return v ? structuredClone(v) : null; },
    async hset(k, o) { Object.assign(h(k), structuredClone(o)); },
    async hdel(k, f) { delete h(k)[f]; },
  };
}
function call(handler, method, body) {
  return new Promise((resolve) => {
    const res = {
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      json(b) { resolve({ code: this.code, body: b }); },
      end() { resolve({ code: this.code }); },
    };
    handler({ method, body }, res);
  });
}
const NOW = new Date("2026-10-09T05:00:00Z"); // 12:00 Bangkok
const fixed = () => NOW;
function setup() {
  const redis = fakeRedis();
  return {
    redis,
    orders: createOrdersHandler({ redis }),
    kitchen: createKitchenHandler({ redis, now: fixed }),
  };
}
const food = { id: "m1", name: "กะเพรา", price: 59, category: "จานหลัก", qty: 1 };
const drink = { id: "m3", name: "ชาเย็น", price: 35, category: "เครื่องดื่ม", qty: 2 };

test("first order gets queueNo, second order for open table is an add-on", async () => {
  const { orders, redis } = setup();
  const a = await call(orders, "POST", { table: 7, items: [food] });
  const b = await call(orders, "POST", { table: 7, items: [food] });
  const c = await call(orders, "POST", { table: 8, items: [food] });
  assert.equal(a.body.order.queueNo, 1);
  assert.equal(a.body.order.isAddOn, undefined);
  assert.equal(b.body.order.isAddOn, true);
  assert.equal(b.body.order.queueNo, undefined);
  assert.equal(b.body.order.items[0].isAddOn, true);
  assert.equal(c.body.order.queueNo, 2);
  assert.match(a.body.order.items[0].lineId, /-0$/);
  assert.equal(a.body.order.items[0].kitchenStatus, "cooking"); // existing field kept
});

test("after the table is cleared, the next order is not an add-on", async () => {
  const { orders, redis } = setup();
  await call(orders, "POST", { table: 7, items: [food] });
  await redis.set("tableClears", { 7: new Date(Date.now() + 1000).toISOString() });
  const n = await call(orders, "POST", { table: 7, items: [food] });
  assert.equal(n.body.order.isAddOn, undefined);
});

test("drinks are filtered on the server; drinks-only table is not shown", async () => {
  const { kitchen, redis } = setup();
  const t = NOW.toISOString();
  await redis.set("orders", [
    { id: "o1", table: 1, createdAt: t, queueNo: 1, items: [food, drink] },
    { id: "o2", table: 2, createdAt: t, queueNo: 2, items: [drink] },
  ]);
  const { body } = await call(kitchen, "GET");
  assert.equal(body.cards.length, 1);
  assert.equal(body.cards[0].table, 1);
  assert.equal(body.cards[0].items.length, 1);
  assert.equal(body.cards[0].total, 1);
  assert.equal(body.done.length, 0);
});

test("done count/move only counts shown items; add-on moves card back to pending", async () => {
  const { kitchen, redis } = setup();
  const t = NOW.toISOString();
  await redis.set("orders", [
    { id: "o1", table: 1, createdAt: t, queueNo: 1, items: [{ ...food, lineId: "o1-0" }, { ...drink, lineId: "o1-1" }] },
  ]);
  await call(kitchen, "POST", { action: "item-set", lineIds: ["o1-0"], st: "d" });
  let { body } = await call(kitchen, "GET");
  assert.equal(body.cards.length, 0); // drink is hidden, food done -> finished
  assert.equal(body.done.length, 1);
  const o = await redis.get("orders");
  o.push({ id: "o9", table: 1, createdAt: t, isAddOn: true, items: [{ ...food, lineId: "o9-0", isAddOn: true, addedAt: t }] });
  await redis.set("orders", o);
  ({ body } = await call(kitchen, "GET"));
  assert.equal(body.cards.length, 1);
  assert.equal(body.done.length, 0);
  assert.equal(body.cards[0].items.find((i) => i.lineId === "o9-0").isAddOn, true);
  assert.equal(body.cards[0].doneCount, 1);
});

test("sort: rush -> dragged rank -> longest wait; rank beats wait", async () => {
  const { kitchen, redis } = setup();
  const at = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
  await redis.set("orders", [
    { id: "a", table: 1, createdAt: at(20), items: [food] },
    { id: "b", table: 2, createdAt: at(10), items: [food] },
    { id: "c", table: 3, createdAt: at(5), items: [food] },
    { id: "d", table: 4, createdAt: at(1), items: [food] },
  ]);
  const k = (t) => `${t}|0`;
  let { body } = await call(kitchen, "GET");
  assert.deepEqual(body.cards.map((c) => c.table), [1, 2, 3, 4]);
  // drag table 3 first, table 2 second -> rank wins over wait time
  await call(kitchen, "POST", { action: "reorder", keys: [k(3), k(2)] });
  ({ body } = await call(kitchen, "GET"));
  assert.deepEqual(body.cards.map((c) => c.table), [3, 2, 1, 4]);
  // rush table 4 -> goes first, rank dropped for it
  await call(kitchen, "POST", { action: "rush", key: k(4), rush: true });
  ({ body } = await call(kitchen, "GET"));
  assert.deepEqual(body.cards.map((c) => c.table), [4, 3, 2, 1]);
  assert.equal(body.cards[0].rush, true);
});

test("bad input is rejected", async () => {
  const { kitchen } = setup();
  assert.equal((await call(kitchen, "POST", { action: "item-set", lineIds: [], st: "d" })).code, 400);
  assert.equal((await call(kitchen, "POST", { action: "item-set", lineIds: ["x"], st: "zzz" })).code, 400);
  assert.equal((await call(kitchen, "POST", { action: "nope" })).code, 400);
});

test("simultaneous orders and kitchen writes never erase each other", async () => {
  const { orders, redis } = setup();
  // 10 customers order at the same moment (different tables)
  await Promise.all(Array.from({ length: 10 }, (_, i) => call(orders, "POST", { table: i + 1, items: [food] })));
  const stored = await redis.get("orders");
  assert.equal(stored.length, 10);
  assert.equal(new Set(stored.map((o) => o.queueNo)).size, 10); // unique running numbers
});

test("a write that loses the race is retried on fresh data", async () => {
  const { orders, redis } = setup();
  await call(orders, "POST", { table: 1, items: [food] });
  const realEval = redis.eval.bind(redis);
  let injected = false;
  redis.eval = async (script, keys, args) => {
    // right after the first raw read, a competing order sneaks in
    const out = await realEval(script, keys, args);
    if (!injected && script.includes("return 'X'")) {
      injected = true;
      const cur = await redis.get("orders");
      cur.push({ id: "sneaky", table: 99, createdAt: new Date().toISOString(), items: [food] });
      await redis.set("orders", cur);
    }
    return out;
  };
  const r = await call(orders, "POST", { table: 2, items: [food] });
  assert.equal(r.code, 200);
  const ids = (await redis.get("orders")).map((o) => o.id);
  assert.ok(ids.includes("sneaky"));
  assert.ok(ids.includes(r.body.order.id));
});
