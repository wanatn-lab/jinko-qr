package com.jinko.printbridge;

import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.ReadableType;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.PermissionAwareActivity;
import com.facebook.react.modules.core.PermissionListener;
import com.imin.printerlib.IminPrintUtils;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Single native bridge for both printer paths.
 *
 * The iMin SDK calls stay off React's UI thread and a single executor keeps tickets in order.
 * The LAN path deliberately sends a bitmap encoded as ESC/POS bit-image data so Thai shaping
 * does not depend on the printer's built-in text font.
 */
public final class IminPrinterModule extends ReactContextBaseJavaModule {
  private static final String MODULE_NAME = "IminPrinter";
  private static final String BOOTSTRAP_COMPLETE = "bootstrap_complete";
  private static final int CONNECT_TIMEOUT_MS = 4000;
  // Standard Serial Port Profile UUID used by essentially every ESC/POS Bluetooth thermal
  // printer on the market, regardless of brand — this is what lets "bluetooth" mode work on
  // POS hardware that has no vendor SDK at all.
  private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
  private static final int BLUETOOTH_PERMISSION_REQUEST_CODE = 8241;

  private final SharedPreferences preferences;
  private final ExecutorService printExecutor = Executors.newSingleThreadExecutor();
  private IminPrintUtils internalPrinter;
  private boolean internalPrinterInitialized;

  IminPrinterModule(ReactApplicationContext context) {
    super(context);
    preferences = context.getSharedPreferences(PrintHistory.PREFS, 0);
  }

  @NonNull
  @Override
  public String getName() {
    return MODULE_NAME;
  }

  @ReactMethod
  public void getSettings(Promise promise) {
    promise.resolve(settingsMap());
  }

  @ReactMethod
  public void saveSettings(ReadableMap settings, Promise promise) {
    SharedPreferences.Editor edit = preferences.edit();
    saveString(edit, settings, "apiBaseUrl", "https://jinko-order.vercel.app");
    saveString(edit, settings, "shopName", "จิ๊นโค");
    saveString(edit, settings, "drinkCategory", "เครื่องดื่ม");
    saveString(edit, settings, "kitchenHost", "192.168.1.242");
    saveInt(edit, settings, "kitchenPort", 9100);
    saveInt(edit, settings, "pollSeconds", 6);
    saveBoolean(edit, settings, "autoPrint", true);
    saveBoolean(edit, settings, "skipExistingOnFirstSync", true);
    // เครื่องพิมพ์เคาน์เตอร์/ใบเสร็จ — เดิมผูกกับ iMin USB SDK เสมอ ("imin") ตอนนี้เลือกได้เพิ่มว่า
    // จะพิมพ์ผ่าน ESC/POS มาตรฐานกลางแทน ไม่ว่าจะเป็นเครื่องพิมพ์ที่ต่อ LAN ("network", ใช้ตรรกะ
    // เดียวกับเครื่องพิมพ์ครัวที่มีอยู่แล้ว) หรือเครื่องพิมพ์แบบพกพา/แท็บเล็ตทั่วไปที่ต่อผ่าน
    // Bluetooth ("bluetooth") — ทำให้แอปตัวเดียวกันนี้รองรับเครื่อง POS ยี่ห้ออื่นที่ไม่มี iMin SDK ได้
    saveString(edit, settings, "printerMode", "imin");
    saveString(edit, settings, "counterHost", "");
    saveInt(edit, settings, "counterPort", 9100);
    saveString(edit, settings, "bluetoothAddress", "");
    saveString(edit, settings, "bluetoothName", "");
    edit.apply();
    promise.resolve(settingsMap());
  }

  @ReactMethod
  public void getDeviceId(Promise promise) {
    String deviceId = preferences.getString("deviceId", null);
    if (deviceId == null || deviceId.trim().isEmpty()) {
      deviceId = "imin-" + UUID.randomUUID().toString();
      preferences.edit().putString("deviceId", deviceId).apply();
    }
    promise.resolve(deviceId);
  }

