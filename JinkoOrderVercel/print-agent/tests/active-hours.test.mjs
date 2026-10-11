import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPrinterStatusReporter, createSettingsCache, isWithinActiveHours, orderPollIntervalMs, shouldCheckSpecialOpen } from '../index.mjs';

test('order polling falls back to six seconds when config omits pollIntervalMs', () => {
  assert.equal(orderPollIntervalMs({}), 6000);
  assert.equal(orderPollIntervalMs({ pollIntervalMs: 7500 }), 7500);
});

// Bangkok is UTC+7. 2026-10-13 is a Tuesday, 2026-10-12 a Monday.
const at = (isoBangkok) => new Date(isoBangkok + '+07:00');

test('open from 11:20 up to (not including) 21:00 Bangkok time', () => {
  const config = {};
  assert.equal(isWithinActiveHours(config, at('2026-10-13T11:19:00')), false);
  assert.equal(isWithinActiveHours(config, at('2026-10-13T11:20:00')), true);
  assert.equal(isWithinActiveHours(config, at('2026-10-13T20:59:00')), true);
  assert.equal(isWithinActiveHours(config, at('2026-10-13T21:00:00')), false);
  assert.equal(isWithinActiveHours(config, at('2026-10-14T00:00:00')), false);
});

test('Monday is closed unless that date was switched to a special opening', () => {
  const config = {};
  assert.equal(isWithinActiveHours(config, at('2026-10-12T15:00:00')), false);
  assert.equal(isWithinActiveHours(config, at('2026-10-12T15:00:00'), '2026-10-12'), true);
  assert.equal(isWithinActiveHours(config, at('2026-10-12T11:19:00'), '2026-10-12'), false); // hours still apply
  assert.equal(isWithinActiveHours(config, at('2026-10-19T15:00:00'), '2026-10-12'), false); // next Monday
});

test('custom hours and closed days from config.json are respected (hour numbers still work)', () => {
  const config = { activeHours: { start: 9, end: 22, closedWeekdays: [], timeZone: 'Asia/Bangkok' } };
  assert.equal(isWithinActiveHours(config, at('2026-10-12T09:00:00')), true); // Monday, no closed day
  assert.equal(isWithinActiveHours(config, at('2026-10-12T22:00:00')), false);
});

test('activeHours: null keeps the agent running all day', () => {
  assert.equal(isWithinActiveHours({ activeHours: null }, at('2026-10-12T03:00:00')), true);
  assert.equal(shouldCheckSpecialOpen({ activeHours: null }, at('2026-10-12T15:00:00')), false);
});

test('the special-opening check only runs on closed weekdays during the day', () => {
  assert.equal(shouldCheckSpecialOpen({}, at('2026-10-12T09:59:00')), false);
  assert.equal(shouldCheckSpecialOpen({}, at('2026-10-12T10:00:00')), true);
  assert.equal(shouldCheckSpecialOpen({}, at('2026-10-12T20:59:00')), true);
  assert.equal(shouldCheckSpecialOpen({}, at('2026-10-12T21:00:00')), false);
  assert.equal(shouldCheckSpecialOpen({}, at('2026-10-13T15:00:00')), false); // Tuesday
});

test('settings cache refreshes once at startup and then every configured five minutes', async () => {
  let clock = 0;
  let calls = 0;
  const cache = createSettingsCache(
    { apiBase: 'https://example.test', printers: [{ ip: 'local' }], settingsRefreshMs: 300000 },
    { now: () => clock, fetchSettings: async () => ({ printers: [{ ip: `remote-${++calls}` }] }) },
  );
  await cache.refresh({ force: true });
  assert.equal(calls, 1);
  assert.equal(cache.config().printers[0].ip, 'remote-1');
  clock = 299999;
  await cache.refresh();
  assert.equal(calls, 1);
  clock = 300000;
  await cache.refresh();
  assert.equal(calls, 2);
  assert.equal(cache.config().printers[0].ip, 'remote-2');
});

test('settings refresh failure preserves the last known-good settings', async () => {
  let calls = 0;
  const errors = [];
  const cache = createSettingsCache(
    { apiBase: 'https://example.test', printers: [{ ip: 'local' }], settingsRefreshMs: 10000 },
    {
      now: () => calls * 10000,
      fetchSettings: async () => {
        calls += 1;
        if (calls === 1) return { printers: [{ ip: 'remote' }] };
        throw new Error('temporary settings error');
      },
      onError: (error) => errors.push(error.message),
    },
  );
  await cache.refresh({ force: true });
  await cache.refresh();
  assert.equal(cache.config().printers[0].ip, 'remote');
  assert.deepEqual(errors, ['temporary settings error']);
});

test('printer status posts on first report, changes, print result, and 60-second heartbeat only', async () => {
  let clock = 0;
  const sent = [];
  let reachable = true;
  const printer = { id: 'p1', name: 'ครัว', ip: '10.0.0.2' };
  const reporter = createPrinterStatusReporter({
    apiBase: 'https://example.test', instanceId: 'instance-1', hostname: 'kitchen-pc', heartbeatMs: 60000,
    now: () => clock,
    probe: async (p) => ({ id: p.id, name: p.name, ip: p.ip, port: 9100, ok: reachable, error: reachable ? null : 'timed out' }),
    post: async (payload) => { sent.push(payload); },
  });
  await reporter.reportIfNeeded([printer]);
  clock = 6000;
  await reporter.reportIfNeeded([printer]);
  reachable = false;
  clock = 12000;
  await reporter.reportIfNeeded([printer]);
  reporter.recordPrintResult(printer, false, 'printer write failed');
  clock = 13000;
  await reporter.reportIfNeeded([printer]);
  clock = 73000;
  await reporter.reportIfNeeded([printer]);

  assert.equal(sent.length, 4);
  assert.equal(sent[0].instanceId, 'instance-1');
  assert.equal(sent[0].hostname, 'kitchen-pc');
  assert.equal(sent[3].printers[0].lastPrint.error, 'printer write failed');
});
