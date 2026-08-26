// Minimal ESC/POS helpers: initialize printer, encode a 1-bit raster image
// using the GS v 0 command, and cut paper. Sent in horizontal strips of
// STRIP_HEIGHT rows at a time to stay well under the print buffer size that
// most ESC/POS-compatible network printers (Epson, Xprinter, Gprinter, etc)
// support — sending one giant command in a single shot is a common cause of
// garbled or dropped prints on cheaper printer firmwares.

const STRIP_HEIGHT = 200;

const ESC = 0x1b;
const GS = 0x1d;

export function initPrinter() {
  return Buffer.from([ESC, 0x40]); // ESC @  — reset
}

export function feed(lines = 3) {
  return Buffer.from([ESC, 0x64, lines]); // ESC d n — feed n lines
}

export function cutPaper() {
  return Buffer.from([GS, 0x56, 0x42, 0x00]); // GS V B 0 — full cut
}

/**
 * Convert 1-bit packed bitmap rows into ESC/POS raster print commands.
 * @param {Uint8Array} bitmap - 1 byte per pixel, 0 = white, 1 = black, row-major
 * @param {number} width - pixel width, must be a multiple of 8
 * @param {number} height - pixel height
 * @returns {Buffer}
 */
export function rasterToEscPos(bitmap, width, height) {
  if (width % 8 !== 0) {
    throw new Error(`raster width must be a multiple of 8 (got ${width})`);
  }
  const bytesPerRow = width / 8;
  const chunks = [];

  for (let y0 = 0; y0 < height; y0 += STRIP_HEIGHT) {
    const stripH = Math.min(STRIP_HEIGHT, height - y0);
    const data = Buffer.alloc(bytesPerRow * stripH);

    for (let y = 0; y < stripH; y++) {
      for (let xByte = 0; xByte < bytesPerRow; xByte++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = xByte * 8 + bit;
          const pixel = bitmap[(y0 + y) * width + x];
          if (pixel) byte |= 0x80 >> bit;
        }
        data[y * bytesPerRow + xByte] = byte;
      }
    }

    const xL = bytesPerRow & 0xff;
    const xH = (bytesPerRow >> 8) & 0xff;
    const yL = stripH & 0xff;
    const yH = (stripH >> 8) & 0xff;
    const header = Buffer.from([GS, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
    chunks.push(header, data);
  }

  return Buffer.concat(chunks);
}