  @ReactMethod
  public void getDeviceName(Promise promise) {
    String manufacturer = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
    String model = Build.MODEL == null ? "Android device" : Build.MODEL.trim();
    promise.resolve((manufacturer + " " + model).trim());
  }

  @ReactMethod
  public void getPrintedKeys(Promise promise) {
    WritableArray result = Arguments.createArray();
    for (String key : PrintHistory.getPrintedKeys(preferences)) result.pushString(key);
    promise.resolve(result);
  }

  @ReactMethod
  public void markPrinted(String key, Promise promise) {
    PrintHistory.markPrinted(preferences, key);
    promise.resolve(null);
  }

  @ReactMethod
  public void clearPrintedKeys(Promise promise) {
    PrintHistory.clear(preferences);
    promise.resolve(null);
  }

  @ReactMethod
  public void claimPrint(String key, Promise promise) {
    promise.resolve(PrintHistory.claim(preferences, key));
  }

  @ReactMethod
  public void releasePrint(String key, Promise promise) {
    PrintHistory.release(preferences, key);
    promise.resolve(null);
  }

  @ReactMethod
  public void hasCompletedBootstrap(Promise promise) {
    promise.resolve(preferences.getBoolean(BOOTSTRAP_COMPLETE, false));
  }

  @ReactMethod
  public void markBootstrapCompleted(Promise promise) {
    preferences.edit().putBoolean(BOOTSTRAP_COMPLETE, true).apply();
    promise.resolve(null);
  }

  @ReactMethod
  public void getInternalPrinterStatus(Promise promise) {
    printExecutor.execute(() -> {
      try {
        int status = initializeAndGetInternalStatus();
        WritableMap result = Arguments.createMap();
        result.putInt("code", status);
        result.putString("message", printerStatusMessage(status));
        result.putBoolean("ready", status == 0 || status == 8);
        promise.resolve(result);
      } catch (Exception error) {
        promise.reject("IMIN_STATUS", error.getMessage(), error);
      }
    });
  }

  @ReactMethod
  public void printInternal(ReadableMap rawTicket, Promise promise) {
    printExecutor.execute(() -> {
      try {
        int status = initializeAndGetInternalStatus();
        if (status != 0 && status != 8) {
          throw new IllegalStateException("เครื่องพิมพ์ iMin ไม่พร้อม: " + printerStatusMessage(status));
        }
        printInternalTicket(readTicket(rawTicket));
        promise.resolve(printResult("internal"));
      } catch (Exception error) {
        promise.reject("IMIN_PRINT", error.getMessage(), error);
      }
    });
  }

  @ReactMethod
  public void printReceipt(ReadableMap rawReceipt, Promise promise) {
    printExecutor.execute(() -> {
      try {
        int status = initializeAndGetInternalStatus();
        if (status != 0 && status != 8) {
          throw new IllegalStateException("เครื่องพิมพ์ iMin ไม่พร้อม: " + printerStatusMessage(status));
        }
        printInternalReceipt(readReceipt(rawReceipt));
        promise.resolve(printResult("receipt"));
      } catch (Exception error) {
        promise.reject("IMIN_RECEIPT", error.getMessage(), error);
      }
    });
  }

  @ReactMethod
  public void printNetwork(ReadableMap rawTicket, String host, int port, boolean cut, Promise promise) {
    printExecutor.execute(() -> {
      try {
        if (host == null || host.trim().isEmpty() || host.contains(" ")) {
          throw new IllegalArgumentException("กรอก IP หรือ hostname ของเครื่องพิมพ์ครัว");
        }
        if (port < 1 || port > 65535) throw new IllegalArgumentException("พอร์ตเครื่องพิมพ์ไม่ถูกต้อง");

        Ticket ticket = readTicket(rawTicket, 576);
        List<Bitmap> slices = TicketRenderer.renderSlices(ticket);
        try {
          // The GE801PN's font puts Thai vowel/tone marks in the wrong position even after
          // code-page selection.  ESC * bit images preserve Android's Thai shaping and each
          // slice remains well below its documented image-buffer limit.
          byte[] bytes = EscPos.ticket(slices, cut);
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
          for (Bitmap slice : slices) {
            if (!slice.isRecycled()) slice.recycle();
          }
        }
        promise.resolve(printResult("network"));
      } catch (Exception error) {
        promise.reject("NETWORK_PRINT", error.getMessage(), error);
      }
    });
  }

