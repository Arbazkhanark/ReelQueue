import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { driveViewState, driveRedirectNotice, validateDriveUpload, uploadPercent } from './drive-ui';

const dto = (o: object = {}) => ({ enabled: true, status: 'CONNECTED' as const, scopes: [], connectedAt: null, ...o });
describe('drive-ui view state', () => {
  it('loading, error, disabled, disconnected, re-auth and connected are distinct', () => {
    assert.equal(driveViewState({ data: undefined, error: null, loading: true }), 'LOADING');
    assert.equal(driveViewState({ data: undefined, error: new Error('x'), loading: false }), 'ERROR');
    assert.equal(driveViewState({ data: dto({ enabled: false }), error: null, loading: false }), 'DISABLED');
    assert.equal(driveViewState({ data: dto({ status: 'NOT_CONNECTED' }), error: null, loading: false }), 'DISCONNECTED');
    assert.equal(driveViewState({ data: dto({ status: 'REAUTH_REQUIRED' }), error: null, loading: false }), 'REAUTH_REQUIRED');
    assert.equal(driveViewState({ data: dto(), error: null, loading: false }), 'CONNECTED');
    assert.equal(driveViewState({ data: dto(), error: new Error('refetch failed'), loading: false }), 'CONNECTED', 'stale data stays usable when a refetch fails');
  });
  it('callback redirect codes map to fixed messages; unknown codes never echo the query text', () => {
    assert.deepEqual(driveRedirectNotice('?connected=1'), { tone: 'ok', text: 'Google Drive connected.' });
    assert.equal(driveRedirectNotice('?error=ACCESS_DENIED')?.tone, 'danger');
    assert.equal(driveRedirectNotice('?error=<script>alert(1)</script>')?.text, 'Google Drive could not be connected.');
    assert.equal(driveRedirectNotice(''), null);
  });
  it('upload validation mirrors the server rules', () => {
    assert.equal(validateDriveUpload({ name: 'a.mp4', type: 'video/mp4', size: 10 }), null);
    assert.match(validateDriveUpload({ name: 'a.exe', type: 'application/zip', size: 10 })!, /MP4 or MOV/);
    assert.match(validateDriveUpload({ name: 'a.mp4', type: 'video/mp4', size: 2 * 1024 ** 3 })!, /1 GiB/);
    assert.match(validateDriveUpload({ name: 'a.mp4', type: 'video/mp4', size: 0 })!, /empty/);
  });
  it('progress is clamped', () => { assert.deepEqual([uploadPercent(5, 10), uploadPercent(11, 10), uploadPercent(1, 0), uploadPercent(-3, 10)], [50, 100, 0, 0]); });
});