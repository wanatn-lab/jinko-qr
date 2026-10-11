export const DEFAULT_POLL_SECONDS = 6;
export const OPEN_MINUTE = 11 * 60 + 20;
export const CLOSE_MINUTE = 21 * 60;
export const CLOSE_GRACE_MINUTES = 2;
export const SPECIAL_CHECK_FROM_MINUTE = 10 * 60;
export const SPECIAL_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export type BangkokParts = {
  weekday: 'Sun' | 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat';
  date: string;
  minute: number;
};

export type ShopStatus = {specialOpenDate: string | null};

export function bangkokParts(date: Date = new Date()): BangkokParts {
  const parts: Record<string, string> = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .formatToParts(date)
    .forEach(part => {
      parts[part.type] = part.value;
    });
  return {
    weekday: parts.weekday as BangkokParts['weekday'],
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

function isMondayWithoutSpecial(
  parts: BangkokParts,
  specialOpenDate: string | null,
) {
  return parts.weekday === 'Mon' && specialOpenDate !== parts.date;
}

export function isShopOpen(
  date: Date = new Date(),
  specialOpenDate: string | null = null,
): boolean {
  const parts = bangkokParts(date);
  return (
    parts.minute >= OPEN_MINUTE &&
    parts.minute < CLOSE_MINUTE &&
    !isMondayWithoutSpecial(parts, specialOpenDate)
  );
}

/** Allows a final two-minute drain window for orders accepted just before closing. */
export function canPollOrders(
  date: Date = new Date(),
  specialOpenDate: string | null = null,
): boolean {
  const parts = bangkokParts(date);
  if (isMondayWithoutSpecial(parts, specialOpenDate)) return false;
  return (
    (parts.minute >= OPEN_MINUTE && parts.minute < CLOSE_MINUTE) ||
    (parts.minute >= CLOSE_MINUTE &&
      parts.minute < CLOSE_MINUTE + CLOSE_GRACE_MINUTES)
  );
}

export function shouldCheckSpecialOpen(date: Date = new Date()): boolean {
  const parts = bangkokParts(date);
  return (
    parts.weekday === 'Mon' &&
    parts.minute >= SPECIAL_CHECK_FROM_MINUTE &&
    parts.minute < CLOSE_MINUTE
  );
}

export function isSpecialCheckDue(
  date: Date = new Date(),
  lastCheckedAt: number | null = null,
): boolean {
  return (
    shouldCheckSpecialOpen(date) &&
    (lastCheckedAt === null ||
      date.getTime() - lastCheckedAt >= SPECIAL_CHECK_INTERVAL_MS)
  );
}

export function shopClosedNotice(
  date: Date = new Date(),
  specialOpenDate: string | null = null,
): string {
  return canPollOrders(date, specialOpenDate)
    ? ''
    : 'นอกเวลาเปิดร้าน หยุดดึงออเดอร์';
}

/** Shared, mockable boundary used by tests and by callers that need both queues. */
export async function pollShopEndpoints({
  date = new Date(),
  specialOpenDate = null,
  fetchOrders,
  fetchPrintJobs,
}: {
  date?: Date;
  specialOpenDate?: string | null;
  fetchOrders: () => Promise<unknown>;
  fetchPrintJobs: () => Promise<unknown>;
}): Promise<boolean> {
  if (!canPollOrders(date, specialOpenDate)) return false;
  await fetchOrders();
  await fetchPrintJobs();
  return true;
}