  @ReactMethod
  public void printReceiptNetwork(ReadableMap rawReceipt, String host, int port, boolean cut, Promise promise) {
    printExecutor.execute(() -> {
      try {
        if (host == null || host.trim().isEmpty() || host.contains(" ")) {
          throw new IllegalArgumentException("กรอก IP หรือ hostname ของเครื่องพิมพ์เคาน์เตอร์");
        }
        if (port < 1 || port > 65535) throw new IllegalArgumentException("พอร์ตเครื่องพิมพ์ไม่ถูกต้อง");

        Receipt receipt = readReceipt(rawReceipt);
        List<Bitmap> slices = ReceiptRenderer.renderSlices(receipt);
        try {
          byte[] bytes = EscPos.ticket(slices, cut);
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
          for (Bitmap slice : slices) {
            if (!slice.isRecycled()) slice.recycle();
          }
        }
        promise.resolve(printResult("network"));
      } catch (Exception error) {
        promise.reject("NETWORK_RECEIPT", error.getMessage(), error);
      }
    });
  }

  /**
   * Android 12+ (API 31) requires BLUETOOTH_CONNECT/BLUETOOTH_SCAN to be requested at runtime.
   * Pre-31 devices already hold the normal (auto-granted) BLUETOOTH/BLUETOOTH_ADMIN permissions
   * declared in the manifest, so this resolves immediately without prompting.
   */
  @ReactMethod
  public void ensureBluetoothPermission(Promise promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      promise.resolve(true);
      return;
    }
    Activity activity = getCurrentActivity();
    if (!(activity instanceof PermissionAwareActivity)) {
      promise.reject("NO_ACTIVITY", "ไม่พบหน้าจอแอปสำหรับขอสิทธิ์ Bluetooth");
      return;
    }
    if (ContextCompat.checkSelfPermission(getReactApplicationContext(),
        android.Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED) {
      promise.resolve(true);
      return;
    }
    ((PermissionAwareActivity) activity).requestPermissions(
        new String[]{android.Manifest.permission.BLUETOOTH_CONNECT, android.Manifest.permission.BLUETOOTH_SCAN},
        BLUETOOTH_PERMISSION_REQUEST_CODE,
        (PermissionListener) (requestCode, permissions, grantResults) -> {
          if (requestCode != BLUETOOTH_PERMISSION_REQUEST_CODE) return false;
          boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
          promise.resolve(granted);
          return true;
        });
  }

