import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isWithinActiveHours, shouldCheckSpecialOpen } from '../index.mjs';

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
