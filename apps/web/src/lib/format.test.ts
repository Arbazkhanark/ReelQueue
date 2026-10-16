import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, formatCountdown, formatDateTime, formatDuration, formatTime, isValidTimezone, plural, timezoneLabel, tzOffsetMs, zonedDayStartISO } from './format';

test('formatCountdown', () => {
  assert.equal(formatCountdown(0), '0s');
  assert.equal(formatCountdown(-5000), '0s');
  assert.equal(formatCountdown(59_999), '59s');
  assert.equal(formatCountdown(61_000), '1m 01s');
  assert.equal(formatCountdown(3_661_000), '1h 01m 01s');
  assert.equal(formatCountdown(24 * 3600_000 - 1000), '23h 59m 59s');
  assert.equal(formatCountdown(25 * 3600_000), '1d 1h 00m');
  assert.equal(formatCountdown(Number.NaN), '—');
});
test('formatDateTime renders in the requested timezone', () => {
  const iso = '2026-10-16T20:30:00.000Z';
  assert.equal(formatDateTime(iso, 'UTC'), '16 Oct 2026, 20:30');
  assert.equal(formatDateTime(iso, 'Asia/Kolkata'), '17 Oct 2026, 02:00');
  assert.equal(formatDateTime(iso, 'America/New_York'), '16 Oct 2026, 16:30');
  assert.equal(formatDateTime(null, 'UTC'), '—');
  assert.equal(formatDateTime('garbage', 'UTC'), '—');
});
test('formatTime with seconds', () => {
  assert.equal(formatTime('2026-10-16T20:30:05.000Z', 'UTC', true), '20:30:05');
  assert.equal(formatTime('2026-10-16T20:30:05.000Z', 'Asia/Kolkata'), '02:00');
});
test('invalid timezone does not throw', () => {
  assert.equal(isValidTimezone('Nope/Zone'), false);
  assert.equal(isValidTimezone('Europe/Berlin'), true);
  assert.equal(typeof formatDateTime('2026-10-16T20:30:00.000Z', 'Nope/Zone'), 'string');
});
test('timezoneLabel', () => {
  assert.match(timezoneLabel('Asia/Kolkata', new Date('2026-10-16T00:00:00Z')), /GMT\+5:30/);
});
test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(10 * 1024 * 1024), '10.0 MB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.00 GB');
  assert.equal(formatBytes(-1), '—');
});
test('formatDuration and plural', () => {
  assert.equal(formatDuration(65_400), '1:05');
  assert.equal(formatDuration(null), '—');
  assert.equal(plural(1, 'video'), '1 video');
  assert.equal(plural(3, 'video'), '3 videos');
});
test('tzOffsetMs', () => {
  assert.equal(tzOffsetMs(Date.UTC(2026, 9, 16, 12), 'Asia/Kolkata'), 5.5 * 3600_000);
  assert.equal(tzOffsetMs(Date.UTC(2026, 6, 1, 12), 'America/New_York'), -4 * 3600_000); // EDT
  assert.equal(tzOffsetMs(Date.UTC(2026, 0, 1, 12), 'America/New_York'), -5 * 3600_000); // EST
});
test('zonedDayStartISO gives local midnight as an instant', () => {
  assert.equal(zonedDayStartISO('2026-10-16', 'UTC'), '2026-10-16T00:00:00.000Z');
  assert.equal(zonedDayStartISO('2026-10-16', 'Asia/Kolkata'), '2026-10-15T18:30:00.000Z');
  assert.equal(zonedDayStartISO('2026-10-16', 'Asia/Kolkata', 1), '2026-10-16T18:30:00.000Z');
  assert.equal(zonedDayStartISO('2026-07-01', 'America/New_York'), '2026-07-01T04:00:00.000Z');
  // DST end in New York 2026-11-01: day is 25h long; next-day start is 05:00Z
  assert.equal(zonedDayStartISO('2026-11-01', 'America/New_York'), '2026-11-01T04:00:00.000Z');
  assert.equal(zonedDayStartISO('2026-11-01', 'America/New_York', 1), '2026-11-02T05:00:00.000Z');
  assert.equal(zonedDayStartISO('bad', 'UTC'), null);
  assert.equal(zonedDayStartISO('2026-10-16', 'Nope/Zone'), null);
});