  /**
   * Lists already-paired (bonded) Bluetooth devices so the settings screen can offer a picker
   * instead of asking the owner to type a MAC address. Discovery/scanning for unpaired devices
   * is deliberately not implemented — pairing stays in Android's own Bluetooth settings, which
   * already handles PIN entry for the wide variety of cheap ESC/POS printers in the field.
   */
  @ReactMethod
  public void getPairedBluetoothPrinters(Promise promise) {
    try {
      BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
      if (adapter == null) {
        promise.resolve(Arguments.createArray());
        return;
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
          && ContextCompat.checkSelfPermission(getReactApplicationContext(),
              android.Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
        promise.reject("BLUETOOTH_PERMISSION", "ยังไม่ได้รับสิทธิ์ Bluetooth");
        return;
      }
      Set<BluetoothDevice> bonded = adapter.getBondedDevices();
      WritableArray result = Arguments.createArray();
      for (BluetoothDevice device : bonded) {
        WritableMap item = Arguments.createMap();
        item.putString("name", device.getName() != null ? device.getName() : device.getAddress());
        item.putString("address", device.getAddress());
        result.pushMap(item);
      }
      promise.resolve(result);
    } catch (SecurityException error) {
      promise.reject("BLUETOOTH_PERMISSION", error.getMessage(), error);
    }
  }

  @ReactMethod
  public void printBluetooth(ReadableMap rawTicket, String address, boolean cut, Promise promise) {
    printExecutor.execute(() -> {
      BluetoothSocket socket = null;
      List<Bitmap> slices = null;
      try {
        Ticket ticket = readTicket(rawTicket, 576);
        slices = TicketRenderer.renderSlices(ticket);
        byte[] bytes = EscPos.ticket(slices, cut);
        socket = openBluetoothSocket(address);
        socket.getOutputStream().write(bytes);
        socket.getOutputStream().flush();
        promise.resolve(printResult("bluetooth"));
      } catch (Exception error) {
        promise.reject("BLUETOOTH_PRINT", error.getMessage(), error);
      } finally {
        if (slices != null) {
          for (Bitmap slice : slices) {
            if (!slice.isRecycled()) slice.recycle();
          }
        }
        closeQuietly(socket);
      }
    });
  }

  @ReactMethod
  public void printReceiptBluetooth(ReadableMap rawReceipt, String address, boolean cut, Promise promise) {
    printExecutor.execute(() -> {
      BluetoothSocket socket = null;
      List<Bitmap> slices = null;
      try {
        Receipt receipt = readReceipt(rawReceipt);
        slices = ReceiptRenderer.renderSlices(receipt);
        byte[] bytes = EscPos.ticket(slices, cut);
        socket = openBluetoothSocket(address);
        socket.getOutputStream().write(bytes);
        socket.getOutputStream().flush();
        promise.resolve(printResult("bluetooth"));
      } catch (Exception error) {
        promise.reject("BLUETOOTH_RECEIPT", error.getMessage(), error);
      } finally {
        if (slices != null) {
          for (Bitmap slice : slices) {
            if (!slice.isRecycled()) slice.recycle();
          }
        }
        closeQuietly(socket);
      }
    });
  }

  /**
   * Tries the insecure (no-PIN) RFCOMM channel first because the vast majority of generic
   * ESC/POS thermal printers only expose an unauthenticated SPP service; falls back to the
   * secure channel for the smaller set of printers that require pairing-level authentication.
   */
  private BluetoothSocket openBluetoothSocket(String address) throws IOException {
    if (address == null || address.trim().isEmpty()) {
      throw new IllegalArgumentException("ยังไม่ได้เลือกเครื่องพิมพ์ Bluetooth ในหน้าตั้งค่า");
    }
    BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
    if (adapter == null) throw new IOException("อุปกรณ์นี้ไม่มี Bluetooth");
    if (!BluetoothAdapter.checkBluetoothAddress(address.trim())) {
      throw new IllegalArgumentException("ที่อยู่เครื่องพิมพ์ Bluetooth ไม่ถูกต้อง");
    }
    BluetoothDevice device = adapter.getRemoteDevice(address.trim());
    try {
      adapter.cancelDiscovery();
    } catch (SecurityException ignored) {
      // Missing BLUETOOTH_SCAN on some OEM builds; discovery cancellation is best-effort only.
    }
    IOException lastError;
    try {
      BluetoothSocket insecure = device.createInsecureRfcommSocketToServiceRecord(SPP_UUID);
      insecure.connect();
      return insecure;
    } catch (IOException insecureError) {
      lastError = insecureError;
    } catch (SecurityException permissionError) {
      throw new IOException("ไม่มีสิทธิ์เชื่อมต่อ Bluetooth: " + permissionError.getMessage());
    }
    try {
      BluetoothSocket secure = device.createRfcommSocketToServiceRecord(SPP_UUID);
      secure.connect();
      return secure;
    } catch (IOException secureError) {
      throw new IOException("เชื่อมต่อเครื่องพิมพ์ Bluetooth ไม่สำเร็จ: " + secureError.getMessage(), lastError);
    } catch (SecurityException permissionError) {
      throw new IOException("ไม่มีสิทธิ์เชื่อมต่อ Bluetooth: " + permissionError.getMessage());
    }
  }

  private static void closeQuietly(BluetoothSocket socket) {
    if (socket == null) return;
    try {
      socket.close();
    } catch (IOException ignored) {
      // Best-effort cleanup; the print bytes were already flushed (or the connection never opened).
    }
  }

  /**
   * Text is the reliable D4 path.  Keep the entire ticket in one printer-service job: on this
   * Android 7 D4, table rows can otherwise arrive after the following cutter command.
   */
  private void printInternalTicket(Ticket ticket) {
    internalPrinter.setPageFormat(ticket.paperWidthDots >= 500 ? 0 : 1);
    // The D4's printable area is narrower than the nominal 80 mm roll.  Centering each native
    // text line keeps the complete ticket visually centred without relying on clipped padding.
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
      // Some D4 printer modules have no cutter; the ticket remains usable.
    }
  }

