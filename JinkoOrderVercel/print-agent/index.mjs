import net from 'net';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderTicket, renderTicketToPngBuffer } from './lib/render.mjs';
import { initPrinter, feed, cutPaper, rasterToEscPos } from './lib/escpos.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');
const PRINTED_PATH = path.join(__dirname, 'printed.json');

const TEST_MODE = process.argv.includes('--test');

function loadLocalConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function loadPrinted() {
  try {
    return new Set(JSON.parse(fs.readFileSync(PRINTED_PATH, 'utf8')));
  } catch {
    return new Set();
  }
}

function savePrinted(set) {
  // Keep the file from growing forever — only the most recent 500 ids matter.
  const arr = [...set].slice(-500);
  fs.writeFileSync(PRINTED_PATH, JSON.stringify(arr));
}

// Printer list / paper size / shop name are normally set from the admin
// website's "เครื่องพิมพ์ครัว" tab (stored via /api/settings) so the owner
// never has to touch this file. Values in config.json are only used as a
// fallback if that fetch fails (e.g. no internet at the moment).
async function fetchRemoteSettings(apiBase) {
  const res = await fetch(apiBase.replace(/\/$/, '') + '/api/settings');
  if (!res.ok) throw new Error(`GET /api/settings -> HTTP ${res.status}`);
  return res.json();
}

function mergeConfig(localConfig, remote) {
  const merged = { ...localConfig };
  if (remote) {
    if (Array.isArray(remote.printers) && remote.printers.length) merged.printers = remote.printers;
    if (remote.paperWidthMm) merged.paperWidthMm = remote.paperWidthMm;
    if (remote.shopName) merged.shopName = remote.shopName;
  }
  return merged;
}

// Split one order's items across the configured printers, based on each
// printer's `categories` list. A printer with an empty categories list is
// a "catch-all" — it receives any item whose category isn't specifically
// claimed by another printer. Returns [{ printer, items }] — printers that
// end up with zero matching items are left out (no blank tickets).
export function routeOrderToPrinters(order, printers) {
  const specific = printers.filter((p) => Array.isArray(p.categories) && p.categories.length > 0);
  const catchAll = printers.filter((p) => !Array.isArray(p.categories) || p.categories.length === 0);

  const buckets = new Map(printers.map((p) => [p.id || p.ip, []]));
  const leftovers = [];

  for (const item of order.items || []) {
    const cat = (item.category || '').trim();
    const match = cat ? specific.find((p) => p.categories.includes(cat)) : null;
    if (match) {
      buckets.get(match.id || match.ip).push(item);
    } else {
      leftovers.push(item);
    }
  }

  if (leftovers.length) {
    if (catchAll.length) {
      for (const p of catchAll) {
        buckets.get(p.id || p.ip).push(...leftovers);
      }
    } else if (printers.length) {
      // No catch-all configured — don't silently drop items, print them
      // on the first configured printer instead and note it in the log.
      console.warn(
        `[warn] order ${order.id}: ${leftovers.length} item(s) don't match any printer's ` +
        `category list and no catch-all printer is set — sending them to "${printers[0].name}" instead.`
      );
      buckets.get(printers[0].id || printers[0].ip).push(...leftovers);
    }
  }

  return printers
    .map((p) => ({ printer: p, items: buckets.get(p.id || p.ip) || [] }))
    .filter((entry) => entry.items.length > 0);
}

// Quick TCP reachability probe for one printer — opens a connection and
// closes it immediately without sending any print data. Used to report a
// live "connected / not connected" status to the admin website, separate
// from actually printing a ticket.
function checkPrinterConnectivity(printer) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve({
        id: printer.id || printer.ip,
        name: printer.name,
        ip: printer.ip,
        port: printer.port || 9100,
        ok,
        error: error || null,
        latencyMs: Date.now() - startedAt,
      });
    };
    const socket = net.createConnection({ host: printer.ip, port: printer.port || 9100 });
    socket.setTimeout(3000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timed out'));
    socket.once('error', (err) => finish(false, err.message));
  });
}

// Check every configured printer's connectivity and report the results to
// the admin website so the "เครื่องพิมพ์ครัว" tab can show a live
// connected/not-connected status. Never throws — a failed report just means
// the admin page won't show freshness this cycle, it doesn't stop printing.
const lastStatusLog = new Map();
async function reportPrinterStatus(apiBase, printers) {
  const results = await Promise.all(printers.map(checkPrinterConnectivity));
  for (const r of results) {
    const prev = lastStatusLog.get(r.ip);
    if (prev !== r.ok) {
      console.log(r.ok
        ? `[printer] ✅ เชื่อมต่อ "${r.name}" (${r.ip}:${r.port}) ได้แล้ว`
        : `[printer] ❌ เชื่อมต่อ "${r.name}" (${r.ip}:${r.port}) ไม่ได้ — ${r.error}`);
      lastStatusLog.set(r.ip, r.ok);
    }
  }
  try {
    await fetch(apiBase.replace(/\/$/, '') + '/api/printer-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printers: results }),
    });
  } catch (err) {
    console.warn('[warn] could not report printer status to the website (status just won\'t show as fresh there):', err.message);
  }
  return results;
}

