import {expect, jest, test} from '@jest/globals';
import {createSettingsCache} from '../settingsCache';

test('one successful load within five minutes, refresh at exactly five minutes', async () => {
  let now = 0;
  const cache = createSettingsCache(() => now);
  const value = {paperWidthMm: 58, receipt: {title: 'Latest'}};
  const load = jest.fn(async () => value);
  expect(await cache.refresh(load)).toBe(value);
  for (now = 6000; now < 300000; now += 6000) await cache.refresh(load);
  expect(load).toHaveBeenCalledTimes(1);
  now = 300000;
  await cache.refresh(load);
  expect(load).toHaveBeenCalledTimes(2);
});

test('failed refresh retains width and receipt, retries no earlier than 60 seconds even when forced', async () => {
  let now = 0;
  const cache = createSettingsCache(() => now);
  const previous = {paperWidthMm: 58, receipt: {title: 'Last successful'}};
  const next = {paperWidthMm: 80, receipt: {title: 'New'}};
  const load = jest
    .fn<() => Promise<typeof previous>>()
    .mockResolvedValueOnce(previous)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(next);
  await cache.refresh(load);
  now = 300000;
  expect(await cache.refresh(load)).toBe(previous);
  now = 359999;
  expect(await cache.refresh(load, true)).toBe(previous);
  expect(load).toHaveBeenCalledTimes(2);
  now = 360000;
  expect(await cache.refresh(load)).toBe(next);
  expect(load).toHaveBeenCalledTimes(3);
});

test('force refresh bypasses fresh cache and success time is counted after completion', async () => {
  let now = 0;
  const cache = createSettingsCache(() => now);
  const load = jest.fn(async () => {
    now += 2000;
    return {paperWidthMm: now};
  });
  await cache.refresh(load);
  now = 10000;
  expect(await cache.refresh(load, true)).toEqual({paperWidthMm: 12000});
  now = 311999;
  await cache.refresh(load);
  expect(load).toHaveBeenCalledTimes(2);
  now = 312000;
  await cache.refresh(load);
  expect(load).toHaveBeenCalledTimes(3);
});

test('initial failure is also throttled and overlapping refreshes share one request', async () => {
  let now = 0;
  const cache = createSettingsCache(() => now);
  const load = jest
    .fn<() => Promise<{paperWidthMm: number}>>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({paperWidthMm: 58});
  expect(await cache.refresh(load)).toBeNull();
  now = 59999;
  expect(await cache.refresh(load, true)).toBeNull();
  expect(load).toHaveBeenCalledTimes(1);
  now = 60000;
  await Promise.all([cache.refresh(load), cache.refresh(load, true)]);
  expect(load).toHaveBeenCalledTimes(2);
});

test('native settings loader and explicit refresh notification use the same cache contract', () => {
  const {readFileSync} = require('fs');
  const {join} = require('path');
  const java = (name: string) =>
    readFileSync(
      join(
        __dirname,
        '../android/app/src/main/java/com/jinko/printbridge/',
        name,
      ),
      'utf8',
    ) as string;
  const cache = java('SettingsCache.java');
  expect(cache).toContain('REFRESH_MS = 5 * 60 * 1000L');
  expect(cache).toContain('RETRY_MS = 60 * 1000L');
  const service = java('OrderPollingService.java');
  const loader = service.slice(
    service.indexOf('private JSONObject loadServerSettings('),
    service.indexOf('private static int paperWidthDots('),
  );
  expect(loader).toContain('serverSettingsCache.refresh');
  expect(loader).toContain(
    'boolean force = !request.equals(lastSettingsRefreshRequest)',
  );
  expect(service).toContain(
    'registerOnSharedPreferenceChangeListener(settingsRefreshListener)',
  );
  expect(service).toContain(
    'unregisterOnSharedPreferenceChangeListener(settingsRefreshListener)',
  );
  expect(java('IminPrinterModule.java')).toContain(
    'public void requestSettingsRefresh(Promise promise)',
  );
});