  /**
   * Keep a receipt in one native text job as well.  On the D4, using a single printText call is
   * significantly more reliable than mixing columns, bitmaps, and a cutter command.
   */
  private void printInternalReceipt(Receipt receipt) {
    internalPrinter.setPageFormat(receipt.paperWidthDots >= 500 ? 0 : 1);
    internalPrinter.setTextWidth(receipt.paperWidthDots >= 500 ? 576 : 384);
    ReceiptLayout.print(internalPrinter, receipt);
    internalPrinter.printAndFeedPaper(12);
    try {
      internalPrinter.partialCut();
    } catch (Exception ignored) {
      // Some D4 printer modules have no cutter; the feed still separates the receipt.
    }
  }

  private static String internalTicketText(Ticket ticket) {
    StringBuilder text = new StringBuilder();
    text.append(ticket.shopName).append('\n');
    text.append(ticket.station).append('\n');
    text.append(internalDivider(ticket)).append('\n');
    text.append("โต๊ะ ").append(ticket.table).append('\n');
    if (!ticket.createdAt.trim().isEmpty()) text.append(ticket.createdAt).append('\n');
    text.append(internalDivider(ticket)).append('\n');
    for (Ticket.Item item : ticket.items) {
      text.append(internalItemLine(item, ticket)).append('\n');
    }
    if (!ticket.note.trim().isEmpty()) {
      text.append(internalDivider(ticket)).append('\n');
      text.append("หมายเหตุ: ").append(ticket.note).append('\n');
    }
    // Feed inside the same job so the cutter cannot overtake part of the ticket.
    return text.append("\n\n\n").toString();
  }

  private static String internalItemLine(Ticket.Item item, Ticket ticket) {
    String name = item.name == null || item.name.trim().isEmpty() ? "รายการ" : item.name.trim();
    String quantity = "x" + Math.max(1, item.qty);
    // D4's Android 7 text service clips a long UTF-8 row before the final quantity.  A compact
    // gap retains both values reliably; long menu names still wrap in the native print service.
    int desiredGap = ticket.paperWidthDots >= 500 ? 32 : 12;
    // The D4 service truncates a UTF-8 row around 64 bytes.  Preserve enough room for the
    // quantity even when a menu name is long, while widening ordinary 80 mm tickets markedly.
    int byteBudget = ticket.paperWidthDots >= 500 ? 62 : 34;
    int availableGap = byteBudget - utf8Bytes(name) - utf8Bytes(quantity);
    return name + repeat(' ', Math.max(2, Math.min(desiredGap, availableGap))) + quantity;
  }

  private static int utf8Bytes(String value) {
    return value.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
  }

