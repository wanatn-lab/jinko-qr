import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isWithinActiveHours } from '../index.mjs';

// Bangkok is UTC+7, so 11:00 Bangkok = 04:00 UTC and 21:00 Bangkok = 14:00 UTC.
const at = (isoUtc) => new Date(isoUtc);

test('open from 11:00 up to (not including) 21:00 Bangkok time', () => {
  const config = {};
  assert.equal(isWithinActiveHours(config, at('2026-10-09T03:59:00Z')), false); // 10:59
  assert.equal(isWithinActiveHours(config, at('2026-10-09T04:00:00Z')), true); // 11:00
  assert.equal(isWithinActiveHours(config, at('2026-10-09T13:59:00Z')), true); // 20:59
  assert.equal(isWithinActiveHours(config, at('2026-10-09T14:00:00Z')), false); // 21:00
  assert.equal(isWithinActiveHours(config, at('2026-10-09T17:00:00Z')), false); // 00:00 next day
});

test('custom hours from config.json are respected', () => {
  const config = { activeHours: { start: 9, end: 22, timeZone: 'Asia/Bangkok' } };
  assert.equal(isWithinActiveHours(config, at('2026-10-09T02:00:00Z')), true); // 09:00
  assert.equal(isWithinActiveHours(config, at('2026-10-09T15:00:00Z')), false); // 22:00
});

test('activeHours: null keeps the agent running all day', () => {
  assert.equal(isWithinActiveHours({ activeHours: null }, at('2026-10-09T17:00:00Z')), true);
});
