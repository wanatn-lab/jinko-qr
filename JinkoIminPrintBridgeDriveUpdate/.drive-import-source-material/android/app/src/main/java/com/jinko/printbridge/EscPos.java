package com.jinko.printbridge;

import android.graphics.Bitmap;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.Charset;
import java.util.List;

/**
 * ESC/POS bit-image encoder used for the kitchen printer's raw TCP/9100 connection.
 * ESC * is supported by older generic thermal printers that ignore the newer GS v 0 raster
 * command, which previously resulted in a blank but cut receipt.
 */
final class EscPos {
  private static final Charset TIS_620 = Charset.forName("TIS-620");

  private EscPos() {}

  static byte[] ticket(Bitmap bitmap, boolean cut) throws IOException {
    return ticket(java.util.Collections.singletonList(bitmap), cut);
  }

  static byte[] ticket(List<Bitmap> bitmaps, boolean cut) throws IOException {
    if (bitmaps == null || bitmaps.isEmpty()) throw new IOException("ไม่มีภาพใบสั่ง");
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    output.write(new byte[] {0x1b, 0x40});
    output.write(new byte[] {0x1b, 0x61, 0x00}); // left alignment
    output.write(new byte[] {0x1b, 0x33, 24}); // line spacing for 24-dot bands
    for (Bitmap bitmap : bitmaps) appendBitImage(output, bitmap);
    output.write(new byte[] {0x1b, 0x32}); // restore default line spacing
    output.write(new byte[] {0x1b, 0x64, 0x05});
    if (cut) output.write(new byte[] {0x1d, 0x56, 0x01});
    return output.toByteArray();
  }

  /**
   * Text mode is the preferred LAN route for a Thai ESC/POS printer.  The prior image commands
   * were accepted only as feed/cut by the installed printer, yielding a blank receipt.
   */
  static byte[] ticketText(Ticket ticket, boolean cut) throws IOException {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    output.write(new byte[] {0x1b, 0x40});
    // The printer self-test says "Chinese character mode: Yes".  In that mode it treats
    // adjacent Thai bytes as GB18030 pairs, so cancel it before selecting the Thai table.
    output.write(new byte[] {0x1c, 0x2e}); // FS . — cancel Chinese character mode
    // The GE801PN self-test identifies its Thai table as ESC t 255.  Code page 20 is a
    // different table on this printer, which is why Thai had been sent but not rendered.
    output.write(new byte[] {0x1b, 0x74, (byte) 0xff});
    output.write(new byte[] {0x1b, 0x61, 0x00}); // left alignment
    writeLine(output, ticket.shopName);
    writeLine(output, ticket.station);
    writeLine(output, "------------------------------------------------");
    writeLine(output, "โต๊ะ " + ticket.table);
    if (!ticket.createdAt.trim().isEmpty()) writeLine(output, ticket.createdAt);
    writeLine(output, "------------------------------------------------");
    for (Ticket.Item item : ticket.items) {
      writeLine(output, item.name + "  x" + Math.max(1, item.qty));
    }
    if (!ticket.note.trim().isEmpty()) {
      writeLine(output, "------------------------------------------------");
      writeLine(output, "หมายเหตุ: " + ticket.note);
    }
    output.write(new byte[] {0x0a, 0x0a, 0x0a, 0x1b, 0x64, 0x05});
    if (cut) output.write(new byte[] {0x1d, 0x56, 0x01});
    return output.toByteArray();
  }

  private static void writeLine(ByteArrayOutputStream output, String text) throws IOException {
    output.write(text.getBytes(TIS_620));
    output.write(0x0a);
  }

  private static void appendBitImage(ByteArrayOutputStream output, Bitmap bitmap) throws IOException {
    int width = bitmap.getWidth();
    int height = bitmap.getHeight();
    if (width > 65535) throw new IOException("ภาพใบสั่งกว้างเกินไป");
    for (int top = 0; top < height; top += 24) {
      output.write(new byte[] {0x1b, 0x2a, 33,
          (byte) (width & 0xff), (byte) ((width >> 8) & 0xff)});
      for (int x = 0; x < width; x++) {
        for (int byteIndex = 0; byteIndex < 3; byteIndex++) {
          int bits = 0;
          for (int bit = 0; bit < 8; bit++) {
            int y = top + (byteIndex * 8) + bit;
            if (y < height && isBlack(bitmap.getPixel(x, y))) bits |= 0x80 >> bit;
          }
          output.write(bits);
        }
      }
      output.write(0x0a);
    }
  }

  private static boolean isBlack(int color) {
    int red = (color >> 16) & 0xff;
    int green = (color >> 8) & 0xff;
    int blue = color & 0xff;
    return (red * 299 + green * 587 + blue * 114) / 1000 < 180;
  }
}

