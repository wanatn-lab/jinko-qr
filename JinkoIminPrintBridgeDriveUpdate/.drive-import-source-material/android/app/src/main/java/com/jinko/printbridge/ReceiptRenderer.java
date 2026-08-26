package com.jinko.printbridge;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/**
 * Renders a {@link Receipt} to a bitmap so it can travel through the same ESC/POS bit-image path
 * as {@link TicketRenderer} (EscPos#ticket) — used for the "network" and "bluetooth" printer
 * modes, where there is no iMin SDK / {@code IminPrintUtils} columns API available. This is the
 * generic counterpart to {@link ReceiptLayout}, which stays iMin-only.
 */
final class ReceiptRenderer {
  private static final int MAX_HEIGHT = 3200;
  private static final int MARGIN = 18;
  // Keep each transmitted image short — some LAN/Bluetooth ESC/POS printers truncate a tall
  // raster bitmap, same reasoning as TicketRenderer's slicing.
  private static final int MAX_SLICE_HEIGHT = 160;
  private static final TimeZone BANGKOK = TimeZone.getTimeZone("Asia/Bangkok");

  private ReceiptRenderer() {}

  static List<Bitmap> renderSlices(Receipt receipt) {
    return slice(render(receipt));
  }

  static Bitmap render(Receipt receipt) {
    int width = receipt.paperWidthDots >= 500 ? 576 : 384;
    Bitmap full = Bitmap.createBitmap(width, MAX_HEIGHT, Bitmap.Config.ARGB_8888);
    Canvas canvas = new Canvas(full);
    canvas.drawColor(Color.WHITE);

    Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    paint.setColor(Color.BLACK);
    int y = 20;

    y = drawCentered(canvas, paint, value(receipt.shopName, "จิ๊นโค"), width, y, 34, Typeface.BOLD);
    if (!receipt.phone.trim().isEmpty()) {
      y = drawCentered(canvas, paint, "โทร. " + receipt.phone.trim(), width, y + 4, 20, Typeface.NORMAL);
    }
    y = drawDivider(canvas, paint, width, y + 10);

    ReceiptDateTime dateTime = ReceiptDateTime.from(receipt.createdAt);
    y = drawRow(canvas, "โต๊ะ (Table): " + value(receipt.table, "-"), "วันที่: " + dateTime.date,
        width, y + 14, 20, Typeface.NORMAL);
    y = drawRow(canvas, "แคชเชียร์: แอดมิน", "เวลา: " + dateTime.time + " น.",
        width, y + 6, 20, Typeface.NORMAL);
    y = drawRow(canvas, "", receiptNumber(receipt.id), width, y + 4, 18, Typeface.NORMAL);
    y = drawDivider(canvas, paint, width, y + 10);

    y = drawRow3(canvas, "รายการ", "จำนวน", "ราคา", width, y + 12, 22, Typeface.BOLD);

    for (Receipt.Item item : aggregate(receipt.items)) {
      y = drawRow3(canvas, value(item.name, "รายการ"), String.valueOf(Math.max(1, item.qty)),
          amount(item.lineTotal), width, y + 10, 24, Typeface.NORMAL);
    }

    y = drawDivider(canvas, paint, width, y + 10);
    y = drawRow(canvas, "รวมเป็นเงิน (Subtotal)", amount(receipt.total), width, y + 10, 22, Typeface.NORMAL);
    y = drawDivider(canvas, paint, width, y + 8);
    y = drawRow(canvas, "ยอดสุทธิ (NET)", "฿ " + amount(receipt.total), width, y + 12, 28, Typeface.BOLD);
    y = drawDivider(canvas, paint, width, y + 10);

    y = drawCentered(canvas, paint, "ขอบคุณที่แวะมา โอกาสหน้าเชิญใหม่นะ", width, y + 14, 20, Typeface.BOLD);
    y = drawCentered(canvas, paint, "ผิดพลาดยังไงต้องขออภัย พวกเรามือใหม่จริงๆครับ", width, y + 4, 18, Typeface.NORMAL);

    y += 50;
    int cropHeight = Math.min(MAX_HEIGHT, Math.max(y, 160));
    return Bitmap.createBitmap(full, 0, 0, width, cropHeight);
  }

  private static List<Bitmap> slice(Bitmap receiptBitmap) {
    List<Bitmap> slices = new ArrayList<>();
    try {
      for (int top = 0; top < receiptBitmap.getHeight(); top += MAX_SLICE_HEIGHT) {
        int height = Math.min(MAX_SLICE_HEIGHT, receiptBitmap.getHeight() - top);
        slices.add(Bitmap.createBitmap(receiptBitmap, 0, top, receiptBitmap.getWidth(), height));
      }
      return slices;
    } finally {
      receiptBitmap.recycle();
    }
  }

