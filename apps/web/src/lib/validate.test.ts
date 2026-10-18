import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWholeNumber, safeNextPath, validateEmail, validateNewPassword, validateScheduler } from './validate';

const limits = { batchSize: { min: 1, max: 50 }, intervalMinutes: { min: 5, max: 1440 }, cycleDurationHours: { min: 1, max: 168 } };

test('parseWholeNumber', () => {
  assert.equal(parseWholeNumber('20'), 20);
  assert.equal(parseWholeNumber(' 7 '), 7);
  assert.equal(parseWholeNumber('2.5'), null);
  assert.equal(parseWholeNumber('-1'), null);
  assert.equal(parseWholeNumber(''), null);
  assert.equal(parseWholeNumber(3), 3);
  assert.equal(parseWholeNumber(3.1), null);
});
test('validateScheduler accepts in-range values (defaults 20 min / 24h)', () => {
  const r = validateScheduler({ batchSize: '1', intervalMinutes: '20', cycleDurationHours: '24' }, limits);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value, { batchSize: 1, intervalMinutes: 20, cycleDurationHours: 24 });
});
test('validateScheduler reports each out-of-range field against the limits', () => {
  const r = validateScheduler({ batchSize: '0', intervalMinutes: '4', cycleDurationHours: '169' }, limits);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.errors.batchSize ?? '', /between 1 and 50/);
    assert.match(r.errors.intervalMinutes ?? '', /between 5 and 1440 minutes/);
    assert.match(r.errors.cycleDurationHours ?? '', /between 1 and 168 hours/);
  }
});
test('validateScheduler rejects non-integers', () => {
  const r = validateScheduler({ batchSize: 'abc', intervalMinutes: '20.5', cycleDurationHours: '' }, limits);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(Object.keys(r.errors).length, 3);
});
test('boundaries are inclusive', () => {
  assert.ok(validateScheduler({ batchSize: 50, intervalMinutes: 5, cycleDurationHours: 168 }, limits).ok);
  assert.ok(!validateScheduler({ batchSize: 51, intervalMinutes: 5, cycleDurationHours: 168 }, limits).ok);
});
test('validateEmail / validateNewPassword', () => {
  assert.equal(validateEmail('a@b.co'), null);
  assert.notEqual(validateEmail('nope'), null);
  assert.notEqual(validateEmail(''), null);
  assert.equal(validateNewPassword('long-enough-1'), null);
  assert.notEqual(validateNewPassword('short'), null);
  assert.notEqual(validateNewPassword('elevenchars'), null, 'server minimum is 12');
});
test('safeNextPath blocks open redirects', () => {
  assert.equal(safeNextPath('/videos'), '/videos');
  assert.equal(safeNextPath('/history?status=FAILED'), '/history?status=FAILED');
  assert.equal(safeNextPath('//evil.com'), '/dashboard');
  assert.equal(safeNextPath('https://evil.com'), '/dashboard');
  assert.equal(safeNextPath('/\\evil.com'), '/dashboard');
  assert.equal(safeNextPath('/login'), '/dashboard');
  assert.equal(safeNextPath(null), '/dashboard');
});