function sendToPrinter(buffer, printer) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: printer.ip, port: printer.port || 9100 }, () => {
      socket.write(buffer, (err) => {
        if (err) return reject(err);
        socket.end();
      });
    });
    socket.setTimeout(8000);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('printer connection timed out — check the IP/port and that it is powered on'));
    });
    socket.on('error', reject);
    socket.on('close', () => resolve());
  });
}

async function printToStation(order, items, printer, config, showStationLabel) {
  const ticketOrder = { ...order, items, stationName: showStationLabel ? printer.name : null };
  const ticketConfig = { paperWidthMm: config.paperWidthMm, shopName: config.shopName };
  const { bitmap, width, height } = renderTicket(ticketOrder, ticketConfig);
  const raster = rasterToEscPos(bitmap, width, height);
  const payload = Buffer.concat([initPrinter(), raster, feed(3), cutPaper()]);

  if (TEST_MODE) {
    const outDir = path.join(__dirname, 'test-output');
    fs.mkdirSync(outDir, { recursive: true });
    const png = await renderTicketToPngBuffer(ticketOrder, ticketConfig);
    const safeName = (printer.name || 'printer').replace(/[^a-zA-Z0-9ก-๙_-]/g, '_');
    const file = path.join(outDir, `order-${order.id}-${safeName}.png`);
    fs.writeFileSync(file, png);
    console.log(`[test] saved preview -> ${file} (no printer contacted)`);
    return;
  }

  await sendToPrinter(payload, printer);
  console.log(`[print] โต๊ะ ${order.table} — order ${order.id} -> "${printer.name}" (${printer.ip}:${printer.port || 9100})`);
}

async function printOrder(order, config) {
  const printers = Array.isArray(config.printers) ? config.printers : [];
  if (!printers.length) {
    throw new Error('No printers configured. Add one in the admin website (แท็บ "เครื่องพิมพ์ครัว").');
  }

  const routed = routeOrderToPrinters(order, printers);
  const showStationLabel = printers.length > 1;

  // Print to each station; if one station fails (e.g. offline), still try
  // the others, then report the failure so this order gets retried later.
  const errors = [];
  for (const { printer, items } of routed) {
    try {
      await printToStation(order, items, printer, config, showStationLabel);
    } catch (err) {
      errors.push(`${printer.name} (${printer.ip}): ${err.message}`);
    }
  }
  if (errors.length) throw new Error(errors.join(' | '));
}

async function pollOnce(localConfig, printed) {
  let config = localConfig;
  try {
    const remote = await fetchRemoteSettings(localConfig.apiBase);
    config = mergeConfig(localConfig, remote);
  } catch (err) {
    console.warn('[warn] could not fetch printer settings from the website (using config.json values instead):', err.message);
  }

  const printers = Array.isArray(config.printers) ? config.printers.filter((p) => p.ip) : [];
  if (!TEST_MODE && !printers.length) {
    throw new Error(
      'No printer set yet. Add one in the admin website (แท็บ "เครื่องพิมพ์ครัว") ' +
      'or edit printers in config.json.'
    );
  }
  config = { ...config, printers };

  if (!TEST_MODE && printers.length) {
    // Fire-and-forget — don't let a status report delay/break order polling.
    reportPrinterStatus(config.apiBase, printers).catch(() => {});
  }

  const res = await fetch(config.apiBase.replace(/\/$/, '') + '/api/orders');
  if (!res.ok) throw new Error(`GET /api/orders -> HTTP ${res.status}`);
  const orders = await res.json();

  const toPrint = orders.filter((o) => o.status !== 'done' && !printed.has(o.id));
  for (const order of toPrint) {
    try {
      await printOrder(order, config);
      printed.add(order.id);
      savePrinted(printed);
    } catch (err) {
      console.error(`[error] failed to print order ${order.id} (โต๊ะ ${order.table}):`, err.message);
      console.error('        will retry on the next poll.');
    }
  }
  return toPrint.length;
}

async function main() {
  const localConfig = loadLocalConfig();
  const printed = loadPrinted();

  console.log('== Kitchen print agent ==');
  console.log('API:', localConfig.apiBase);
  console.log(TEST_MODE
    ? 'Mode: TEST — tickets are saved as PNG files in ./test-output, nothing is sent to a printer.'
    : 'Mode: LIVE — printer list / paper size are read from the admin website each cycle.');
  console.log('Polling every', localConfig.pollIntervalMs || 4000, 'ms. Press Ctrl+C to stop.\n');

  const loop = async () => {
    try {
      const n = await pollOnce(localConfig, printed);
      if (n > 0) console.log(`— printed ${n} new order(s) —`);
    } catch (err) {
      console.error('[error] poll failed:', err.message);
    }
  };

  await loop();
  setInterval(loop, localConfig.pollIntervalMs || 4000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
