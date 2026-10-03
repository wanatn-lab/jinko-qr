package com.jinko.printbridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;

import com.imin.printerlib.IminPrintUtils;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Native foreground worker for the period while the user has switched away from the Bridge UI.
 * React Native timers are paused or reclaimed by Android in that state, so polling and printing
 * deliberately live here rather than relying on JavaScript remaining resident.
 */
public final class OrderPollingService extends Service {
  private static final String BOOTSTRAP_COMPLETE = "bootstrap_complete";
  private static final int CONNECT_TIMEOUT_MS = 4000;
  private static final int HTTP_TIMEOUT_MS = 8000;
  private static final int NOTIFICATION_ID = 240814;
  private static final String CHANNEL_ID = "jinko_print_bridge";
  private static final long HANDOFF_DELAY_SECONDS = 2;
  // QR table labels are explicitly requested by a human, so keep this separate from
  // normal order polling and check it promptly without making order polling aggressive.
  private static final long QR_POLL_SECONDS = 1;
  private static final TimeZone BANGKOK = TimeZone.getTimeZone("Asia/Bangkok");
  // Same generic ESC/POS Bluetooth SPP UUID used by IminPrinterModule — kept in sync here because
  // this service re-implements printing independently while the app is backgrounded.
  private static final java.util.UUID SPP_UUID =
      java.util.UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

  private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
  private ScheduledFuture<?> pollingTask;
  private ScheduledFuture<?> qrPollingTask;
  private SharedPreferences preferences;
  private IminPrintUtils internalPrinter;
  private boolean internalPrinterInitialized;