  /** Same aggregation rule as ReceiptLayout so both print paths show identical line items. */
  private static List<Receipt.Item> aggregate(List<Receipt.Item> source) {
    Map<String, Receipt.Item> grouped = new LinkedHashMap<>();
    for (Receipt.Item item : source) {
      String name = value(item.name, "รายการ");
      int qty = Math.max(1, item.qty);
      double unitPrice = item.lineTotal / qty;
      String key = name + " " + String.format(Locale.US, "%.4f", unitPrice);
      Receipt.Item previous = grouped.get(key);
      if (previous == null) {
        grouped.put(key, new Receipt.Item(name, qty, item.lineTotal));
      } else {
        grouped.put(key, new Receipt.Item(name, previous.qty + qty, previous.lineTotal + item.lineTotal));
      }
    }
    return new ArrayList<>(grouped.values());
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

  private static int drawDivider(Canvas canvas, Paint paint, int width, int y) {
    paint.setStrokeWidth(1.5f);
    canvas.drawLine(MARGIN, y, width - MARGIN, y, paint);
    return y;
  }

  private static int drawRow(Canvas canvas, String left, String right, int width, int top,
      int size, int style) {
    TextPaint paint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
    paint.setColor(Color.BLACK);
    paint.setTextSize(size);
    paint.setTypeface(Typeface.create("sans-serif", style));
    Paint.FontMetrics metrics = paint.getFontMetrics();
    int baseline = top - Math.round(metrics.ascent);
    canvas.drawText(left, MARGIN, baseline, paint);
    canvas.drawText(right, width - MARGIN - paint.measureText(right), baseline, paint);
    return baseline + Math.round(metrics.descent);
  }

  private static int drawRow3(Canvas canvas, String left, String mid, String right, int width,
      int top, int size, int style) {
    TextPaint paint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
    paint.setColor(Color.BLACK);
    paint.setTextSize(size);
    paint.setTypeface(Typeface.create("sans-serif", style));
    int nameWidth = Math.max(60, width - (MARGIN * 2) - 170);
    StaticLayout layout = StaticLayout.Builder.obtain(left, 0, left.length(), paint, nameWidth)
        .setAlignment(Layout.Alignment.ALIGN_NORMAL)
        .setIncludePad(false)
        .setLineSpacing(2f, 1f)
        .build();
    canvas.save();
    canvas.translate(MARGIN, top);
    layout.draw(canvas);
    canvas.restore();

    Paint.FontMetrics metrics = paint.getFontMetrics();
    int baseline = top - Math.round(metrics.ascent);
    canvas.drawText(mid, width - MARGIN - 170, baseline, paint);
    canvas.drawText(right, width - MARGIN - paint.measureText(right), baseline, paint);
    return Math.max(top + layout.getHeight(), baseline + Math.round(metrics.descent));
  }

  private static String amount(double value) {
    return String.format(Locale.US, "%,.2f", Math.max(0, value));
  }

  private static String receiptNumber(String id) {
    int sequence = Math.floorMod(value(id, "receipt").hashCode(), 10000);
    return String.format(Locale.US, "#INV-%04d", sequence);
  }

  private static String value(String input, String fallback) {
    return input == null || input.trim().isEmpty() ? fallback : input.trim();
  }

  private static final class ReceiptDateTime {
    final String date;
    final String time;

    ReceiptDateTime(String date, String time) {
      this.date = date;
      this.time = time;
    }

    static ReceiptDateTime from(String raw) {
      String input = value(raw, "");
      String[] patterns = new String[] {
          "yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX",
          "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'"
      };
      for (String pattern : patterns) {
        try {
          SimpleDateFormat parser = new SimpleDateFormat(pattern, Locale.US);
          if (pattern.endsWith("'Z'")) parser.setTimeZone(TimeZone.getTimeZone("UTC"));
          Date parsed = parser.parse(input);
          if (parsed != null) {
            SimpleDateFormat date = new SimpleDateFormat("dd/MM/yyyy", Locale.US);
            SimpleDateFormat time = new SimpleDateFormat("HH:mm", Locale.US);
            date.setTimeZone(BANGKOK);
            time.setTimeZone(BANGKOK);
            return new ReceiptDateTime(date.format(parsed), time.format(parsed));
          }
        } catch (ParseException ignored) {
          // Supports the regular ISO values produced by the checkout API, then falls back below.
        }
      }
      String[] pieces = input.split("\\s+", 2);
      return new ReceiptDateTime(pieces.length > 0 && !pieces[0].isEmpty() ? pieces[0] : "-",
          pieces.length > 1 ? pieces[1].replace("น.", "").trim() : "-");
    }
  }
}