  private static String internalDivider(Ticket ticket) {
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

  private int initializeAndGetInternalStatus() throws InterruptedException {
    if (internalPrinter == null) {
      internalPrinter = IminPrintUtils.getInstance(getReactApplicationContext());
    }
    // initPrinter() clears iMin's pending print queue.  Calling it for every status refresh
    // cut long tickets midway through their item list on D4, so initialise exactly once.
    if (!internalPrinterInitialized) {
      internalPrinter.initPrinter(IminPrintUtils.PrintConnectType.USB);
      // D4's USB printer service can report -1 immediately after initialization.
      Thread.sleep(250);
      internalPrinterInitialized = true;
    }
    return internalPrinter.getPrinterStatus(IminPrintUtils.PrintConnectType.USB);
  }

  private WritableMap settingsMap() {
    WritableMap settings = Arguments.createMap();
    settings.putString("apiBaseUrl", preferences.getString("apiBaseUrl", "https://jinko-order.vercel.app"));
    settings.putString("shopName", preferences.getString("shopName", "จิ๊นโค"));
    settings.putString("drinkCategory", preferences.getString("drinkCategory", "เครื่องดื่ม"));
    settings.putString("kitchenHost", preferences.getString("kitchenHost", "192.168.1.242"));
    settings.putInt("kitchenPort", preferences.getInt("kitchenPort", 9100));
    settings.putInt("pollSeconds", preferences.getInt("pollSeconds", 6));
    settings.putBoolean("autoPrint", preferences.getBoolean("autoPrint", true));
    settings.putBoolean("skipExistingOnFirstSync", preferences.getBoolean("skipExistingOnFirstSync", true));
    settings.putString("printerMode", preferences.getString("printerMode", "imin"));
    settings.putString("counterHost", preferences.getString("counterHost", ""));
    settings.putInt("counterPort", preferences.getInt("counterPort", 9100));
    settings.putString("bluetoothAddress", preferences.getString("bluetoothAddress", ""));
    settings.putString("bluetoothName", preferences.getString("bluetoothName", ""));
    return settings;
  }

  private void saveString(SharedPreferences.Editor edit, ReadableMap settings, String key, String fallback) {
    String value = fallback;
    if (settings.hasKey(key) && !settings.isNull(key) && settings.getType(key) == ReadableType.String) {
      value = settings.getString(key);
    }
    edit.putString(key, value == null ? fallback : value.trim());
  }

  private void saveInt(SharedPreferences.Editor edit, ReadableMap settings, String key, int fallback) {
    int value = fallback;
    if (settings.hasKey(key) && !settings.isNull(key) && settings.getType(key) == ReadableType.Number) {
      value = settings.getInt(key);
    }
    edit.putInt(key, value);
  }

  private void saveBoolean(SharedPreferences.Editor edit, ReadableMap settings, String key, boolean fallback) {
    boolean value = fallback;
    if (settings.hasKey(key) && !settings.isNull(key) && settings.getType(key) == ReadableType.Boolean) {
      value = settings.getBoolean(key);
    }
    edit.putBoolean(key, value);
  }

  private Ticket readTicket(ReadableMap input) {
    return readTicket(input, 576);
  }

  private Receipt readReceipt(ReadableMap input) {
    String id = string(input, "id", "receipt");
    String shopName = string(input, "shopName", "จิ๊นโค");
    ReadableMap receiptConfig = input.hasKey("receiptConfig") && !input.isNull("receiptConfig")
        && input.getType("receiptConfig") == ReadableType.Map ? input.getMap("receiptConfig") : null;
    String phone = receiptConfig == null ? string(input, "phone", "")
        : string(receiptConfig, "shopPhone", string(input, "phone", ""));
    String table = string(input, "table", "-");
    String createdAt = string(input, "createdAt", "");
    int paperWidthDots = Math.max(384, number(input, "paperWidthDots", 576));
    List<Receipt.Item> items = new ArrayList<>();
    double total = 0;
    if (input.hasKey("items") && !input.isNull("items") && input.getType("items") == ReadableType.Array) {
      ReadableArray rawItems = input.getArray("items");
      for (int index = 0; index < rawItems.size(); index++) {
        if (rawItems.getType(index) != ReadableType.Map) continue;
        ReadableMap item = rawItems.getMap(index);
        int qty = number(item, "qty", 1);
        double lineTotal = decimal(item, "lineTotal", decimal(item, "price", 0) * qty);
        items.add(new Receipt.Item(string(item, "name", "รายการ"), qty, lineTotal));
        total += lineTotal;
      }
    }
    if (items.isEmpty()) throw new IllegalArgumentException("ใบเสร็จนี้ไม่มีรายการให้พิมพ์");
    total = decimal(input, "total", total);
    return new Receipt(id, shopName, phone, table, createdAt,
        string(input, "billNo", ""),
        receiptConfig == null ? "ใบเสร็จรับเงิน" : string(receiptConfig, "title", "ใบเสร็จรับเงิน"),
        receiptConfig == null ? "" : string(receiptConfig, "shopAddress", ""),
        receiptConfig == null ? "" : string(receiptConfig, "taxId", ""),
        receiptConfig == null ? "" : string(receiptConfig, "thanksText", ""),
        receiptConfig == null ? "" : string(receiptConfig, "apologyText", ""),
        receiptConfig == null || flag(receiptConfig, "showBillNo", true),
        receiptConfig == null || flag(receiptConfig, "showTime", true),
        receiptConfig == null || flag(receiptConfig, "showTable", true),
        receiptConfig != null && flag(receiptConfig, "showQr", false),
        receiptConfig == null ? "" : string(receiptConfig, "qrUrl", ""),
        receiptConfig == null ? "" : string(receiptConfig, "logoUrl", ""),
        paperWidthDots, items, total);
  }

  private Ticket readTicket(ReadableMap input, int maximumPaperWidthDots) {
    String shopName = string(input, "shopName", "จิ๊นโค");
    String station = string(input, "station", "ใบสั่งอาหาร");
    String table = string(input, "table", "-");
    String createdAt = string(input, "createdAt", "");
    String note = string(input, "note", "");
    int paperWidthDots = Math.min(maximumPaperWidthDots,
        Math.max(384, number(input, "paperWidthDots", 576)));
    List<Ticket.Item> items = new ArrayList<>();
    if (input.hasKey("items") && !input.isNull("items") && input.getType("items") == ReadableType.Array) {
      ReadableArray rawItems = input.getArray("items");
      for (int index = 0; index < rawItems.size(); index++) {
        if (rawItems.getType(index) != ReadableType.Map) continue;
        ReadableMap item = rawItems.getMap(index);
        items.add(new Ticket.Item(string(item, "name", "รายการ"), number(item, "qty", 1)));
      }
    }
    if (items.isEmpty()) throw new IllegalArgumentException("ใบสั่งนี้ไม่มีรายการให้พิมพ์");
    return new Ticket(shopName, station, table, createdAt, note, paperWidthDots, items);
  }

  private static String string(ReadableMap map, String key, String fallback) {
    if (!map.hasKey(key) || map.isNull(key)) return fallback;
    if (map.getType(key) == ReadableType.String) {
      String value = map.getString(key);
      return value == null ? fallback : value;
    }
    if (map.getType(key) == ReadableType.Number) return String.valueOf(map.getDouble(key));
    return fallback;
  }

  private static int number(ReadableMap map, String key, int fallback) {
    return map.hasKey(key) && !map.isNull(key) && map.getType(key) == ReadableType.Number
        ? map.getInt(key) : fallback;
  }

  private static double decimal(ReadableMap map, String key, double fallback) {
    return map.hasKey(key) && !map.isNull(key) && map.getType(key) == ReadableType.Number
        ? map.getDouble(key) : fallback;
  }

  private static boolean flag(ReadableMap map, String key, boolean fallback) {
    return map.hasKey(key) && !map.isNull(key) && map.getType(key) == ReadableType.Boolean
        ? map.getBoolean(key) : fallback;
  }

  private static WritableMap printResult(String route) {
    WritableMap result = Arguments.createMap();
    result.putBoolean("ok", true);
    result.putString("route", route);
    return result;
  }

  private static String printerStatusMessage(int status) {
    switch (status) {
      case 0: return "พร้อมพิมพ์";
      case -1:
      case 1: return "ไม่พบเครื่องพิมพ์ หรือเครื่องพิมพ์ยังไม่เปิด";
      case 3: return "ฝาเครื่องพิมพ์เปิดอยู่";
      case 7: return "กระดาษหมด";
      case 8: return "กระดาษใกล้หมด";
      default: return "ข้อผิดพลาดเครื่องพิมพ์ (" + status + ")";
    }
  }

  @Override
  public void invalidate() {
    printExecutor.shutdownNow();
    super.invalidate();
  }
}