  static void start(Context context) {
    SharedPreferences preferences = context.getSharedPreferences(PrintHistory.PREFS, MODE_PRIVATE);
    if (!preferences.getBoolean("autoPrint", true)) return;
    Intent intent = new Intent(context, OrderPollingService.class);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      context.startForegroundService(intent);
    } else {
      context.startService(intent);
    }
  }

  static void stop(Context context) {
    context.stopService(new Intent(context, OrderPollingService.class));
  }

  @Override
  public void onCreate() {
    super.onCreate();
    preferences = getSharedPreferences(PrintHistory.PREFS, MODE_PRIVATE);
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (!preferences.getBoolean("autoPrint", true)) {
      stopForeground(true);
      stopSelf(startId);
      return START_NOT_STICKY;
    }
    startForeground(NOTIFICATION_ID, buildNotification("กำลังรอออเดอร์ใหม่…"));
    schedulePolling();
    return START_STICKY;
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public void onDestroy() {
    // Finish a ticket already handed to the printer before the foreground UI resumes.  Interrupting
    // it here can cut an iMin receipt halfway and then let the UI send the same order again.
    if (pollingTask != null) pollingTask.cancel(false);
    if (qrPollingTask != null) qrPollingTask.cancel(false);
    worker.shutdown();
    stopForeground(true);
    super.onDestroy();
  }

  private void schedulePolling() {
    if (pollingTask != null && !pollingTask.isCancelled()) return;
    int seconds = Math.max(2, Math.min(30, preferences.getInt("pollSeconds", 4)));
    pollingTask = worker.scheduleWithFixedDelay(new Runnable() {
      @Override
      public void run() {
        pollAndPrint();
      }
    }, HANDOFF_DELAY_SECONDS, seconds, TimeUnit.SECONDS);
    qrPollingTask = worker.scheduleWithFixedDelay(new Runnable() {
      @Override
      public void run() {
        pollQrAndPrint();
      }
    }, QR_POLL_SECONDS, QR_POLL_SECONDS, TimeUnit.SECONDS);
  }

  private void pollAndPrint() {
    if (!preferences.getBoolean("autoPrint", true)) {
      stopSelf();
      return;
    }
    try {
      String baseUrl = normaliseBaseUrl(preferences.getString("apiBaseUrl", "https://jinko-order.vercel.app"));
      // The foreground React screen is paused while this service owns printing.
      // Fetch the full settings object here as well, not just the paper width;
      // older queued jobs may not contain their own receiptConfig snapshot.
      JSONObject serverSettings = loadServerSettings(baseUrl);
      int paperWidthDots = paperWidthDots(serverSettings);
      JSONObject fallbackReceiptConfig = serverSettings.optJSONObject("receipt");
      List<QueuedTicket> tickets = readQueuedTickets(fetchArray(baseUrl + "/api/orders"), paperWidthDots);
      List<QueuedReceipt> receipts = readQueuedReceipts(
          fetchObject(baseUrl + "/api/print-jobs"), paperWidthDots, fallbackReceiptConfig);
      boolean bootstrapping = !preferences.getBoolean(BOOTSTRAP_COMPLETE, false);
      boolean skipExisting = bootstrapping && preferences.getBoolean("skipExistingOnFirstSync", true);
      java.util.Set<String> printedKeys = PrintHistory.getPrintedKeys(preferences);

      if (bootstrapping) {
        if (skipExisting) {
          for (QueuedTicket ticket : tickets) {
            PrintHistory.markPrinted(preferences, ticket.key);
            printedKeys.add(ticket.key);
          }
        }
        preferences.edit().putBoolean(BOOTSTRAP_COMPLETE, true).apply();
      }

      if (skipExisting) {
        updateNotification("พร้อมรับออเดอร์ใหม่หลังจากนี้");
        return;
      }

      int printedNow = 0;
      String lastFailure = null;
      String printerMode = value(preferences.getString("printerMode", "imin"), "imin");
      for (QueuedTicket queued : tickets) {
        if (printedKeys.contains(queued.key) || !PrintHistory.claim(preferences, queued.key)) continue;
        try {
          if (queued.internal) {
            // Counter/drinks route — respects the printer-mode setting so this same backgrounded
            // service can serve iMin hardware or a generic network/Bluetooth ESC/POS printer.
            printCounterTicket(queued.ticket, printerMode);
          } else {
            // Kitchen route stays on its own dedicated LAN printer regardless of printerMode —
            // that path was already vendor-neutral before this change.
            printNetwork(queued.ticket,
                preferences.getString("kitchenHost", "192.168.1.242"),
                Math.max(1, Math.min(65535, preferences.getInt("kitchenPort", 9100))));
          }
          PrintHistory.markPrinted(preferences, queued.key);
          printedKeys.add(queued.key);
          printedNow++;
        } catch (Exception error) {
          PrintHistory.release(preferences, queued.key);
          lastFailure = error.getMessage();
        }
      }
      String deviceId = deviceId();
      for (QueuedReceipt queued : receipts) {
        // A successful print may have reached the printer just before a network outage.  Local
        // history lets us safely acknowledge that queued receipt without printing it twice.
        if (printedKeys.contains(queued.key)) {
          try {
            updateReceiptJob(baseUrl, "complete", queued.receipt.id, deviceId);
          } catch (Exception ignored) {
            // The next background poll will acknowledge it; never reprint a confirmed local key.
          }
          continue;
        }
        if (!PrintHistory.claim(preferences, queued.key)) continue;
        boolean remotelyClaimed = false;
        boolean sentToPrinter = false;
        try {
          remotelyClaimed = updateReceiptJob(baseUrl, "claim", queued.receipt.id, deviceId);
          if (!remotelyClaimed) {
            PrintHistory.release(preferences, queued.key);
            continue;
          }
          printCounterReceipt(queued.receipt, printerMode);
          sentToPrinter = true;
          PrintHistory.markPrinted(preferences, queued.key);
          printedKeys.add(queued.key);
          printedNow++;
          // Marking locally first is deliberate: an acknowledgement outage must not create a
          // duplicate customer receipt.  The next poll will retry the acknowledgement only.
          updateReceiptJob(baseUrl, "complete", queued.receipt.id, deviceId);
        } catch (Exception error) {
          if (!sentToPrinter) {
            PrintHistory.release(preferences, queued.key);
            if (remotelyClaimed) {
              try {
                updateReceiptJob(baseUrl, "release", queued.receipt.id, deviceId);
              } catch (Exception ignored) {
                // The server lease expires and makes a genuinely failed receipt retryable.
              }
            }
          }
          lastFailure = error.getMessage();
        }
      }
      if (lastFailure != null) {
        updateNotification("พิมพ์ไม่สำเร็จ: " + lastFailure);
      } else if (printedNow > 0) {
        updateNotification("พิมพ์ " + printedNow + " ใบแล้ว · กำลังรอออเดอร์ใหม่");
      } else {
        updateNotification("กำลังรอออเดอร์ใหม่…");
      }
    } catch (Exception error) {
      updateNotification("เชื่อมต่อระบบออเดอร์ไม่ได้: " + message(error));
    }
  }

  /**
   * Handles QR jobs created from the Admin "QR โต๊ะ" tab. QR labels always go to this
   * iMin device's built-in USB printer, independently of the drinks-ticket printer mode.
   */
  private void pollQrAndPrint() {
    if (!preferences.getBoolean("autoPrint", true)) return;
    try {
      String baseUrl = normaliseBaseUrl(preferences.getString("apiBaseUrl", "https://jinko-order.vercel.app"));
      List<QueuedQr> jobs = readQueuedQrJobs(fetchObject(baseUrl + "/api/qr-print-jobs"));
      java.util.Set<String> printedKeys = PrintHistory.getPrintedKeys(preferences);
      for (QueuedQr job : jobs) {
        if (printedKeys.contains(job.key)) {
          try { completeQrJob(baseUrl, job.id); } catch (Exception ignored) { }
          continue;
        }
        if (!PrintHistory.claim(preferences, job.key)) continue;
        try {
          printInternalQr(job);
          PrintHistory.markPrinted(preferences, job.key);
          printedKeys.add(job.key);
          completeQrJob(baseUrl, job.id);
          updateNotification("พิมพ์ QR โต๊ะ " + job.table + " แล้ว");
        } catch (Exception error) {
          PrintHistory.release(preferences, job.key);
          updateNotification("พิมพ์ QR ไม่สำเร็จ: " + message(error));
        }
      }
    } catch (Exception error) {
      // QR is an optional, additive queue. A temporary issue here must not interrupt
      // normal food, drinks, or receipt printing handled by pollAndPrint().
    }
  }

  private List<QueuedTicket> readQueuedTickets(JSONArray orders, int paperWidthDots) throws JSONException {
    List<QueuedTicket> tickets = new ArrayList<>();
    String drinkCategory = value(preferences.getString("drinkCategory", "เครื่องดื่ม"), "เครื่องดื่ม");
    String shopName = value(preferences.getString("shopName", "จิ๊นโค"), "จิ๊นโค");
    for (int index = 0; index < orders.length(); index++) {
      JSONObject order = orders.optJSONObject(index);
      if (order == null || "done".equalsIgnoreCase(text(order, "status", ""))) continue;
      String orderId = text(order, "id", text(order, "_id", ""));
      if (orderId.trim().isEmpty()) continue;

      List<Ticket.Item> drinkItems = new ArrayList<>();
      List<Ticket.Item> kitchenItems = new ArrayList<>();
      JSONArray items = order.optJSONArray("items");
      if (items == null) continue;
      for (int itemIndex = 0; itemIndex < items.length(); itemIndex++) {
        JSONObject item = items.optJSONObject(itemIndex);
        if (item == null) continue;
        Ticket.Item entry = new Ticket.Item(text(item, "name", "รายการ"), number(item, "qty", 1));
        if (drinkCategory.equals(text(item, "category", "").trim())) {
          drinkItems.add(entry);
        } else {
          kitchenItems.add(entry);
        }
      }

      String table = text(order, "table", "-");
      Object rawCreatedAt = order.opt("createdAt");
      String createdAt = formatTime(rawCreatedAt);
      String createdAtSortKey = timestampSortKey(rawCreatedAt);
      String note = text(order, "note", "");
      if (!drinkItems.isEmpty()) {
        tickets.add(new QueuedTicket("internal:" + orderId, true,
            new Ticket(shopName, "เคาน์เตอร์เครื่องดื่ม", table, createdAt, note,
                paperWidthDots, drinkItems), createdAtSortKey));
      }
      if (!kitchenItems.isEmpty()) {
        tickets.add(new QueuedTicket("kitchen:" + orderId, false,
            new Ticket(shopName, "ครัว", table, createdAt, note, paperWidthDots, kitchenItems),
            createdAtSortKey));
      }
    }
    Collections.sort(tickets, new Comparator<QueuedTicket>() {
      @Override
      public int compare(QueuedTicket first, QueuedTicket second) {
        return first.createdAt.compareTo(second.createdAt);
      }
    });
    return tickets;
  }

  private List<QueuedQr> readQueuedQrJobs(JSONObject payload) {
    List<QueuedQr> jobs = new ArrayList<>();
    JSONArray rawJobs = payload.optJSONArray("jobs");
    if (rawJobs == null) return jobs;
    for (int index = 0; index < rawJobs.length(); index++) {
      JSONObject job = rawJobs.optJSONObject(index);
      if (job == null || !"queued".equalsIgnoreCase(text(job, "status", "queued"))) continue;
      String id = text(job, "id", "").trim();
      String url = text(job, "url", "").trim();
      if (id.isEmpty() || url.isEmpty()) continue;
      jobs.add(new QueuedQr("qr:" + id, id, text(job, "table", "-"), url));
    }
    return jobs;
  }

  private List<QueuedReceipt> readQueuedReceipts(JSONObject payload, int paperWidthDots,
      @Nullable JSONObject fallbackReceiptConfig)
      throws JSONException {
    List<QueuedReceipt> receipts = new ArrayList<>();
    JSONArray jobs = payload.optJSONArray("jobs");
    if (jobs == null) return receipts;
    for (int index = 0; index < jobs.length(); index++) {
      JSONObject job = jobs.optJSONObject(index);
      if (job == null || !"receipt".equals(text(job, "type", ""))) continue;
      String id = text(job, "id", "");
      if (id.trim().isEmpty()) continue;
      JSONArray rawItems = job.optJSONArray("items");
      if (rawItems == null || rawItems.length() == 0) continue;
      List<Receipt.Item> items = new ArrayList<>();
      double calculatedTotal = 0;
      for (int itemIndex = 0; itemIndex < rawItems.length(); itemIndex++) {
        JSONObject item = rawItems.optJSONObject(itemIndex);
        if (item == null) continue;
        int qty = number(item, "qty", 1);
        double lineTotal = decimal(item, "lineTotal", decimal(item, "price", 0) * qty);
        items.add(new Receipt.Item(text(item, "name", "รายการ"), qty, lineTotal));
        calculatedTotal += lineTotal;
      }
      if (items.isEmpty()) continue;
      Object rawCreatedAt = job.opt("createdAt");
      // New checkout jobs include a design snapshot.  Some already-deployed/legacy jobs do not,
      // especially when the foreground UI has handed printing over to this background service.
      // Fall back to the Admin settings only when the job lacks a snapshot; never merge the two,
      // so a real saved snapshot remains historically accurate for reprints.
      JSONObject receiptConfig = job.optJSONObject("receiptConfig");
      if (receiptConfig == null || receiptConfig.length() == 0) {
        receiptConfig = fallbackReceiptConfig == null ? new JSONObject() : fallbackReceiptConfig;
      }
      Receipt receipt = new Receipt(
          id,
          value(text(job, "shopName", preferences.getString("shopName", "จิ๊นโค")), "จิ๊นโค"),
          text(receiptConfig, "shopPhone", text(job, "phone", "")),
          text(job, "table", "-"),
          timestampIso(rawCreatedAt),
          text(job, "billNo", ""),
          text(receiptConfig, "title", "ใบเสร็จรับเงิน"),
          text(receiptConfig, "shopAddress", ""),
          text(receiptConfig, "taxId", ""),
          text(receiptConfig, "thanksText", ""),
          text(receiptConfig, "apologyText", ""),
          flag(receiptConfig, "showBillNo", true),
          flag(receiptConfig, "showTime", true),
          flag(receiptConfig, "showTable", true),
          flag(receiptConfig, "showQr", false),
          text(receiptConfig, "qrUrl", ""),
          text(receiptConfig, "logoUrl", ""),
          paperWidthDots,
          items,
          decimal(job, "total", calculatedTotal));
      receipts.add(new QueuedReceipt("receipt:" + id, receipt,
          timestampSortKey(rawCreatedAt)));
    }
    Collections.sort(receipts, new Comparator<QueuedReceipt>() {
      @Override
      public int compare(QueuedReceipt first, QueuedReceipt second) {
        return first.createdAt.compareTo(second.createdAt);
      }
    });
    return receipts;
  }

  private JSONObject loadServerSettings(String baseUrl) {
    try {
      return new JSONObject(fetchString(baseUrl + "/api/settings"));
    } catch (Exception ignored) {
      return new JSONObject();
    }
  }

  private static int paperWidthDots(JSONObject settings) {
    return settings.optInt("paperWidthMm", 80) >= 76 ? 576 : 384;
  }

  private JSONArray fetchArray(String endpoint) throws Exception {
    return new JSONArray(fetchString(endpoint));
  }

  private JSONObject fetchObject(String endpoint) throws Exception {
    return new JSONObject(fetchString(endpoint));
  }

  private boolean updateReceiptJob(String baseUrl, String action, String id, String deviceId)
      throws Exception {
    JSONObject payload = new JSONObject();
    payload.put("action", action);
    payload.put("id", id);
    payload.put("deviceId", deviceId);
    return postJson(baseUrl + "/api/print-jobs", payload).optBoolean("ok", false);
  }

  private void completeQrJob(String baseUrl, String id) throws Exception {
    JSONObject payload = new JSONObject();
    payload.put("action", "complete");
    payload.put("id", id);
    if (!postJson(baseUrl + "/api/qr-print-jobs", payload).optBoolean("ok", false)) {
      throw new IllegalStateException("ยืนยันงาน QR ไม่สำเร็จ");
    }
  }

  private static String fetchString(String endpoint) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
    connection.setRequestMethod("GET");
    connection.setConnectTimeout(HTTP_TIMEOUT_MS);
    connection.setReadTimeout(HTTP_TIMEOUT_MS);
    connection.setRequestProperty("Accept", "application/json");
    try {
      int status = connection.getResponseCode();
      if (status < 200 || status >= 300) throw new IllegalStateException("HTTP " + status);
      InputStream input = connection.getInputStream();
      try {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        for (int length; (length = input.read(buffer)) != -1;) output.write(buffer, 0, length);
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
      } finally {
        input.close();
      }
    } finally {
      connection.disconnect();
    }
  }

  private static JSONObject postJson(String endpoint, JSONObject payload) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
    connection.setRequestMethod("POST");
    connection.setConnectTimeout(HTTP_TIMEOUT_MS);
    connection.setReadTimeout(HTTP_TIMEOUT_MS);
    connection.setRequestProperty("Accept", "application/json");
    connection.setRequestProperty("Content-Type", "application/json");
    connection.setDoOutput(true);
    try {
      byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
      OutputStream output = connection.getOutputStream();
      try {
        output.write(bytes);
        output.flush();
      } finally {
        output.close();
      }
      int status = connection.getResponseCode();
      InputStream input = status >= 200 && status < 300
          ? connection.getInputStream() : connection.getErrorStream();
      String body = "{}";
      if (input != null) {
        try {
          ByteArrayOutputStream response = new ByteArrayOutputStream();
          byte[] buffer = new byte[4096];
          for (int length; (length = input.read(buffer)) != -1;) response.write(buffer, 0, length);
          body = new String(response.toByteArray(), StandardCharsets.UTF_8);
        } finally {
          input.close();
        }
      }
      if (status < 200 || status >= 300) return new JSONObject(body);
      return new JSONObject(body);
    } finally {
      connection.disconnect();
    }
  }

  private void printInternal(Ticket ticket) throws Exception {
    int status = initialiseInternalPrinter();
    if (status != 0 && status != 8) {
      throw new IllegalStateException("เครื่องพิมพ์ iMin ไม่พร้อม (" + status + ")");
    }
    internalPrinter.setPageFormat(ticket.paperWidthDots >= 500 ? 0 : 1);
    internalPrinter.setAlignment(1);
    internalPrinter.setTextTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
    internalPrinter.setTextStyle(Typeface.NORMAL);
    internalPrinter.setTextSize(26);
    internalPrinter.setTextWidth(ticket.paperWidthDots >= 500 ? 576 : 384);
    internalPrinter.printText(internalTicketText(ticket), 1);
    internalPrinter.printAndFeedPaper(12);
    try {
      internalPrinter.partialCut();
    } catch (Exception ignored) {
      // The receipt has enough feed even on a printer module without a cutter.
    }
  }

  private void printInternalReceipt(Receipt receipt) throws Exception {
    int status = initialiseInternalPrinter();
    if (status != 0 && status != 8) {
      throw new IllegalStateException("เครื่องพิมพ์ iMin ไม่พร้อม (" + status + ")");
    }
    internalPrinter.setPageFormat(receipt.paperWidthDots >= 500 ? 0 : 1);
    internalPrinter.setTextWidth(receipt.paperWidthDots >= 500 ? 576 : 384);
    ReceiptLayout.print(internalPrinter, receipt);
    internalPrinter.printAndFeedPaper(12);
    try {
      internalPrinter.partialCut();
    } catch (Exception ignored) {
      // A fed receipt remains usable on a D4 module without a cutter.
    }
  }

  private void printInternalQr(QueuedQr job) throws Exception {
    int status = initialiseInternalPrinter();
    if (status != 0 && status != 8) {
      throw new IllegalStateException("เครื่องพิมพ์ iMin ไม่พร้อม (" + status + ")");
    }
    internalPrinter.setPageFormat(0);
    internalPrinter.setTextWidth(576);
    internalPrinter.setAlignment(1);
    internalPrinter.setTextTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
    internalPrinter.setTextStyle(Typeface.BOLD);
    internalPrinter.setTextSize(30);
    internalPrinter.printText(value(preferences.getString("shopName", "จิ๊นโค"), "จิ๊นโค") + "\n", 1);
    internalPrinter.setTextSize(46);
    internalPrinter.printText("โต๊ะ " + job.table + "\n", 1);
    internalPrinter.setTextStyle(Typeface.NORMAL);
    internalPrinter.setQrCodeSize(8);
    internalPrinter.printQrCode(job.url, 1);
    internalPrinter.setTextSize(24);
    internalPrinter.printText("\nสแกนเพื่อสั่งอาหาร\n\n", 1);
    internalPrinter.printAndFeedPaper(12);
    try {
      internalPrinter.partialCut();
    } catch (Exception ignored) {
      // Receipt feed is still enough on devices without a cutter.
    }
  }

  private int initialiseInternalPrinter() throws InterruptedException {
    if (internalPrinter == null) internalPrinter = IminPrintUtils.getInstance(getApplicationContext());
    if (!internalPrinterInitialized) {
      internalPrinter.initPrinter(IminPrintUtils.PrintConnectType.USB);
      Thread.sleep(250);
      internalPrinterInitialized = true;
    }
    return internalPrinter.getPrinterStatus(IminPrintUtils.PrintConnectType.USB);
  }

  private static String internalTicketText(Ticket ticket) {
    StringBuilder text = new StringBuilder();
    text.append(ticket.shopName).append('\n');
    text.append(ticket.station).append('\n');
    text.append(divider(ticket)).append('\n');
    text.append("โต๊ะ ").append(ticket.table).append('\n');
    if (!ticket.createdAt.trim().isEmpty()) text.append(ticket.createdAt).append('\n');
    text.append(divider(ticket)).append('\n');
    for (Ticket.Item item : ticket.items) {
      String name = value(item.name, "รายการ");
      String quantity = "x" + Math.max(1, item.qty);
      int desiredGap = ticket.paperWidthDots >= 500 ? 32 : 12;
      int byteBudget = ticket.paperWidthDots >= 500 ? 62 : 34;
      int availableGap = byteBudget - utf8Bytes(name) - utf8Bytes(quantity);
      text.append(name).append(repeat(' ', Math.max(2, Math.min(desiredGap, availableGap))))
          .append(quantity).append('\n');
    }
    if (!ticket.note.trim().isEmpty()) {
      text.append(divider(ticket)).append('\n').append("หมายเหตุ: ").append(ticket.note).append('\n');
    }
    return text.append("\n\n\n").toString();
  }

  private void printNetwork(Ticket ticket, String host, int port) throws Exception {
    if (host == null || host.trim().isEmpty() || host.contains(" ")) {
      throw new IllegalArgumentException("ยังไม่ได้ตั้ง IP เครื่องพิมพ์ครัว");
    }
    List<Bitmap> slices = TicketRenderer.renderSlices(ticket);
    try {
      byte[] bytes = EscPos.ticket(slices, true);
      Socket socket = new Socket();
      try {
        socket.connect(new InetSocketAddress(host.trim(), port), CONNECT_TIMEOUT_MS);
        OutputStream output = socket.getOutputStream();
        output.write(bytes);
        output.flush();
      } finally {
        socket.close();
      }
    } finally {
      for (Bitmap slice : slices) if (!slice.isRecycled()) slice.recycle();
    }
  }

  /**
   * Dispatches the counter/drinks ticket according to the "printerMode" setting instead of always
   * assuming iMin USB hardware — mirrors IminPrinterModule#printInternal/printNetwork/printBluetooth
   * so a backgrounded poll behaves identically to a foreground print.
   */
  private void printCounterTicket(Ticket ticket, String printerMode) throws Exception {
    if ("network".equals(printerMode)) {
      printNetwork(ticket,
          preferences.getString("counterHost", ""),
          Math.max(1, Math.min(65535, preferences.getInt("counterPort", 9100))));
    } else if ("bluetooth".equals(printerMode)) {
      printBluetoothTicket(ticket, preferences.getString("bluetoothAddress", ""));
    } else {
      printInternal(ticket);
    }
  }

  /** Receipt counterpart of {@link #printCounterTicket}. */
  private void printCounterReceipt(Receipt receipt, String printerMode) throws Exception {
    if ("network".equals(printerMode)) {
      printReceiptNetwork(receipt,
          preferences.getString("counterHost", ""),
          Math.max(1, Math.min(65535, preferences.getInt("counterPort", 9100))));
    } else if ("bluetooth".equals(printerMode)) {
      printBluetoothReceipt(receipt, preferences.getString("bluetoothAddress", ""));
    } else {
      printInternalReceipt(receipt);
    }
  }

  private void printReceiptNetwork(Receipt receipt, String host, int port) throws Exception {
    if (host == null || host.trim().isEmpty() || host.contains(" ")) {
      throw new IllegalArgumentException("ยังไม่ได้ตั้ง IP เครื่องพิมพ์เคาน์เตอร์");
    }
    List<Bitmap> slices = ReceiptRenderer.renderSlices(receipt);
    try {
      byte[] bytes = EscPos.ticket(slices, true);
      Socket socket = new Socket();
      try {
        socket.connect(new InetSocketAddress(host.trim(), port), CONNECT_TIMEOUT_MS);
        OutputStream output = socket.getOutputStream();
        output.write(bytes);
        output.flush();
      } finally {
        socket.close();
      }
    } finally {
      for (Bitmap slice : slices) if (!slice.isRecycled()) slice.recycle();
    }
  }

  private void printBluetoothTicket(Ticket ticket, String address) throws Exception {
    List<Bitmap> slices = TicketRenderer.renderSlices(ticket);
    BluetoothSocket socket = null;
    try {
      byte[] bytes = EscPos.ticket(slices, true);
      socket = openBluetoothSocket(address);
      socket.getOutputStream().write(bytes);
      socket.getOutputStream().flush();
    } finally {
      for (Bitmap slice : slices) if (!slice.isRecycled()) slice.recycle();
      closeQuietly(socket);
    }
  }

  private void printBluetoothReceipt(Receipt receipt, String address) throws Exception {
    List<Bitmap> slices = ReceiptRenderer.renderSlices(receipt);
    BluetoothSocket socket = null;
    try {
      byte[] bytes = EscPos.ticket(slices, true);
      socket = openBluetoothSocket(address);
      socket.getOutputStream().write(bytes);
      socket.getOutputStream().flush();
    } finally {
      for (Bitmap slice : slices) if (!slice.isRecycled()) slice.recycle();
      closeQuietly(socket);
    }
  }

  /**
   * Same insecure-then-secure RFCOMM fallback as IminPrinterModule#openBluetoothSocket — most
   * generic ESC/POS Bluetooth printers only expose an unauthenticated SPP service.
   */
  private BluetoothSocket openBluetoothSocket(String address) throws Exception {
    if (address == null || address.trim().isEmpty()) {
      throw new IllegalArgumentException("ยังไม่ได้เลือกเครื่องพิมพ์ Bluetooth ในหน้าตั้งค่า");
    }
    BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
    if (adapter == null) throw new IllegalStateException("อุปกรณ์นี้ไม่มี Bluetooth");
    if (!BluetoothAdapter.checkBluetoothAddress(address.trim())) {
      throw new IllegalArgumentException("ที่อยู่เครื่องพิมพ์ Bluetooth ไม่ถูกต้อง");
    }
    BluetoothDevice device = adapter.getRemoteDevice(address.trim());
    try {
      adapter.cancelDiscovery();
    } catch (SecurityException ignored) {
      // Best-effort; missing BLUETOOTH_SCAN on some OEM builds should not block printing.
    }
    Exception lastError;
    try {
      BluetoothSocket insecure = device.createInsecureRfcommSocketToServiceRecord(SPP_UUID);
      insecure.connect();
      return insecure;
    } catch (Exception insecureError) {
      lastError = insecureError;
    }
    try {
      BluetoothSocket secure = device.createRfcommSocketToServiceRecord(SPP_UUID);
      secure.connect();
      return secure;
    } catch (Exception secureError) {
      throw new IllegalStateException(
          "เชื่อมต่อเครื่องพิมพ์ Bluetooth ไม่สำเร็จ: " + secureError.getMessage(), lastError);
    }
  }

  private static void closeQuietly(BluetoothSocket socket) {
    if (socket == null) return;
    try {
      socket.close();
    } catch (Exception ignored) {
      // Best-effort cleanup; the print bytes were already flushed (or the connection never opened).
    }
  }

  private Notification buildNotification(String message) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Jinko Print Bridge",
          NotificationManager.IMPORTANCE_LOW);
      channel.setDescription("ตรวจออเดอร์และพิมพ์ระหว่างใช้งานแอปอื่น");
      ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(channel);
    }
    Intent openBridge = new Intent(this, MainActivity.class)
        .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
    PendingIntent contentIntent = PendingIntent.getActivity(this, 0, openBridge, flags);
    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
    return builder
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle("Jinko Print Bridge ทำงานอยู่")
        .setContentText(message)
        .setContentIntent(contentIntent)
        .setCategory(Notification.CATEGORY_SERVICE)
        .setPriority(Notification.PRIORITY_LOW)
        .setOngoing(true)
        .build();
  }

  private void updateNotification(String message) {
    ((NotificationManager) getSystemService(NOTIFICATION_SERVICE))
        .notify(NOTIFICATION_ID, buildNotification(message));
  }

  private static String normaliseBaseUrl(String value) {
    return value(value, "https://jinko-order.vercel.app").replaceAll("/+\\z", "");
  }

  private static String text(JSONObject object, String key, String fallback) {
    Object raw = object.opt(key);
    return raw == null || raw == JSONObject.NULL ? fallback : String.valueOf(raw);
  }

  private static boolean flag(JSONObject object, String key, boolean fallback) {
    Object raw = object.opt(key);
    if (raw instanceof Boolean) return (Boolean) raw;
    if (raw instanceof String) return Boolean.parseBoolean((String) raw);
    return fallback;
  }

  private static int number(JSONObject object, String key, int fallback) {
    Object raw = object.opt(key);
    if (raw instanceof Number) return Math.max(1, ((Number) raw).intValue());
    try {
      return Math.max(1, Integer.parseInt(String.valueOf(raw)));
    } catch (Exception ignored) {
      return fallback;
    }
  }

  private static double decimal(JSONObject object, String key, double fallback) {
    Object raw = object.opt(key);
    if (raw instanceof Number) return ((Number) raw).doubleValue();
    try {
      return Double.parseDouble(String.valueOf(raw));
    } catch (Exception ignored) {
      return fallback;
    }
  }

  private static String value(String input, String fallback) {
    return input == null || input.trim().isEmpty() ? fallback : input.trim();
  }

  private static String divider(Ticket ticket) {
    return repeat('-', ticket.paperWidthDots >= 500 ? 68 : 30);
  }

  private static String formatBaht(double amount) {
    return String.format(Locale.US, "%,.0f", Math.max(0, amount));
  }

  private static String repeat(char character, int count) {
    StringBuilder result = new StringBuilder(Math.max(0, count));
    for (int index = 0; index < count; index++) result.append(character);
    return result.toString();
  }

  private static int utf8Bytes(String value) {
    return value.getBytes(StandardCharsets.UTF_8).length;
  }

  /**
   * The API may serialise Firebase Timestamp as {_seconds, _nanoseconds}.  Convert it at the
   * native boundary so both the foreground React screen and this background worker produce the
   * same readable date, never the JSON object visible on a thermal ticket.
   */
  private static Date timestampDate(Object raw) {
    if (raw == null || raw == JSONObject.NULL) return null;
    if (raw instanceof JSONObject) {
      JSONObject timestamp = (JSONObject) raw;
      Object secondsValue = timestamp.has("_seconds") ? timestamp.opt("_seconds")
          : timestamp.opt("seconds");
      Long seconds = longValue(secondsValue);
      if (seconds == null) return null;
      Object nanosValue = timestamp.has("_nanoseconds") ? timestamp.opt("_nanoseconds")
          : timestamp.opt("nanoseconds");
      Long nanoseconds = longValue(nanosValue);
      return new Date(seconds * 1000L + (nanoseconds == null ? 0L : nanoseconds / 1_000_000L));
    }
    if (raw instanceof Number) {
      long value = ((Number) raw).longValue();
      return new Date(Math.abs(value) < 100_000_000_000L ? value * 1000L : value);
    }
    String input = String.valueOf(raw).trim();
    if (input.isEmpty()) return null;
    Long numeric = longValue(input);
    if (numeric != null) {
      return new Date(Math.abs(numeric) < 100_000_000_000L ? numeric * 1000L : numeric);
    }
    String[] patterns = new String[] {
        "yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX",
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'"
    };
    for (String pattern : patterns) {
      try {
        SimpleDateFormat parser = new SimpleDateFormat(pattern, Locale.US);
        parser.setLenient(false);
        if (pattern.endsWith("'Z'")) parser.setTimeZone(TimeZone.getTimeZone("UTC"));
        Date parsed = parser.parse(input);
        if (parsed != null) return parsed;
      } catch (ParseException ignored) {
        // Try the next ISO-8601 variation produced by the order server.
      }
    }
    return null;
  }

  private static Long longValue(Object value) {
    if (value == null || value == JSONObject.NULL) return null;
    if (value instanceof Number) return ((Number) value).longValue();
    try {
      return Long.parseLong(String.valueOf(value).trim());
    } catch (Exception ignored) {
      return null;
    }
  }

  private static String formatTime(Object raw) {
    Date parsed = timestampDate(raw);
    if (parsed == null) return "";
    SimpleDateFormat formatter = new SimpleDateFormat("dd/MM HH:mm", new Locale("th", "TH"));
    formatter.setTimeZone(BANGKOK);
    return formatter.format(parsed);
  }

  /** Canonical UTC value for receipt renderers that lay out date and time separately. */
  private static String timestampIso(Object raw) {
    Date parsed = timestampDate(raw);
    if (parsed == null) return "";
    SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
    formatter.setTimeZone(TimeZone.getTimeZone("UTC"));
    return formatter.format(parsed);
  }

  private static String timestampSortKey(Object raw) {
    Date parsed = timestampDate(raw);
    return parsed == null ? "" : String.format(Locale.US, "%019d", parsed.getTime());
  }

  private String deviceId() {
    String existing = preferences.getString("deviceId", null);
    if (existing != null && existing.trim().length() >= 8) return existing;
    String created = "imin-" + UUID.randomUUID().toString();
    preferences.edit().putString("deviceId", created).apply();
    return created;
  }

  private static String message(Exception error) {
    return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
  }

  private static final class QueuedTicket {
    final String key;
    final boolean internal;
    final Ticket ticket;
    final String createdAt;

    QueuedTicket(String key, boolean internal, Ticket ticket, String createdAt) {
      this.key = key;
      this.internal = internal;
      this.ticket = ticket;
      this.createdAt = createdAt;
    }
  }

  private static final class QueuedReceipt {
    final String key;
    final Receipt receipt;
    final String createdAt;

    QueuedReceipt(String key, Receipt receipt, String createdAt) {
      this.key = key;
      this.receipt = receipt;
      this.createdAt = createdAt;
    }
  }

  private static final class QueuedQr {
    final String key;
    final String id;
    final String table;
    final String url;

    QueuedQr(String key, String id, String table, String url) {
      this.key = key;
      this.id = id;
      this.table = table;
      this.url = url;
    }
  }
}
