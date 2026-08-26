package com.jinko.printbridge;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;

import java.util.ArrayList;
import java.util.List;

/** Renders Thai as a bitmap so both printer paths are independent of ESC/POS code pages. */
final class TicketRenderer {
  private static final int MAX_HEIGHT = 2200;
  private static final int MARGIN = 18;
  // Older iMin firmware and some LAN thermal printers truncate a tall raster bitmap.
  // Keep each transmitted image deliberately short and print the slices in order.
  private static final int MAX_SLICE_HEIGHT = 160;

  private TicketRenderer() {}

  static Bitmap render(Ticket ticket) {
    int width = ticket.paperWidthDots >= 500 ? 576 : 384;
    Bitmap full = Bitmap.createBitmap(width, MAX_HEIGHT, Bitmap.Config.ARGB_8888);
    Canvas canvas = new Canvas(full);
    canvas.drawColor(Color.WHITE);

    Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    paint.setColor(Color.BLACK);
    paint.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
    int y = 20;

    y = drawCentered(canvas, paint, value(ticket.shopName, "จิ๊นโค"), width, y, 31, Typeface.BOLD);
    y = drawCentered(canvas, paint, value(ticket.station, "ใบสั่งอาหาร"), width, y + 4, 24, Typeface.NORMAL);
    y = drawDivider(canvas, paint, width, y + 12);
    y = drawText(canvas, paint, "โต๊ะ " + value(ticket.table, "-"), MARGIN, y + 18, 28, Typeface.BOLD);
    y = drawText(canvas, paint, value(ticket.createdAt, ""), MARGIN, y + 8, 20, Typeface.NORMAL);
    y = drawDivider(canvas, paint, width, y + 14);

    for (Ticket.Item item : ticket.items) {
      y = drawItem(canvas, paint, item, width, y + 14);
    }

    if (!ticket.note.trim().isEmpty()) {
      y = drawDivider(canvas, paint, width, y + 12);
      y = drawParagraph(canvas, "หมายเหตุ: " + ticket.note, MARGIN, y + 12,
          width - (MARGIN * 2), 22, Typeface.BOLD);
    }

    y += 44;
    int cropHeight = Math.min(MAX_HEIGHT, Math.max(y, 120));
    return Bitmap.createBitmap(full, 0, 0, width, cropHeight);
  }

  static List<Bitmap> renderSlices(Ticket ticket) {
    return slice(render(ticket));
  }

  static List<Bitmap> renderInternalSlices(Ticket ticket) {
    return slice(renderInternal(ticket));
  }

  private static List<Bitmap> slice(Bitmap ticketBitmap) {
    List<Bitmap> slices = new ArrayList<>();
    try {
      for (int top = 0; top < ticketBitmap.getHeight(); top += MAX_SLICE_HEIGHT) {
        int height = Math.min(MAX_SLICE_HEIGHT, ticketBitmap.getHeight() - top);
        slices.add(Bitmap.createBitmap(ticketBitmap, 0, top, ticketBitmap.getWidth(), height));
      }
      return slices;
    } finally {
      ticketBitmap.recycle();
    }
  }

  /**
   * iMin D4 composition for its 80 mm internal printer.  The text stays the same visual size
   * as the previous native-text receipt, while the divider and quantity use the full bitmap
   * width.  This avoids D4's fixed, narrower text-mode layout.
   */
  static Bitmap renderInternal(Ticket ticket) {
    int width = ticket.paperWidthDots >= 500 ? 576 : 384;
    Bitmap full = Bitmap.createBitmap(width, MAX_HEIGHT, Bitmap.Config.ARGB_8888);
    Canvas canvas = new Canvas(full);
    canvas.drawColor(Color.WHITE);

    Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    paint.setColor(Color.BLACK);
    int y = 18;
    y = drawText(canvas, paint, value(ticket.shopName, "จิ๊นโค"), MARGIN, y, 26, Typeface.NORMAL);
    y = drawText(canvas, paint, value(ticket.station, "ใบสั่งอาหาร"), MARGIN, y + 4,
        26, Typeface.NORMAL);
    y = drawDivider(canvas, paint, width, y + 12);
    y = drawText(canvas, paint, "โต๊ะ " + value(ticket.table, "-"), MARGIN, y + 16,
        26, Typeface.NORMAL);
    if (!ticket.createdAt.trim().isEmpty()) {
      y = drawText(canvas, paint, ticket.createdAt, MARGIN, y + 7, 26, Typeface.NORMAL);
    }
    y = drawDivider(canvas, paint, width, y + 14);

    for (Ticket.Item item : ticket.items) {
      y = drawInternalItem(canvas, paint, item, width, y + 16);
    }
    if (!ticket.note.trim().isEmpty()) {
      y = drawDivider(canvas, paint, width, y + 12);
      y = drawParagraph(canvas, "หมายเหตุ: " + ticket.note, MARGIN, y + 12,
          width - (MARGIN * 2), 24, Typeface.NORMAL);
    }

    // 48 dots plus the post-image feed provides a clear margin before the cutter.
    int cropHeight = Math.min(MAX_HEIGHT, Math.max(y + 48, 120));
    return Bitmap.createBitmap(full, 0, 0, width, cropHeight);
  }

