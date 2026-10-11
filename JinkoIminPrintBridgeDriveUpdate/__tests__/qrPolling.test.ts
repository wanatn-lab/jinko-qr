import {readFileSync} from 'fs';
import {join} from 'path';
import {expect, test} from '@jest/globals';

// Source-level contract checks: the existing Jest runner does not host Android Services.
const source = readFileSync(
  join(
    __dirname,
    '../android/app/src/main/java/com/jinko/printbridge/OrderPollingService.java',
  ),
  'utf8',
);

test('QR interval is 15 seconds for both initial delay and fixed delay', () => {
  expect(source).toMatch(/private static final long QR_POLL_SECONDS = 15;/);
  expect(source).toMatch(
    /qrPollingTask = worker\.scheduleWithFixedDelay\([\s\S]*?pollQrAndPrint\(\);[\s\S]*?QR_POLL_SECONDS, QR_POLL_SECONDS, TimeUnit\.SECONDS\);/,
  );
});

test('QR worker stays independent of shop hours', () => {
  const qrWorker = source.slice(
    source.indexOf('private void pollQrAndPrint()'),
    source.indexOf('private List<QueuedTicket> readQueuedTickets('),
  );
  expect(qrWorker).toContain('fetchObject(baseUrl + "/api/qr-print-jobs")');
  expect(qrWorker).not.toMatch(
    /ShopHours|canPollOrders|isShopOpen|specialOpenDate/,
  );
});

test('React screen does not introduce another automatic QR fetch loop', () => {
  const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8');
  expect(app).not.toContain('/api/qr-print-jobs');
});
