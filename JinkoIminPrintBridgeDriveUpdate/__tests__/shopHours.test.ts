import {expect, jest, test} from '@jest/globals';
import {
  DEFAULT_POLL_SECONDS,
  canPollOrders,
  isShopOpen,
  isSpecialCheckDue,
  pollShopEndpoints,
  shopClosedNotice,
} from '../shopHours';

const bangkok = (value: string) => new Date(`${value}+07:00`);

test.each([
  ['11:19', false],
  ['11:20', true],
  ['20:59', true],
  ['21:00', true],
  ['21:01', true],
  ['21:02', false],
])('poll policy at %s is %s', (time, allowed) => {
  expect(canPollOrders(bangkok(`2026-10-11T${time}:00`))).toBe(allowed);
});

test('Monday is closed unless the current Bangkok date is specially opened', () => {
  const monday = bangkok('2026-10-12T12:00:00');
  expect(isShopOpen(monday)).toBe(false);
  expect(isShopOpen(monday, '2026-10-12')).toBe(true);
  expect(canPollOrders(monday, '2026-10-12')).toBe(true);
});

test('does not carry opening hours across midnight', () => {
  expect(canPollOrders(bangkok('2026-10-11T23:59:00'))).toBe(false);
  expect(canPollOrders(bangkok('2026-10-12T00:01:00'), '2026-10-12')).toBe(
    false,
  );
});

test('uses Bangkok time even when the Date string has a non-Thai offset', () => {
  // Same instant as 11:20 Bangkok, represented as 04:20 UTC.
  expect(isShopOpen(new Date('2026-10-11T04:20:00Z'))).toBe(true);
  expect(shopClosedNotice(new Date('2026-10-11T04:20:00Z'))).toBe('');
});

test('checks Monday special opening at most every five minutes', () => {
  const atTen = bangkok('2026-10-12T10:00:00');
  expect(isSpecialCheckDue(atTen, null)).toBe(true);
  expect(isSpecialCheckDue(atTen, atTen.getTime() - 4 * 60 * 1000)).toBe(false);
  expect(isSpecialCheckDue(atTen, atTen.getTime() - 5 * 60 * 1000)).toBe(true);
});

test('does not fetch either queue outside hours and polls both during hours', async () => {
  expect(DEFAULT_POLL_SECONDS).toBe(6);
  const fetchOrders = jest.fn<() => Promise<unknown>>().mockResolvedValue([]);
  const fetchPrintJobs = jest
    .fn<() => Promise<unknown>>()
    .mockResolvedValue({jobs: []});

  await expect(
    pollShopEndpoints({
      date: bangkok('2026-10-11T11:19:00'),
      fetchOrders,
      fetchPrintJobs,
    }),
  ).resolves.toBe(false);
  expect(fetchOrders).not.toHaveBeenCalled();
  expect(fetchPrintJobs).not.toHaveBeenCalled();

  await expect(
    pollShopEndpoints({
      date: bangkok('2026-10-11T11:20:00'),
      fetchOrders,
      fetchPrintJobs,
    }),
  ).resolves.toBe(true);
  expect(fetchOrders).toHaveBeenCalledTimes(1);
  expect(fetchPrintJobs).toHaveBeenCalledTimes(1);
});