  private static int drawCentered(Canvas canvas, Paint paint, String text, int width, int top,
      int size, int style) {
    paint.setTextSize(size);
    paint.setTypeface(Typeface.create("sans-serif", style));
    Paint.FontMetrics metrics = paint.getFontMetrics();
    int baseline = top - Math.round(metrics.ascent);
    canvas.drawText(text, (width - paint.measureText(text)) / 2f, baseline, paint);
    return baseline + Math.round(metrics.descent);
  }

  private static int drawText(Canvas canvas, Paint paint, String text, int left, int top, int size,
      int style) {
    paint.setTextSize(size);
    paint.setTypeface(Typeface.create("sans-serif", style));
    Paint.FontMetrics metrics = paint.getFontMetrics();
    int baseline = top - Math.round(metrics.ascent);
    canvas.drawText(text, left, baseline, paint);
    return baseline + Math.round(metrics.descent);
  }

  private static int drawDivider(Canvas canvas, Paint paint, int width, int y) {
    paint.setStrokeWidth(1.5f);
    canvas.drawLine(MARGIN, y, width - MARGIN, y, paint);
    return y;
  }

  private static int drawItem(Canvas canvas, Paint paint, Ticket.Item item, int width, int top) {
    int qtyWidth = 82;
    int textWidth = width - (MARGIN * 2) - qtyWidth;
    int bottom = drawParagraph(canvas, value(item.name, "รายการ"), MARGIN, top, textWidth,
        // 1.5× the former 24 px size: prominent without overtaking the whole kitchen ticket.
        36, Typeface.BOLD);

    paint.setTextSize(36);
    paint.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
    String qty = "×" + Math.max(1, item.qty);
    Paint.FontMetrics metrics = paint.getFontMetrics();
    int baseline = top - Math.round(metrics.ascent);
    canvas.drawText(qty, width - MARGIN - paint.measureText(qty), baseline, paint);
    return bottom;
  }

  private static int drawInternalItem(Canvas canvas, Paint paint, Ticket.Item item, int width,
      int top) {
    int qtyWidth = 64;
    int bottom = drawParagraph(canvas, value(item.name, "รายการ"), MARGIN, top,
        width - (MARGIN * 2) - qtyWidth, 26, Typeface.NORMAL);
    paint.setTextSize(26);
    paint.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
    String qty = "x" + Math.max(1, item.qty);
    Paint.FontMetrics metrics = paint.getFontMetrics();
    int baseline = top - Math.round(metrics.ascent);
    canvas.drawText(qty, width - MARGIN - paint.measureText(qty), baseline, paint);
    return bottom;
  }

  private static int drawParagraph(Canvas canvas, String text, int left, int top, int width,
      int size, int style) {
    TextPaint paint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
    paint.setColor(Color.BLACK);
    paint.setTextSize(size);
    paint.setTypeface(Typeface.create("sans-serif", style));
    StaticLayout layout = StaticLayout.Builder.obtain(text, 0, text.length(), paint, width)
        .setAlignment(Layout.Alignment.ALIGN_NORMAL)
        .setIncludePad(false)
        .setLineSpacing(3f, 1f)
        .build();
    canvas.save();
    canvas.translate(left, top);
    layout.draw(canvas);
    canvas.restore();
    return top + layout.getHeight();
  }

  private static String value(String input, String fallback) {
    return input == null || input.trim().isEmpty() ? fallback : input;
  }
}

