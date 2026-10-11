import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Alert,
  AppState,
  NativeModules,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  DEFAULT_POLL_SECONDS,
  canPollOrders,
  isShopOpen,
  isSpecialCheckDue,
  shopClosedNotice,
} from './shopHours';

type PrinterMode = 'imin' | 'network' | 'bluetooth';

type Settings = {
  apiBaseUrl: string;
  shopName: string;
  drinkCategory: string;
  kitchenHost: string;
  kitchenPort: number;
  pollSeconds: number;
  autoPrint: boolean;
  skipExistingOnFirstSync: boolean;
  // เครื่องพิมพ์เคาน์เตอร์/ใบเสร็จ — "imin" ใช้ iMin USB SDK เดิม, "network" ใช้ ESC/POS ผ่าน LAN
  // (เหมือนเครื่องพิมพ์ครัว), "bluetooth" ใช้ ESC/POS ผ่าน Bluetooth — ทำให้รองรับเครื่อง POS
  // ยี่ห้ออื่นที่ไม่มี iMin SDK ได้
  printerMode: PrinterMode;
  counterHost: string;
  counterPort: number;
  bluetoothAddress: string;
  bluetoothName: string;
};

type OrderItem = {
  id?: string;
  name: string;
  qty: number;
  category?: string;
  price?: number;
};
type Order = {
  id: string;
  table: string | number;
  items: OrderItem[];
  note?: string;
  status?: string;
  // The order API can return an ISO string or a Firestore Timestamp JSON object
  // ({_seconds, _nanoseconds}). Keep this broad at the boundary and turn it into
  // display/ISO text only when creating a native print job.
  createdAt: unknown;
};
type PrintTicket = {
  shopName: string;
  station: string;
  table: string;
  createdAt: string;
  note: string;
  paperWidthDots: number;
  items: Array<{name: string; qty: number}>;
};
// Mirrors the "receipt" object the admin settings tab saves to /api/settings
// (see admin.html rcSaveSettings()) and the receiptConfig fields
// IminPrinterModule.readReceipt() on the native side already knows how to
// render (logo, address, tax id, thank-you/apology text, QR fallback, etc.).
type ReceiptConfig = {
  logoUrl?: string;
  shopPhone?: string;
  shopAddress?: string;
  taxId?: string;
  title?: string;
  thanksText?: string;
  apologyText?: string;
  showBillNo?: boolean;
  showTime?: boolean;
  showTable?: boolean;
  showQr?: boolean;
  qrUrl?: string;
};
type ReceiptPrint = {
  id: string;
  shopName: string;
  phone: string;
  table: string;
  createdAt: string;
  paperWidthDots: number;
  total: number;
  items: Array<{name: string; qty: number; lineTotal: number}>;
  billNo?: string;
  receiptConfig?: ReceiptConfig;
};
type ReceiptJob = {
  id: string;
  type: 'receipt';
  shopName?: string;
  phone?: string;
  table?: string | number;
  createdAt?: unknown;
  total?: number;
  billNo?: string;
  // The checkout API snapshots the exact receipt design here.  Use this in
  // preference to the live settings, so a delayed/reprinted bill cannot pick
  // up a newer design by accident.
  receiptConfig?: ReceiptConfig;
  items?: Array<{
    name?: string;
    qty?: number;
    price?: number;
    lineTotal?: number;
  }>;
};
type PrinterStatus = {code: number; message: string; ready: boolean};
type BluetoothPrinter = {name: string; address: string};
type IminPrinterModule = {
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<Settings>;
  getDeviceId(): Promise<string>;
  getDeviceName(): Promise<string>;
  getPrintedKeys(): Promise<string[]>;
  claimPrint(key: string): Promise<boolean>;
  releasePrint(key: string): Promise<void>;
  markPrinted(key: string): Promise<void>;
  clearPrintedKeys(): Promise<void>;
  hasCompletedBootstrap(): Promise<boolean>;
  markBootstrapCompleted(): Promise<void>;
  getInternalPrinterStatus(): Promise<PrinterStatus>;
  printInternal(ticket: PrintTicket): Promise<{ok: boolean}>;
  printReceipt(receipt: ReceiptPrint): Promise<{ok: boolean}>;
  printNetwork(
    ticket: PrintTicket,
    host: string,
    port: number,
    cut: boolean,
  ): Promise<{ok: boolean}>;
  printReceiptNetwork(
    receipt: ReceiptPrint,
    host: string,
    port: number,
    cut: boolean,
  ): Promise<{ok: boolean}>;
  ensureBluetoothPermission(): Promise<boolean>;
  getPairedBluetoothPrinters(): Promise<BluetoothPrinter[]>;
  printBluetooth(
    ticket: PrintTicket,
    address: string,
    cut: boolean,
  ): Promise<{ok: boolean}>;
  printReceiptBluetooth(
    receipt: ReceiptPrint,
    address: string,
    cut: boolean,
  ): Promise<{ok: boolean}>;
};

const IminPrinter = NativeModules.IminPrinter as IminPrinterModule;
const DEFAULT_SETTINGS: Settings = {
  apiBaseUrl: 'https://jinko-order.vercel.app',
  shopName: 'จิ๊นโค',
  drinkCategory: 'เครื่องดื่ม',
  kitchenHost: '192.168.1.242',
  kitchenPort: 9100,
  pollSeconds: DEFAULT_POLL_SECONDS,
  autoPrint: true,
  skipExistingOnFirstSync: true,
  printerMode: 'imin',
  counterHost: '',
  counterPort: 9100,
  bluetoothAddress: '',
  bluetoothName: '',
};

type Route = 'internal' | 'kitchen';
type RoutedOrder = Order & {drinkItems: OrderItem[]; kitchenItems: OrderItem[]};

function normaliseBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, '');
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type FirestoreTimestamp = {
  _seconds?: unknown;
  seconds?: unknown;
  _nanoseconds?: unknown;
  nanoseconds?: unknown;
  toDate?: () => Date;
  toMillis?: () => number;
};

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * The web API normally returns ISO timestamps, but Firestore timestamps can also
 * reach the bridge as {_seconds, _nanoseconds}.  Never pass that raw object to
 * String()/Date() — it would otherwise be printed as JSON on the ticket.
 */
function timestampDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const numeric = finiteNumber(value);
    const date =
      typeof value === 'number' ||
      (typeof value === 'string' && numeric !== null)
        ? new Date(
            (numeric ?? 0) *
              (Math.abs(numeric ?? 0) < 100_000_000_000 ? 1000 : 1),
          )
        : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }

  const timestamp = value as FirestoreTimestamp;
  try {
    const date = timestamp.toDate?.();
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
      return date;
    }
  } catch {
    // Fall through to the serialised Timestamp fields below.
  }
  try {
    const millis = timestamp.toMillis?.();
    if (typeof millis === 'number' && Number.isFinite(millis)) {
      return new Date(millis);
    }
  } catch {
    // Fall through to the serialised Timestamp fields below.
  }

  const seconds = finiteNumber(timestamp._seconds ?? timestamp.seconds);
  if (seconds === null) {
    return null;
  }
  const nanoseconds = finiteNumber(
    timestamp._nanoseconds ?? timestamp.nanoseconds,
  );
  const date = new Date(seconds * 1000 + (nanoseconds ?? 0) / 1_000_000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function timestampIso(value: unknown): string {
  return timestampDate(value)?.toISOString() ?? '';
}

function timestampMillis(value: unknown): number {
  return timestampDate(value)?.getTime() ?? Number.MAX_SAFE_INTEGER;
}

function formatTime(value: unknown) {
  const date = timestampDate(value);
  return date
    ? date.toLocaleString('th-TH', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
}

function routeKey(route: Route, orderId: string) {
  return `${route}:${orderId}`;
}

function receiptKey(receiptId: string) {
  return `receipt:${receiptId}`;
}

function splitOrder(order: Order, drinkCategory: string): RoutedOrder {
  const category = drinkCategory.trim();
  const drinkItems = (order.items || []).filter(
    item => !category || (item.category || '').trim() === category,
  );
  return {
    ...order,
    drinkItems,
    kitchenItems: (order.items || []).filter(
      item => !drinkItems.includes(item),
    ),
  };
}

function routesFor(order: RoutedOrder): Route[] {
  const routes: Route[] = [];
  if (order.drinkItems.length) {
    routes.push('internal');
  }
  if (order.kitchenItems.length) {
    routes.push('kitchen');
  }
  return routes;
}

function ticketFor(
  order: RoutedOrder,
  route: Route,
  settings: Settings,
  paperWidthDots: number,
): PrintTicket {
  return {
    shopName: settings.shopName.trim() || 'จิ๊นโค',
    station: route === 'internal' ? 'เคาน์เตอร์เครื่องดื่ม' : 'ครัว',
    table: String(order.table ?? '-'),
    createdAt: formatTime(order.createdAt),
    note: order.note || '',
    paperWidthDots,
    items: (route === 'internal' ? order.drinkItems : order.kitchenItems).map(
      item => ({
        name: item.name,
        qty: Number(item.qty) || 1,
      }),
    ),
  };
}

function receiptFor(
  job: ReceiptJob,
  settings: Settings,
  paperWidthDots: number,
  receiptConfig?: ReceiptConfig,
): ReceiptPrint {
  const items = (job.items || []).map(item => {
    const qty = Math.max(1, Number(item.qty) || 1);
    const fromLine = Number(item.lineTotal);
    const fallback = (Number(item.price) || 0) * qty;
    return {
      name: item.name?.trim() || 'รายการ',
      qty,
      lineTotal: Number.isFinite(fromLine) ? fromLine : fallback,
    };
  });
  const suppliedTotal = Number(job.total);
  return {
    id: job.id,
    shopName: job.shopName?.trim() || settings.shopName.trim() || 'จิ๊นโค',
    phone: job.phone?.trim() || '085-529-8799',
    table: String(job.table ?? '-'),
    // The native receipt layout needs a real ISO value to split date/time into columns.
    createdAt: timestampIso(job.createdAt) || new Date().toISOString(),
    paperWidthDots,
    total: Number.isFinite(suppliedTotal)
      ? suppliedTotal
      : items.reduce((sum, item) => sum + item.lineTotal, 0),
    items,
    billNo: job.billNo,
    // Design fields (logo/address/tax id/thank-you text/QR) come from the admin
    // settings tab's "receipt" object — see loadPaperWidth() below, which now
    // caches it in receiptConfigRef alongside the paper width.
    // A receipt job carries the design that was active at checkout.  The
    // latest settings remain a fallback for legacy jobs created before this
    // field existed.
    receiptConfig: job.receiptConfig || receiptConfig,
  };
}

/**
 * Sends a counter/drinks ticket through whichever printer the settings screen has selected —
 * mirrors the printerMode dispatch in IminPrinterModule.java / OrderPollingService.java so the
 * same app binary works with iMin USB hardware or a generic network/Bluetooth ESC/POS printer.
 */
async function printCounterTicket(ticket: PrintTicket, settings: Settings) {
  if (settings.printerMode === 'network') {
    await IminPrinter.printNetwork(
      ticket,
      settings.counterHost,
      Math.max(1, Math.min(65535, Number(settings.counterPort) || 9100)),
      true,
    );
  } else if (settings.printerMode === 'bluetooth') {
    await IminPrinter.printBluetooth(ticket, settings.bluetoothAddress, true);
  } else {
    await IminPrinter.printInternal(ticket);
  }
}

/** Receipt counterpart of {@link printCounterTicket}. */
async function printCounterReceipt(receipt: ReceiptPrint, settings: Settings) {
  if (settings.printerMode === 'network') {
    await IminPrinter.printReceiptNetwork(
      receipt,
      settings.counterHost,
      Math.max(1, Math.min(65535, Number(settings.counterPort) || 9100)),
      true,
    );
  } else if (settings.printerMode === 'bluetooth') {
    await IminPrinter.printReceiptBluetooth(
      receipt,
      settings.bluetoothAddress,
      true,
    );
  } else {
    await IminPrinter.printReceipt(receipt);
  }
}

function App(): JSX.Element {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [orders, setOrders] = useState<RoutedOrder[]>([]);
  const [printed, setPrinted] = useState<Set<string>>(new Set());
  const [internalStatus, setInternalStatus] = useState<PrinterStatus | null>(
    null,
  );
  const [lastSync, setLastSync] = useState('ยังไม่ซิงก์');
  const [notice, setNotice] = useState('กำลังเปิดระบบ…');
  const [manualNotice, setManualNotice] = useState('');
  const [ready, setReady] = useState(false);
  const [appIsActive, setAppIsActive] = useState(
    AppState.currentState === 'active',
  );
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pairedPrinters, setPairedPrinters] = useState<BluetoothPrinter[]>([]);
  const [scanningBluetooth, setScanningBluetooth] = useState(false);
  const [specialOpenDate, setSpecialOpenDate] = useState<string | null>(null);

  const settingsRef = useRef(settings);
  const printedRef = useRef<Set<string>>(new Set());
  const bootstrapCompleteRef = useRef(false);
  const pollingRef = useRef(false);
  const inFlightRef = useRef<Set<string>>(new Set());
  const paperWidthRef = useRef(576);
  // Cached "receipt" design object from /api/settings (logo/address/tax id/
  // thank-you+apology text/QR) — see loadPaperWidth(). null until the first
  // successful fetch so a startup receipt still prints (with defaults) rather
  // than crashing.
  const receiptConfigRef = useRef<ReceiptConfig | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const deviceNameRef = useRef<string | null>(null);
  const specialOpenDateRef = useRef<string | null>(null);
  const specialCheckAtRef = useRef<number | null>(null);
  const lastPrinterStatusSignatureRef = useRef<string | null>(null);
  const lastPrinterStatusAtRef = useRef(0);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      setAppIsActive(nextState === 'active');
    });
    return () => subscription.remove();
  }, []);

  const refreshInternalStatus = useCallback(async () => {
    try {
      const result = await IminPrinter.getInternalPrinterStatus();
      setInternalStatus(result);
      return result;
    } catch (error) {
      const result = {code: -1, ready: false, message: errorText(error)};
      setInternalStatus(result);
      return result;
    }
  }, []);

  const refreshPairedPrinters = useCallback(async () => {
    setScanningBluetooth(true);
    try {
      const granted = await IminPrinter.ensureBluetoothPermission();
      if (!granted) {
        Alert.alert(
          'ไม่ได้รับสิทธิ์ Bluetooth',
          'กรุณาอนุญาตสิทธิ์ Bluetooth ในตั้งค่าเครื่องเพื่อค้นหาเครื่องพิมพ์ที่จับคู่ไว้',
        );
        return;
      }
      const printers = await IminPrinter.getPairedBluetoothPrinters();
      setPairedPrinters(printers || []);
      if (!printers || !printers.length) {
        Alert.alert(
          'ยังไม่พบเครื่องพิมพ์',
          'กรุณาจับคู่ (Pair) เครื่องพิมพ์ Bluetooth ในตั้งค่า Bluetooth ของเครื่องก่อน แล้วกลับมากดรีเฟรชอีกครั้ง',
        );
      }
    } catch (error) {
      Alert.alert('ค้นหาเครื่องพิมพ์ Bluetooth ไม่สำเร็จ', errorText(error));
    } finally {
      setScanningBluetooth(false);
    }
  }, []);

  const markPrinted = useCallback(async (key: string) => {
    await IminPrinter.markPrinted(key);
    const next = new Set(printedRef.current);
    next.add(key);
    printedRef.current = next;
    setPrinted(next);
  }, []);

  const deviceName = useCallback(async () => {
    if (!deviceNameRef.current) {
      deviceNameRef.current = await IminPrinter.getDeviceName();
    }
    return deviceNameRef.current;
  }, []);

  const deviceId = useCallback(async () => {
    if (!deviceIdRef.current) {
      deviceIdRef.current = await IminPrinter.getDeviceId();
    }
    return deviceIdRef.current;
  }, []);

  const syncSpecialOpen = useCallback(async (activeSettings: Settings) => {
    const now = new Date();
    if (!isSpecialCheckDue(now, specialCheckAtRef.current)) return;
    specialCheckAtRef.current = now.getTime();
    try {
      const response = await fetch(
        `${normaliseBaseUrl(activeSettings.apiBaseUrl)}/api/shop-status`,
        {
          headers: {Accept: 'application/json'},
        },
      );
      if (!response.ok) return;
      const payload = await response.json();
      const next =
        typeof payload?.specialOpenDate === 'string'
          ? payload.specialOpenDate
          : null;
      specialOpenDateRef.current = next;
      setSpecialOpenDate(next);
    } catch {
      // A failed Monday status check must not affect printing or alter the last known value.
    }
  }, []);

  const reportPrinterStatus = useCallback(
    async (status: PrinterStatus | null, activeSettings: Settings) => {
      if (!isShopOpen(new Date(), specialOpenDateRef.current)) return;
      const resolvedStatus = status || internalStatus;
      if (!resolvedStatus) return;
      const payload = {
        instanceId: await deviceId(),
        hostname: await deviceName(),
        printers: [
          {
            id: 'imin',
            name: 'iMin USB',
            ip: 'usb',
            port: 0,
            ok: Boolean(resolvedStatus.ready),
            error: resolvedStatus.ready ? null : resolvedStatus.message,
            latencyMs: null,
          },
        ],
      };
      const signature = JSON.stringify(payload.printers);
      const heartbeatDue =
        Date.now() - lastPrinterStatusAtRef.current >= 60 * 1000;
      if (signature === lastPrinterStatusSignatureRef.current && !heartbeatDue)
        return;
      try {
        const response = await fetch(
          `${normaliseBaseUrl(activeSettings.apiBaseUrl)}/api/printer-status`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(payload),
          },
        );
        if (response.ok) {
          lastPrinterStatusSignatureRef.current = signature;
          lastPrinterStatusAtRef.current = Date.now();
        }
      } catch {
        // Status reporting is best effort and must never affect printing.
      }
    },
    [deviceId, deviceName, internalStatus],
  );

  const loadPaperWidth = useCallback(async (activeSettings: Settings) => {
    try {
      const response = await fetch(
        `${normaliseBaseUrl(activeSettings.apiBaseUrl)}/api/settings`,
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const serverSettings = await response.json();
      paperWidthRef.current =
        Number(serverSettings.paperWidthMm) >= 76 ? 576 : 384;
      receiptConfigRef.current =
        serverSettings.receipt && typeof serverSettings.receipt === 'object'
          ? serverSettings.receipt
          : null;
    } catch {
      paperWidthRef.current = 576;
      // Leave receiptConfigRef untouched on failure so a transient network
      // blip doesn't blank out the last-known-good design mid-shift.
    }
  }, []);

  const processRoute = useCallback(
    async (order: RoutedOrder, route: Route, activeSettings: Settings) => {
      const key = routeKey(route, order.id);
      if (printedRef.current.has(key) || inFlightRef.current.has(key)) {
        return;
      }
      inFlightRef.current.add(key);
      let claimed = false;
      try {
        claimed = await IminPrinter.claimPrint(key);
        if (!claimed) {
          return;
        }
        const ticket = ticketFor(
          order,
          route,
          activeSettings,
          paperWidthRef.current,
        );
        if (route === 'internal') {
          await printCounterTicket(ticket, activeSettings);
        } else {
          await IminPrinter.printNetwork(
            ticket,
            activeSettings.kitchenHost,
            Math.max(
              1,
              Math.min(65535, Number(activeSettings.kitchenPort) || 9100),
            ),
            true,
          );
        }
        await markPrinted(key);
        setNotice(
          `พิมพ์${route === 'internal' ? 'เครื่องดื่ม' : 'ครัว'} โต๊ะ ${
            order.table
          } แล้ว`,
        );
      } catch (error) {
        setNotice(
          `พิมพ์${route === 'internal' ? 'เครื่องดื่ม' : 'ครัว'} โต๊ะ ${
            order.table
          } ไม่สำเร็จ: ${errorText(error)}`,
        );
      } finally {
        if (claimed) {
          // markPrinted() clears the claim after success; failed jobs must be released so the
          // next poll can retry instead of leaving a customer order stranded.
          await IminPrinter.releasePrint(key);
        }
        inFlightRef.current.delete(key);
      }
    },
    [markPrinted],
  );

  const updateReceiptJob = useCallback(
    async (
      action: 'claim' | 'complete' | 'release',
      receiptId: string,
      activeSettings: Settings,
    ) => {
      const response = await fetch(
        `${normaliseBaseUrl(activeSettings.apiBaseUrl)}/api/print-jobs`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            action,
            id: receiptId,
            deviceId: await deviceId(),
          }),
        },
      );
      if (!response.ok) {
        return false;
      }
      const result = await response.json();
      return result?.ok === true;
    },
    [deviceId],
  );

  const processReceiptJob = useCallback(
    async (job: ReceiptJob, activeSettings: Settings) => {
      if (!job.id || !Array.isArray(job.items) || !job.items.length) {
        return;
      }
      const key = receiptKey(job.id);
      // The prior native print succeeded but its HTTP acknowledgement may have been interrupted.
      // Acknowledge it without sending a second receipt to the customer.
      if (printedRef.current.has(key)) {
        try {
          await updateReceiptJob('complete', job.id, activeSettings);
        } catch {
          // The queue remains leased and this acknowledgement is retried in the next poll.
        }
        return;
      }
      if (inFlightRef.current.has(key)) {
        return;
      }
      inFlightRef.current.add(key);
      let localClaimed = false;
      let remotelyClaimed = false;
      let sentToPrinter = false;
      try {
        localClaimed = await IminPrinter.claimPrint(key);
        if (!localClaimed) {
          return;
        }
        remotelyClaimed = await updateReceiptJob(
          'claim',
          job.id,
          activeSettings,
        );
        if (!remotelyClaimed) {
          return;
        }
        await printCounterReceipt(
          receiptFor(
            job,
            activeSettings,
            paperWidthRef.current,
            receiptConfigRef.current || undefined,
          ),
          activeSettings,
        );
        sentToPrinter = true;
        await markPrinted(key);
        // Mark local history before this acknowledgement.  If Wi-Fi drops here we retry only the
        // acknowledgement, never the already-printed customer receipt.
        if (!(await updateReceiptJob('complete', job.id, activeSettings))) {
          throw new Error('ยืนยันใบเสร็จกับระบบไม่สำเร็จ');
        }
        setNotice(`พิมพ์ใบเสร็จโต๊ะ ${job.table ?? '-'} แล้ว`);
      } catch (error) {
        if (!sentToPrinter) {
          if (remotelyClaimed) {
            try {
              await updateReceiptJob('release', job.id, activeSettings);
            } catch {
              // The server-side lease expires, allowing a real failed print to retry safely.
            }
          }
          setNotice(`พิมพ์ใบเสร็จไม่สำเร็จ: ${errorText(error)}`);
        } else {
          setNotice('พิมพ์ใบเสร็จแล้ว กำลังยืนยันกับระบบอีกครั้ง');
        }
      } finally {
        if (localClaimed) {
          await IminPrinter.releasePrint(key);
        }
        inFlightRef.current.delete(key);
      }
    },
    [markPrinted, updateReceiptJob],
  );

  const pollOrders = useCallback(
    async (overrideSettings?: Settings, options: {manual?: boolean} = {}) => {
      if (pollingRef.current) {
        return;
      }
      pollingRef.current = true;
      setSyncing(true);
      const activeSettings = overrideSettings || settingsRef.current;
      try {
        // Only an explicit button press bypasses hours, for this invocation alone.
        // Timers, startup and settings saves retain the automatic hours gate.
        if (!options.manual) {
          await syncSpecialOpen(activeSettings);
        }
        if (
          !options.manual &&
          !canPollOrders(new Date(), specialOpenDateRef.current)
        ) {
          setNotice(shopClosedNotice(new Date(), specialOpenDateRef.current));
          return;
        }
        setManualNotice(
          options.manual && !isShopOpen(new Date(), specialOpenDateRef.current)
            ? 'ดึงมือนอกเวลาเปิดร้าน'
            : '',
        );
        await loadPaperWidth(activeSettings);
        const response = await fetch(
          `${normaliseBaseUrl(activeSettings.apiBaseUrl)}/api/orders`,
          {
            headers: {Accept: 'application/json'},
          },
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const allOrders = (await response.json()) as Order[];
        let receiptJobs: ReceiptJob[] = [];
        try {
          const receiptResponse = await fetch(
            `${normaliseBaseUrl(activeSettings.apiBaseUrl)}/api/print-jobs`,
            {headers: {Accept: 'application/json'}},
          );
          if (receiptResponse.ok) {
            const receiptPayload = await receiptResponse.json();
            receiptJobs = Array.isArray(receiptPayload?.jobs)
              ? receiptPayload.jobs
              : [];
          }
        } catch {
          // Keep kitchen/drink order printing available during the brief period when the website
          // is being upgraded.  Receipt jobs simply appear on the next successful poll.
        }
        const activeOrders = allOrders
          .filter(order => order.status !== 'done')
          .map(order => splitOrder(order, activeSettings.drinkCategory))
          .filter(order => routesFor(order).length > 0)
          .sort(
            (first, second) =>
              timestampMillis(first.createdAt) -
              timestampMillis(second.createdAt),
          );
        setOrders(activeOrders);
        setLastSync(`ซิงก์ ${new Date().toLocaleTimeString('th-TH')}`);

        const bootstrapping = !bootstrapCompleteRef.current;
        const skipExisting =
          bootstrapping && activeSettings.skipExistingOnFirstSync;
        if (bootstrapping) {
          if (activeSettings.skipExistingOnFirstSync) {
            for (const order of activeOrders) {
              for (const route of routesFor(order)) {
                await markPrinted(routeKey(route, order.id));
              }
            }
            setNotice(
              'รับรู้รายการค้างเดิมแล้ว — ออเดอร์ใหม่หลังจากนี้จะพิมพ์อัตโนมัติ',
            );
          }
          await IminPrinter.markBootstrapCompleted();
          bootstrapCompleteRef.current = true;
        }
        if (activeSettings.autoPrint && !skipExisting) {
          for (const order of activeOrders) {
            for (const route of routesFor(order)) {
              await processRoute(order, route, activeSettings);
            }
          }
        }
        if (activeSettings.autoPrint) {
          for (const receiptJob of receiptJobs) {
            await processReceiptJob(receiptJob, activeSettings);
          }
        }
      } catch (error) {
        setLastSync('ซิงก์ล้มเหลว');
        setNotice(`ดึงออเดอร์ไม่สำเร็จ: ${errorText(error)}`);
      } finally {
        pollingRef.current = false;
        setSyncing(false);
      }
    },
    [
      loadPaperWidth,
      markPrinted,
      processReceiptJob,
      processRoute,
      syncSpecialOpen,
    ],
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [storedSettings, printedKeys, hasCompletedBootstrap] =
          await Promise.all([
            IminPrinter.getSettings(),
            IminPrinter.getPrintedKeys(),
            IminPrinter.hasCompletedBootstrap(),
          ]);
        if (!mounted) {
          return;
        }
        const loaded = {...DEFAULT_SETTINGS, ...storedSettings};
        settingsRef.current = loaded;
        setSettings(loaded);
        const history = new Set(printedKeys);
        printedRef.current = history;
        setPrinted(history);
        bootstrapCompleteRef.current = hasCompletedBootstrap;
        setReady(true);
        await refreshInternalStatus();
        await pollOrders(loaded);
      } catch (error) {
        if (mounted) {
          setNotice(`เปิดระบบไม่สำเร็จ: ${errorText(error)}`);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [pollOrders, refreshInternalStatus]);

  useEffect(() => {
    if (!ready || !appIsActive) {
      return undefined;
    }
    const seconds = Math.max(
      2,
      Math.min(30, Number(settings.pollSeconds) || DEFAULT_POLL_SECONDS),
    );
    const timer = setInterval(() => pollOrders(), seconds * 1000);
    return () => clearInterval(timer);
  }, [appIsActive, pollOrders, ready, settings.pollSeconds]);

  const saveSettings = async () => {
    try {
      setSaving(true);
      const next: Settings = {
        ...settings,
        apiBaseUrl: normaliseBaseUrl(settings.apiBaseUrl),
        shopName: settings.shopName.trim() || 'จิ๊นโค',
        drinkCategory: settings.drinkCategory.trim() || 'เครื่องดื่ม',
        kitchenHost: settings.kitchenHost.trim(),
        kitchenPort: Math.max(
          1,
          Math.min(65535, Number(settings.kitchenPort) || 9100),
        ),
        pollSeconds: Math.max(
          2,
          Math.min(30, Number(settings.pollSeconds) || DEFAULT_POLL_SECONDS),
        ),
        counterHost: settings.counterHost.trim(),
        counterPort: Math.max(
          1,
          Math.min(65535, Number(settings.counterPort) || 9100),
        ),
        bluetoothAddress: settings.bluetoothAddress.trim(),
        bluetoothName: settings.bluetoothName.trim(),
      };
      const saved = await IminPrinter.saveSettings(next);
      settingsRef.current = saved;
      setSettings(saved);
      setNotice('บันทึกการตั้งค่าแล้ว');
      await refreshInternalStatus();
      await pollOrders(saved);
    } catch (error) {
      Alert.alert('บันทึกไม่สำเร็จ', errorText(error));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!ready || !appIsActive) return undefined;
    const report = () => {
      reportPrinterStatus(internalStatus, settingsRef.current);
    };
    report();
    const timer = setInterval(report, 60 * 1000);
    return () => clearInterval(timer);
  }, [
    appIsActive,
    internalStatus,
    ready,
    reportPrinterStatus,
    settings.apiBaseUrl,
    specialOpenDate,
  ]);

  const printerModeLabel = (mode: PrinterMode) =>
    mode === 'network'
      ? 'LAN'
      : mode === 'bluetooth'
      ? 'Bluetooth'
      : 'iMin USB';

  const printInternalTest = async () => {
    try {
      await printCounterTicket(
        {
          shopName: settings.shopName,
          station: 'เคาน์เตอร์เครื่องดื่ม',
          table: 'ทดสอบ',
          createdAt: formatTime(new Date().toISOString()),
          note: 'ใบทดสอบระบบ',
          paperWidthDots: paperWidthRef.current,
          items: [
            {name: 'ชาเย็น', qty: 2},
            {name: 'กาแฟเย็น', qty: 1},
          ],
        },
        settings,
      );
      setNotice(
        `ส่งใบทดสอบไปเครื่องพิมพ์เคาน์เตอร์ (${printerModeLabel(
          settings.printerMode,
        )}) แล้ว`,
      );
      if (settings.printerMode === 'imin') {
        await refreshInternalStatus();
      }
    } catch (error) {
      Alert.alert('ทดสอบเครื่องพิมพ์เคาน์เตอร์ไม่สำเร็จ', errorText(error));
    }
  };

  const printReceiptTest = async () => {
    try {
      await printCounterReceipt(
        {
          id: 'test-receipt',
          shopName: settings.shopName,
          phone: '085-529-8799',
          table: 'ทดสอบ',
          createdAt: new Date().toISOString(),
          paperWidthDots: paperWidthRef.current,
          items: [
            {name: 'ชาเย็น', qty: 2, lineTotal: 70},
            {name: 'ข้าวผัดกระเพราหมูสับ', qty: 1, lineTotal: 59},
          ],
          total: 129,
          billNo: 'TEST-0001',
          receiptConfig: receiptConfigRef.current || undefined,
        },
        settings,
      );
      setNotice(
        `ส่งใบทดสอบใบเสร็จไปเครื่องพิมพ์ (${printerModeLabel(
          settings.printerMode,
        )}) แล้ว`,
      );
      if (settings.printerMode === 'imin') {
        await refreshInternalStatus();
      }
    } catch (error) {
      Alert.alert('ทดสอบใบเสร็จไม่สำเร็จ', errorText(error));
    }
  };

  const printKitchenTest = async () => {
    try {
      await IminPrinter.printNetwork(
        {
          shopName: settings.shopName,
          station: 'ครัว',
          table: 'ทดสอบ',
          createdAt: formatTime(new Date().toISOString()),
          note: 'ใบทดสอบระบบ LAN',
          paperWidthDots: paperWidthRef.current,
          items: [{name: 'ข้าวผัดกระเพราหมูสับ', qty: 1}],
        },
        settings.kitchenHost,
        Math.max(1, Math.min(65535, Number(settings.kitchenPort) || 9100)),
        true,
      );
      setNotice('ส่งใบทดสอบไปเครื่องพิมพ์ครัวแล้ว');
    } catch (error) {
      Alert.alert('ทดสอบเครื่องพิมพ์ครัวไม่สำเร็จ', errorText(error));
    }
  };

  const clearHistory = () => {
    Alert.alert(
      'ล้างประวัติการพิมพ์?',
      'ออเดอร์ที่ยังอยู่ในคิวจะถูกพิมพ์ใหม่ในการซิงก์รอบถัดไป',
      [
        {text: 'ยกเลิก', style: 'cancel'},
        {
          text: 'ล้างและพิมพ์ใหม่',
          style: 'destructive',
          onPress: async () => {
            await IminPrinter.clearPrintedKeys();
            printedRef.current = new Set();
            setPrinted(new Set());
            setNotice('ล้างประวัติแล้ว — กำลังตรวจคิวเพื่อพิมพ์ใหม่');
            await pollOrders(undefined, {manual: true});
          },
        },
      ],
    );
  };

  const queueCount = orders.reduce(
    (total, order) =>
      total +
      routesFor(order).filter(route => !printed.has(routeKey(route, order.id)))
        .length,
    0,
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#2B1810" />
      <ScrollView
        contentContainerStyle={styles.page}
        keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>จิ๊นโค · Print Bridge</Text>
            <Text style={styles.subtitle}>
              เคาน์เตอร์: {printerModeLabel(settings.printerMode)} · ครัวผ่าน
              LAN
            </Text>
          </View>
          <View
            style={[
              styles.statusPill,
              internalStatus?.ready ? styles.okPill : styles.badPill,
            ]}>
            <View
              style={[
                styles.dot,
                internalStatus?.ready ? styles.okDot : styles.badDot,
              ]}
            />
            <Text style={styles.statusPillText}>
              {internalStatus?.ready ? 'iMin พร้อม' : 'ตรวจ iMin'}
            </Text>
          </View>
        </View>

        <View style={styles.notice}>
          <Text style={styles.noticeText}>{notice}</Text>
          {!!manualNotice && (
            <Text style={styles.noticeText}>{manualNotice}</Text>
          )}
          {!!shopClosedNotice(new Date(), specialOpenDate) && (
            <Text style={styles.closedNoticeText}>
              {shopClosedNotice(new Date(), specialOpenDate)}
            </Text>
          )}
          <Text style={styles.syncText}>{lastSync}</Text>
        </View>

        <View style={styles.summary}>
          <View>
            <Text style={styles.summaryLabel}>รอพิมพ์</Text>
            <Text style={styles.summaryNumber}>{queueCount}</Text>
          </View>
          <Pressable
            style={[styles.primaryButton, syncing && styles.buttonDisabled]}
            disabled={syncing}
            onPress={() => pollOrders(undefined, {manual: true})}>
            <Text style={styles.primaryButtonText}>
              {syncing ? 'กำลังซิงก์…' : 'ซิงก์ตอนนี้'}
            </Text>
          </Pressable>
        </View>

        <Text style={styles.sectionTitle}>สถานะเครื่องพิมพ์</Text>
        <View style={styles.card}>
          <Text style={styles.cardHeading}>
            เครื่องพิมพ์เคาน์เตอร์/ใบเสร็จ (
            {printerModeLabel(settings.printerMode)})
          </Text>
          <View style={styles.rowButtons}>
            {[
              {mode: 'imin' as PrinterMode, label: 'iMin USB'},
              {mode: 'network' as PrinterMode, label: 'LAN'},
              {mode: 'bluetooth' as PrinterMode, label: 'Bluetooth'},
            ].map(option => (
              <Pressable
                key={option.mode}
                style={[
                  styles.secondaryButton,
                  settings.printerMode === option.mode &&
                    styles.modeButtonActive,
                ]}
                onPress={() =>
                  setSettings({...settings, printerMode: option.mode})
                }>
                <Text
                  style={[
                    styles.secondaryButtonText,
                    settings.printerMode === option.mode &&
                      styles.modeButtonActiveText,
                  ]}>
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
          {settings.printerMode === 'imin' && (
            <Text
              style={[
                styles.statusText,
                internalStatus?.ready ? styles.okText : styles.badText,
              ]}>
              {internalStatus?.message || 'กำลังตรวจสอบ…'}
            </Text>
          )}
          <View style={styles.rowButtons}>
            {settings.printerMode === 'imin' && (
              <Pressable
                style={styles.secondaryButton}
                onPress={refreshInternalStatus}>
                <Text style={styles.secondaryButtonText}>ตรวจสถานะ</Text>
              </Pressable>
            )}
            <Pressable
              style={styles.secondaryButton}
              onPress={printInternalTest}>
              <Text style={styles.secondaryButtonText}>ทดสอบพิมพ์น้ำ</Text>
            </Pressable>
          </View>
          <Pressable style={styles.secondaryButton} onPress={printReceiptTest}>
            <Text style={styles.secondaryButtonText}>ทดสอบพิมพ์ใบเสร็จ</Text>
          </Pressable>
          <View style={styles.divider} />
          <Text style={styles.cardHeading}>เครื่องพิมพ์ครัว (LAN)</Text>
          <Text style={styles.helperText}>
            {settings.kitchenHost || 'ยังไม่ได้ใส่ IP'}:
            {settings.kitchenPort || 9100} · raw ESC/POS TCP
          </Text>
          <Pressable style={styles.secondaryButton} onPress={printKitchenTest}>
            <Text style={styles.secondaryButtonText}>ทดสอบพิมพ์ครัว</Text>
          </Pressable>
          <Text style={styles.helperText}>
            เมื่อสลับไปแอปอื่น Bridge จะตรวจออเดอร์ต่อในพื้นหลัง
          </Text>
        </View>

        <Text style={styles.sectionTitle}>คิวออเดอร์</Text>
        {orders.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.helperText}>
              ยังไม่มีรายการน้ำหรืออาหารที่รอทำ
            </Text>
          </View>
        ) : (
          orders.map(order => (
            <View style={styles.orderCard} key={order.id}>
              <View style={styles.orderHeader}>
                <View>
                  <Text style={styles.orderTable}>โต๊ะ {order.table}</Text>
                  <Text style={styles.helperText}>
                    {formatTime(order.createdAt)}
                  </Text>
                </View>
                <Text style={styles.orderId}>{order.id.slice(-6)}</Text>
              </View>
              {routesFor(order).map(route => {
                const items =
                  route === 'internal' ? order.drinkItems : order.kitchenItems;
                const wasPrinted = printed.has(routeKey(route, order.id));
                return (
                  <View style={styles.routeBlock} key={route}>
                    <View style={styles.routeHeading}>
                      <Text style={styles.routeName}>
                        {route === 'internal' ? '🧋 น้ำ' : '🍳 ครัว'}
                      </Text>
                      <Text
                        style={wasPrinted ? styles.okText : styles.pendingText}>
                        {wasPrinted ? 'พิมพ์แล้ว' : 'รอพิมพ์'}
                      </Text>
                    </View>
                    {items.map((item, index) => (
                      <View
                        style={styles.itemRow}
                        key={`${item.id || item.name}-${index}`}>
                        <Text style={styles.itemName}>{item.name}</Text>
                        <Text style={styles.itemQty}>×{item.qty}</Text>
                      </View>
                    ))}
                  </View>
                );
              })}
              {!!order.note && (
                <Text style={styles.note}>หมายเหตุ: {order.note}</Text>
              )}
            </View>
          ))
        )}

        <Text style={styles.sectionTitle}>ตั้งค่า</Text>
        <View style={styles.card}>
          <Field
            label="URL ระบบออเดอร์"
            value={settings.apiBaseUrl}
            onChangeText={value =>
              setSettings({...settings, apiBaseUrl: value})
            }
          />
          <Field
            label="ชื่อร้านบนใบสั่ง"
            value={settings.shopName}
            onChangeText={value => setSettings({...settings, shopName: value})}
          />
          <Field
            label="หมวดหมู่น้ำ (พิมพ์ที่ iMin)"
            value={settings.drinkCategory}
            onChangeText={value =>
              setSettings({...settings, drinkCategory: value})
            }
          />
          <Field
            label="IP เครื่องพิมพ์ครัว"
            value={settings.kitchenHost}
            keyboardType="numbers-and-punctuation"
            onChangeText={value =>
              setSettings({...settings, kitchenHost: value})
            }
          />
          <Field
            label="พอร์ตเครื่องพิมพ์ครัว"
            value={String(settings.kitchenPort)}
            keyboardType="number-pad"
            onChangeText={value =>
              setSettings({...settings, kitchenPort: Number(value) || 0})
            }
          />
          {settings.printerMode === 'network' && (
            <>
              <Field
                label="IP เครื่องพิมพ์เคาน์เตอร์/ใบเสร็จ"
                value={settings.counterHost}
                keyboardType="numbers-and-punctuation"
                onChangeText={value =>
                  setSettings({...settings, counterHost: value})
                }
              />
              <Field
                label="พอร์ตเครื่องพิมพ์เคาน์เตอร์/ใบเสร็จ"
                value={String(settings.counterPort)}
                keyboardType="number-pad"
                onChangeText={value =>
                  setSettings({...settings, counterPort: Number(value) || 0})
                }
              />
            </>
          )}
          {settings.printerMode === 'bluetooth' && (
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>เครื่องพิมพ์ Bluetooth</Text>
              <Text style={styles.helperText}>
                {settings.bluetoothAddress
                  ? `เลือกไว้: ${
                      settings.bluetoothName || settings.bluetoothAddress
                    }`
                  : 'ยังไม่ได้เลือกเครื่องพิมพ์ Bluetooth — จับคู่ (Pair) ในตั้งค่าเครื่องก่อน แล้วกดรีเฟรชด้านล่าง'}
              </Text>
              <Pressable
                style={[
                  styles.secondaryButton,
                  scanningBluetooth && styles.buttonDisabled,
                  styles.bluetoothScanButton,
                ]}
                disabled={scanningBluetooth}
                onPress={refreshPairedPrinters}>
                <Text style={styles.secondaryButtonText}>
                  {scanningBluetooth
                    ? 'กำลังค้นหา…'
                    : 'ขอสิทธิ์ / รีเฟรชรายการเครื่องพิมพ์'}
                </Text>
              </Pressable>
              {pairedPrinters.map(printer => (
                <Pressable
                  key={printer.address}
                  style={[
                    styles.bluetoothItem,
                    settings.bluetoothAddress === printer.address &&
                      styles.modeButtonActive,
                  ]}
                  onPress={() =>
                    setSettings({
                      ...settings,
                      bluetoothAddress: printer.address,
                      bluetoothName: printer.name,
                    })
                  }>
                  <Text
                    style={[
                      styles.secondaryButtonText,
                      settings.bluetoothAddress === printer.address &&
                        styles.modeButtonActiveText,
                    ]}>
                    {printer.name} · {printer.address}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          <Field
            label="เช็คออเดอร์ทุกกี่วินาที (2–30)"
            value={String(settings.pollSeconds)}
            keyboardType="number-pad"
            onChangeText={value =>
              setSettings({...settings, pollSeconds: Number(value) || 0})
            }
          />
          <Toggle
            label="พิมพ์อัตโนมัติ"
            value={settings.autoPrint}
            onValueChange={value =>
              setSettings({...settings, autoPrint: value})
            }
          />
          <Toggle
            label="ติดตั้งครั้งแรก: ข้ามรายการเก่าที่ค้างอยู่"
            value={settings.skipExistingOnFirstSync}
            onValueChange={value =>
              setSettings({...settings, skipExistingOnFirstSync: value})
            }
          />
          <Pressable
            style={[styles.primaryButton, saving && styles.buttonDisabled]}
            disabled={saving}
            onPress={saveSettings}>
            <Text style={styles.primaryButtonText}>
              {saving ? 'กำลังบันทึก…' : 'บันทึกการตั้งค่า'}
            </Text>
          </Pressable>
          <Pressable style={styles.dangerButton} onPress={clearHistory}>
            <Text style={styles.dangerButtonText}>
              ล้างประวัติ เพื่อพิมพ์คิวปัจจุบันใหม่
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({
  label,
  value,
  onChangeText,
  keyboardType = 'default',
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  keyboardType?: 'default' | 'number-pad' | 'numbers-and-punctuation';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboardType}
      />
    </View>
  );
}

function Toggle({
  label,
  value,
  onValueChange,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{true: '#B4703A'}}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {flex: 1, backgroundColor: '#F8F2E7'},
  page: {padding: 16, paddingBottom: 40},
  header: {
    backgroundColor: '#2B1810',
    borderRadius: 16,
    padding: 18,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  title: {color: '#FFF8EE', fontSize: 22, fontWeight: '700'},
  subtitle: {color: '#D8C3AE', fontSize: 13, marginTop: 3},
  statusPill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  okPill: {backgroundColor: '#315C30'},
  badPill: {backgroundColor: '#6D3730'},
  dot: {width: 7, height: 7, borderRadius: 7},
  okDot: {backgroundColor: '#A6E28A'},
  badDot: {backgroundColor: '#FFB0A4'},
  statusPillText: {color: '#FFF8EE', fontWeight: '700', fontSize: 12},
  notice: {
    backgroundColor: '#FFFDF8',
    borderWidth: 1,
    borderColor: '#E7D9C4',
    borderRadius: 12,
    marginTop: 12,
    padding: 13,
  },
  noticeText: {color: '#2B1810', fontWeight: '600', fontSize: 13},
  closedNoticeText: {
    color: '#96392E',
    fontWeight: '800',
    fontSize: 13,
    marginTop: 5,
  },
  syncText: {color: '#7A6A5A', fontSize: 12, marginTop: 4},
  summary: {
    marginTop: 12,
    backgroundColor: '#EED8C2',
    borderRadius: 14,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  summaryLabel: {color: '#6E482D', fontSize: 13, fontWeight: '600'},
  summaryNumber: {color: '#2B1810', fontSize: 31, fontWeight: '800'},
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#2B1810',
    marginTop: 23,
    marginBottom: 9,
  },
  card: {
    backgroundColor: '#FFFDF8',
    borderWidth: 1,
    borderColor: '#E7D9C4',
    borderRadius: 14,
    padding: 15,
  },
  emptyCard: {
    backgroundColor: '#FFFDF8',
    borderWidth: 1,
    borderColor: '#E7D9C4',
    borderRadius: 14,
    padding: 22,
    alignItems: 'center',
  },
  cardHeading: {color: '#2B1810', fontWeight: '700', fontSize: 15},
  statusText: {marginTop: 5, fontSize: 13, fontWeight: '600'},
  okText: {color: '#3F6B33'},
  badText: {color: '#96392E'},
  pendingText: {color: '#9C5B12'},
  helperText: {color: '#7A6A5A', fontSize: 12, lineHeight: 18},
  rowButtons: {flexDirection: 'row', gap: 8, marginTop: 12},
  primaryButton: {
    backgroundColor: '#B4703A',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryButtonText: {color: '#FFFDF8', fontWeight: '800', fontSize: 14},
  secondaryButton: {
    backgroundColor: '#F7EEDF',
    borderColor: '#CDA77F',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 9,
    alignItems: 'center',
  },
  secondaryButtonText: {color: '#6E482D', fontWeight: '700', fontSize: 13},
  buttonDisabled: {opacity: 0.55},
  modeButtonActive: {backgroundColor: '#B4703A', borderColor: '#B4703A'},
  modeButtonActiveText: {color: '#FFFDF8'},
  bluetoothScanButton: {marginTop: 8, marginBottom: 6},
  bluetoothItem: {
    backgroundColor: '#F7EEDF',
    borderColor: '#CDA77F',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 9,
    marginTop: 6,
  },
  divider: {height: 1, backgroundColor: '#E7D9C4', marginVertical: 15},
  orderCard: {
    backgroundColor: '#FFFDF8',
    borderWidth: 1,
    borderColor: '#E7D9C4',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
  },
  orderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  orderTable: {fontSize: 20, color: '#2B1810', fontWeight: '800'},
  orderId: {color: '#A28E79', fontSize: 11},
  routeBlock: {
    borderTopColor: '#E7D9C4',
    borderTopWidth: 1,
    paddingTop: 10,
    marginTop: 10,
  },
  routeHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 5,
  },
  routeName: {color: '#2B1810', fontWeight: '800'},
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 2,
  },
  itemName: {color: '#2B1810', flex: 1},
  itemQty: {color: '#7A6A5A', fontWeight: '700'},
  note: {color: '#9C5B12', marginTop: 9, fontSize: 12},
  field: {marginBottom: 13},
  fieldLabel: {
    color: '#2B1810',
    fontWeight: '700',
    fontSize: 13,
    marginBottom: 5,
  },
  input: {
    borderWidth: 1,
    borderColor: '#D8C3AE',
    borderRadius: 9,
    backgroundColor: '#FFFEFC',
    paddingHorizontal: 11,
    paddingVertical: 9,
    color: '#2B1810',
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#E7D9C4',
    marginBottom: 6,
  },
  toggleLabel: {color: '#2B1810', fontWeight: '600', flex: 1, paddingRight: 12},
  dangerButton: {
    borderColor: '#B84C3E',
    borderWidth: 1,
    padding: 11,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 10,
  },
  dangerButtonText: {color: '#96392E', fontWeight: '700', fontSize: 13},
});

export default App;
