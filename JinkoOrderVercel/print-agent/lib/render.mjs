import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let fontsRegistered = false;
function ensureFonts() {
  if (fontsRegistered) return;
  GlobalFonts.registerFromPath(path.join(__dirname, '../fonts/NotoSansThai-Regular.ttf'), 'Ticket');
  GlobalFonts.registerFromPath(path.join(__dirname, '../fonts/NotoSansThai-Bold.ttf'), 'Ticket-Bold');
  fontsRegistered = true;
}

function widthForPaper(paperWidthMm) {
  return paperWidthMm >= 76 ? 576 : 384; // 80mm -> 576 dots, 58mm -> 384 dots
}

// Word-wrap that also hard-breaks runs with no spaces (Thai text has none),
// so long Thai item names still wrap instead of overflowing the paper.
function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';

  const pushHard = (chunk) => {
    let cur = '';
    for (const ch of chunk) {
      const test = cur + ch;
      if (ctx.measureText(test).width > maxWidth && cur) {
        lines.push(cur);
        cur = ch;
      } else {
        cur = test;
      }
    }
    return cur;
  };

  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width <= maxWidth) {
      line = test;
      continue;
    }
    if (line) lines.push(line);
    if (ctx.measureText(word).width <= maxWidth) {
      line = word;
    } else {
      line = pushHard(word);
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('th-TH', {
    hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'
  });
}

/**
 * Lay out and rasterize a kitchen ticket for one order.
 * Returns { bitmap: Uint8Array, width, height } — bitmap is 1 byte/pixel,
 * 1 = black, 0 = white, ready for lib/escpos.mjs#rasterToEscPos.
 */
export function renderTicket(order, config) {
  ensureFonts();
  const width = widthForPaper(config.paperWidthMm || 80);
  const margin = 16;
  const contentWidth = width - margin * 2;

  // Fonts sizes tuned for 576px (80mm); scale down a bit for 384px (58mm).
  const scale = width / 576;
  const F_SHOP = Math.round(32 * scale);
  const F_HEADER = Math.round(58 * scale);
  const F_META = Math.round(26 * scale);
  const F_ITEM = Math.round(34 * scale);
  const F_QTY = Math.round(34 * scale);
  const F_TOTAL = Math.round(36 * scale);
  const LINE_GAP = Math.round(10 * scale);

  // --- Pass 1: measure on a scratch canvas to find total height ---
  const scratch = createCanvas(width, 10);
  const mctx = scratch.getContext('2d');
  let y = margin;

  const items = order.items || [];
  const itemLineGroups = items.map((it) => {
    mctx.font = `${F_ITEM}px "Ticket-Bold"`;
    return wrapText(mctx, it.name, contentWidth - Math.round(70 * scale));
  });

  y += F_SHOP + LINE_GAP * 2;               // shop name
  if (order.stationName) {
    mctx.font = `${F_META}px "Ticket-Bold"`;
    y += F_META + LINE_GAP;                 // station label
  }
  y += F_HEADER + LINE_GAP;                 // table number
  y += F_META + LINE_GAP * 2;               // time + order id
  y += 2 + LINE_GAP * 2;                    // divider
  itemLineGroups.forEach((lines) => {
    y += lines.length * (F_ITEM + LINE_GAP) + Math.round(6 * scale);
  });
  y += 2 + LINE_GAP * 2;                    // divider
  if (order.note) {
    mctx.font = `${F_META}px "Ticket"`;
    const noteLines = wrapText(mctx, 'หมายเหตุ: ' + order.note, contentWidth);
    y += noteLines.length * (F_META + LINE_GAP) + LINE_GAP;
  }
  y += F_TOTAL + LINE_GAP;                  // total line
  y += margin + Math.round(40 * scale);     // bottom padding for tear-off

  const height = Math.ceil(y / 8) * 8; // keep a multiple of 8 for tidy raster strips

  // --- Pass 2: actually draw ---
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';

  let cy = margin;

  ctx.font = `${F_SHOP}px "Ticket-Bold"`;
  ctx.textAlign = 'center';
  ctx.fillText(config.shopName || 'ใบสั่งครัว', width / 2, cy);
  cy += F_SHOP + LINE_GAP * 2;

  if (order.stationName) {
    ctx.font = `${F_META}px "Ticket-Bold"`;
    ctx.fillText('จุดพิมพ์: ' + order.stationName, width / 2, cy);
    cy += F_META + LINE_GAP;
  }

  ctx.font = `${F_HEADER}px "Ticket-Bold"`;
  ctx.fillText('โต๊ะ ' + order.table, width / 2, cy);
  cy += F_HEADER + LINE_GAP;

  ctx.font = `${F_META}px "Ticket"`;
  ctx.fillText(`${formatTime(order.createdAt)}   #${(order.id || '').slice(-5)}`, width / 2, cy);
  cy += F_META + LINE_GAP * 2;
  ctx.textAlign = 'left';

  ctx.fillRect(margin, cy, contentWidth, 2);
  cy += 2 + LINE_GAP * 2;

  items.forEach((it, i) => {
    const lines = itemLineGroups[i];
    ctx.font = `${F_ITEM}px "Ticket-Bold"`;
    lines.forEach((line, li) => {
      ctx.fillText(line, margin, cy);
      if (li === 0) {
        ctx.font = `${F_QTY}px "Ticket-Bold"`;
        ctx.textAlign = 'right';
        ctx.fillText('x' + it.qty, width - margin, cy);
        ctx.textAlign = 'left';
        ctx.font = `${F_ITEM}px "Ticket-Bold"`;
      }
      cy += F_ITEM + LINE_GAP;
    });
    cy += Math.round(6 * scale);
  });

  ctx.fillRect(margin, cy, contentWidth, 2);
  cy += 2 + LINE_GAP * 2;

  if (order.note) {
    ctx.font = `${F_META}px "Ticket"`;
    const noteLines = wrapText(ctx, 'หมายเหตุ: ' + order.note, contentWidth);
    noteLines.forEach((line) => {
      ctx.fillText(line, margin, cy);
      cy += F_META + LINE_GAP;
    });
    cy += LINE_GAP;
  }

  const totalQty = items.reduce((s, it) => s + it.qty, 0);
  ctx.font = `${F_TOTAL}px "Ticket-Bold"`;
  ctx.fillText(`รวม ${totalQty} รายการ`, margin, cy);

  // --- Convert to 1-bit bitmap (simple luminance threshold) ---
  const imgData = ctx.getImageData(0, 0, width, height).data;
  const bitmap = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const r = imgData[p * 4], g = imgData[p * 4 + 1], b = imgData[p * 4 + 2], a = imgData[p * 4 + 3];
    const lum = a === 0 ? 255 : (r * 0.299 + g * 0.587 + b * 0.114);
    bitmap[p] = lum < 200 ? 1 : 0;
  }

  return { bitmap, width, height };
}

export async function renderTicketToPngBuffer(order, config) {
  ensureFonts();
  const width = widthForPaper(config.paperWidthMm || 80);
  // Re-run the same layout by drawing on a real canvas and exporting PNG,
  // used only for --test mode previews (no printer needed).
  const { bitmap, height } = renderTicket(order, config);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  for (let p = 0; p < width * height; p++) {
    const v = bitmap[p] ? 0 : 255;
    img.data[p * 4] = v;
    img.data[p * 4 + 1] = v;
    img.data[p * 4 + 2] = v;
    img.data[p * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toBuffer('image/png');
}
