import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, type ExecuteOutcome } from '../src';
import { makeHarness, T0, type Harness } from './helpers/harness';

const MIN = 60_000;

function setup(opts?: Parameters<typeof makeHarness>[0], jobIds: string[] = ['j1']): Harness {
  const h = makeHarness(opts);
  h.addCycle();
  jobIds.forEach((id, i) => h.addJob(id, { sequenceNo: i + 1 }));
  return h;
}

/** Simulates a worker process dying mid-call: raw error, lease NOT released. */
function crashOnce(h: Harness, method: 'getContainerStatus' | 'publishContainer', opts: { afterEffect?: boolean } = {}): void {
  let crashed = false;
  if (method === 'getContainerStatus') {
    const orig = h.provider.getContainerStatus.bind(h.provider);
    h.provider.getContainerStatus = async (a, c) => {
      if (!crashed) {
        crashed = true;
        throw new Error('SIGKILL');
      }
      return orig(a, c);
    };
  } else {
    const orig = h.provider.publishContainer.bind(h.provider);
    h.provider.publishContainer = async (a, c) => {
      if (!crashed) {
        crashed = true;
        if (opts.afterEffect) await orig(a, c); // the post is really published...
        throw new Error('SIGKILL'); // ...but the worker dies before recording it
      }
      return orig(a, c);
    };
  }
}

const expectWait = (o: ExecuteOutcome, reason: string) => {
  assert.equal(o.kind, 'WAIT', JSON.stringify(o));
  if (o.kind === 'WAIT') {
    assert.equal(o.reason, reason);
    return o.runAt;
  }
  throw new Error('unreachable');
};

describe('happy path and honest labelling', () => {
  it('mock publication ends SIMULATED, never CONFIRMED, with a mock media id', async () => {
    const h = setup();
    const out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'SIMULATED' });
    const job = h.store.get('j1');
    assert.equal(job.status, 'SIMULATED');
    assert.match(job.mediaId ?? '', /^mock_media_/);
    assert.equal(job.leaseOwner, null);
    assert.equal(h.provider.isMock, true);
    assert.equal(h.provider.publications.length, 1);
  });

  it('records an attempt event for every provider call, in order', async () => {
    const h = setup();
    await h.executor.execute('j1', 'w1');
    assert.deepEqual(
      h.store.attempts.map((a) => [a.step, a.outcome]),
      [
        ['QUOTA_CHECK', 'SUCCESS'],
        ['CREATE_CONTAINER', 'SUCCESS'],
        ['POLL_STATUS', 'SUCCESS'],
        ['QUOTA_CHECK', 'SUCCESS'],
        ['PUBLISH', 'SUCCESS'],
      ],
    );
  });

  it('passes a short-lived media URL and the idempotency key to the provider', async () => {
    const h = setup();
    await h.executor.execute('j1', 'w1');
    const created = h.provider.calls.find((c) => c.op === 'createReelContainer');
    assert.equal(created?.args[1], h.store.get('j1').idempotencyKey);
  });

  it('a real (non-mock) provider ends CONFIRMED only after verification', async () => {
    const h = setup({ real: true });
    const out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'CONFIRMED' });
    assert.equal(h.store.get('j1').status, 'CONFIRMED');
    assert.ok(h.store.get('j1').permalink);
  });

  it('API-accepted but unverifiable stays ACCEPTED - never reported as confirmed', async () => {
    const h = setup({ real: true, config: { confirmMaxAttempts: 3 } });
    for (let i = 0; i < 3; i++) h.provider.scriptFault('confirmMedia', { error: new ProviderError('TRANSIENT', 'down') });
    let out = await h.executor.execute('j1', 'w1');
    h.clock.set(expectWait(out, 'CONFIRM'));
    out = await h.executor.execute('j1', 'w1');
    h.clock.set(expectWait(out, 'CONFIRM'));
    out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'ACCEPTED' });
    assert.equal(h.store.get('j1').status, 'ACCEPTED');
    assert.equal(h.provider.callCount('publishContainer'), 1, 'confirmation retries never re-publish');
  });
});

describe('duplicate queue delivery', () => {
  it('two workers receiving the same job at once publish exactly once', async () => {
    const h = setup();
    const [a, b] = await Promise.all([h.executor.execute('j1', 'w1'), h.executor.execute('j1', 'w2')]);
    const kinds = [a.kind, b.kind].sort();
    assert.deepEqual(kinds, ['COMPLETED', 'NOT_CLAIMED']);
    assert.equal(h.provider.publications.length, 1);
    assert.equal(h.provider.callCount('publishContainer'), 1);
  });

  it('redelivery after completion is a no-op', async () => {
    const h = setup();
    await h.executor.execute('j1', 'w1');
    const again = await h.executor.execute('j1', 'w2');
    assert.deepEqual(again, { kind: 'NOT_CLAIMED', reason: 'TERMINAL', retryAt: null });
    assert.equal(h.provider.publications.length, 1);
  });

  it('a stalled worker that lost its lease cannot publish after another worker took over', async () => {
    const h = setup();
    const orig = h.provider.getContainerStatus.bind(h.provider);
    h.provider.getContainerStatus = async (a, c) => {
      h.clock.advanceMinutes(10); // worker stalls longer than the 5 minute lease
      return orig(a, c);
    };
    const out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'LEASE_LOST' });
    assert.equal(h.provider.callCount('publishContainer'), 0);
  });
});

describe('worker crash recovery', () => {
  it('crash after container creation resumes the SAME container', async () => {
    const h = setup();
    crashOnce(h, 'getContainerStatus');
    await assert.rejects(h.executor.execute('j1', 'w1'), /SIGKILL/);

    const mid = h.store.get('j1');
    assert.equal(mid.status, 'PROCESSING_MEDIA');
    assert.ok(mid.containerId, 'container id was persisted before the crash');
    assert.ok(mid.leaseOwner, 'dead worker still holds the lease');

    const early = await h.executor.execute('j1', 'w2');
    assert.equal(early.kind === 'NOT_CLAIMED' && early.reason, 'LEASED');

    h.clock.advanceMinutes(6); // lease expires
    const out = await h.executor.execute('j1', 'w2');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'SIMULATED' });
    assert.equal(h.provider.callCount('createReelContainer'), 1);
    assert.equal(h.provider.publications.length, 1);
  });

  it('crash AFTER recording the publish intent but BEFORE the call: reconciles, publishes once', async () => {
    const h = setup();
    crashOnce(h, 'publishContainer');
    await assert.rejects(h.executor.execute('j1', 'w1'), /SIGKILL/);
    const mid = h.store.get('j1');
    assert.equal(mid.status, 'PUBLISH_REQUESTED');
    assert.ok(mid.publishRequestedAt);

    h.clock.advanceMinutes(6);
    const out = await h.executor.execute('j1', 'w2');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'SIMULATED' });
    assert.equal(h.provider.publications.length, 1);
  });

  it('crash AFTER the provider published (response lost): reconciliation finds it and does NOT publish again', async () => {
    const h = setup();
    crashOnce(h, 'publishContainer', { afterEffect: true });
    await assert.rejects(h.executor.execute('j1', 'w1'), /SIGKILL/);
    assert.equal(h.provider.publications.length, 1, 'the post really exists');

    h.clock.advanceMinutes(6);
    const out = await h.executor.execute('j1', 'w2');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'SIMULATED' });
    assert.equal(h.provider.callCount('publishContainer'), 1, 'publish was never called a second time');
    assert.equal(h.provider.publications.length, 1);
  });

  it('crash with an unusable container after the publish intent: starts a fresh container, publishes once', async () => {
    const h = setup();
    crashOnce(h, 'publishContainer');
    await assert.rejects(h.executor.execute('j1', 'w1'), /SIGKILL/);
    h.provider.forceContainerStatus(h.store.get('j1').containerId as string, 'EXPIRED');
    h.clock.advanceMinutes(6);
    const out = await h.executor.execute('j1', 'w2');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'SIMULATED' });
    assert.equal(h.provider.callCount('createReelContainer'), 2);
    assert.equal(h.provider.publications.length, 1);
  });
});

describe('uncertain publish outcomes (API timeouts)', () => {
  it('timeout where the provider DID publish: waits the settle window, reconciles, no second publish', async () => {
    const h = setup();
    h.provider.scriptFault('publishContainer', { error: new ProviderError('TIMEOUT', 'no response'), applyEffect: true });
    let out = await h.executor.execute('j1', 'w1');
    const runAt = expectWait(out, 'RECONCILE');
    assert.equal(runAt.getTime(), T0.getTime() + MIN, 'waits at least the settle window');
    assert.equal(h.store.get('j1').status, 'PUBLISH_REQUESTED');
    assert.equal(h.store.get('j1').attemptCount, 1);

    const early = await h.executor.execute('j1', 'w1');
    assert.equal(early.kind === 'NOT_CLAIMED' && early.reason, 'NOT_DUE');

    h.clock.set(runAt);
    out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'SIMULATED' });
    assert.equal(h.provider.callCount('publishContainer'), 1);
    assert.equal(h.provider.publications.length, 1);
  });

  it('timeout where the provider did NOT publish: after settling, publishes exactly once more', async () => {
    const h = setup();
    h.provider.scriptFault('publishContainer', { error: new ProviderError('TIMEOUT', 'no response') });
    let out = await h.executor.execute('j1', 'w1');
    h.clock.set(expectWait(out, 'RECONCILE'));
    out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'SIMULATED' });
    assert.equal(h.provider.callCount('publishContainer'), 2);
    assert.equal(h.provider.publications.length, 1);
  });

  it('does not touch the provider before the settle window has elapsed', async () => {
    const h = setup();
    crashOnce(h, 'publishContainer', { afterEffect: true });
    await assert.rejects(h.executor.execute('j1', 'w1'), /SIGKILL/);
    // Force the job claimable early (lease expired, due) to exercise the defensive branch.
    h.clock.advanceMs(20_000);
    const rec = h.store.jobs.get('j1')!;
    rec.leaseOwner = null;
    rec.leaseExpiresAt = null;
    rec.nextAttemptAt = h.clock.now();
    const statusCallsBefore = h.provider.callCount('getContainerStatus');
    const out = await h.executor.execute('j1', 'w2');
    expectWait(out, 'RECONCILE');
    assert.equal(h.provider.callCount('getContainerStatus'), statusCallsBefore);
  });

  it('when reconciliation itself keeps failing, the job fails NON-retryable and is never re-published', async () => {
    const h = setup({ config: { maxAttempts: 2 } });
    h.provider.scriptFault('publishContainer', { error: new ProviderError('TIMEOUT', 'no response'), applyEffect: true });
    let out = await h.executor.execute('j1', 'w1');
    h.clock.set(expectWait(out, 'RECONCILE'));
    h.provider.scriptFault('getContainerStatus', { error: new ProviderError('TIMEOUT', 'no response') });
    out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'FAILED', retryable: false, reason: 'PUBLISH_OUTCOME_UNKNOWN' });
    assert.equal(h.store.get('j1').retryable, false);
    assert.equal(h.provider.callCount('publishContainer'), 1);
  });

  it('timeout while creating a container retries with a new container; the orphan is never published', async () => {
    const h = setup();
    h.provider.scriptFault('createReelContainer', { error: new ProviderError('TIMEOUT', 'no response'), applyEffect: true });
    let out = await h.executor.execute('j1', 'w1');
    const runAt = expectWait(out, 'RETRY');
    assert.ok(runAt.getTime() >= T0.getTime() + 7_500 && runAt.getTime() <= T0.getTime() + 15_000, 'bounded backoff with jitter');
    assert.equal(h.store.get('j1').status, 'RETRY_WAIT');
    assert.equal(h.store.get('j1').attemptCount, 1);

    const early = await h.executor.execute('j1', 'w1');
    assert.equal(early.kind === 'NOT_CLAIMED' && early.reason, 'NOT_DUE');

    h.clock.set(runAt);
    out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'SIMULATED' });
    assert.equal(h.provider.callCount('createReelContainer'), 2);
    assert.equal(h.provider.publications.length, 1);
    assert.equal(h.provider.publications[0]!.containerId, 'mock_container_2');
  });
});

describe('retry policy', () => {
  it('stops after maxAttempts and marks the job manually retryable', async () => {
    const h = setup({ config: { maxAttempts: 3 } });
    for (let i = 0; i < 3; i++) h.provider.scriptFault('createReelContainer', { error: new ProviderError('TRANSIENT', 'blip') });
    let out: ExecuteOutcome = await h.executor.execute('j1', 'w1');
    h.clock.set(expectWait(out, 'RETRY'));
    out = await h.executor.execute('j1', 'w1');
    h.clock.set(expectWait(out, 'RETRY'));
    out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'FAILED', retryable: true, reason: 'RETRIES_EXHAUSTED' });
    assert.equal(h.store.get('j1').attemptCount, 3);
    assert.equal(h.provider.callCount('createReelContainer'), 3);
  });

  it('honours Retry-After from a rate-limit response', async () => {
    const h = setup();
    h.provider.scriptFault('createReelContainer', {
      error: new ProviderError('RATE_LIMITED', 'slow down', { retryAfterMs: 10 * MIN, httpStatus: 429 }),
    });
    const out = await h.executor.execute('j1', 'w1');
    const runAt = expectWait(out, 'RETRY');
    assert.ok(runAt.getTime() >= T0.getTime() + 10 * MIN);
  });

  it('does not retry rejected media: fails permanently after one container', async () => {
    const h = setup();
    h.provider.rejectedUrlFragments = ['video-j1'];
    const out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'FAILED', retryable: false, reason: 'MEDIA_REJECTED' });
    const job = h.store.get('j1');
    assert.equal(job.status, 'FAILED');
    assert.equal(job.lastErrorCode, 'MOCK_UNSUPPORTED_MEDIA');
    assert.equal(h.provider.callCount('createReelContainer'), 1);
    assert.equal(h.provider.callCount('publishContainer'), 0);
    const again = await h.executor.execute('j1', 'w1');
    assert.equal(again.kind === 'NOT_CLAIMED' && again.reason, 'TERMINAL');
  });

  it('media that never finishes processing times out and is retried with a fresh container', async () => {
    const h = setup();
    h.provider.processingPolls = 1000;
    let out: ExecuteOutcome = await h.executor.execute('j1', 'w1');
    for (let i = 0; i < 60 && out.kind === 'WAIT' && out.reason === 'POLL_MEDIA'; i++) {
      h.clock.set(out.runAt);
      out = await h.executor.execute('j1', 'w1');
    }
    const runAt = expectWait(out, 'RETRY');
    assert.equal(h.store.get('j1').containerId, null, 'stale container dropped');
    h.provider.processingPolls = 0;
    h.clock.set(runAt);
    out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'SIMULATED' });
    assert.equal(h.provider.callCount('createReelContainer'), 2);
  });

  it('an expired container is replaced rather than published', async () => {
    const h = setup();
    h.provider.processingPolls = 1;
    let out = await h.executor.execute('j1', 'w1');
    h.clock.set(expectWait(out, 'POLL_MEDIA'));
    h.provider.forceContainerStatus(h.store.get('j1').containerId as string, 'EXPIRED');
    out = await h.executor.execute('j1', 'w1');
    h.clock.set(expectWait(out, 'RETRY'));
    h.provider.processingPolls = 0;
    out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'SIMULATED' });
    assert.equal(h.provider.publications.length, 1);
  });

  it('polls a slow container non-blockingly across several executions, creating it once', async () => {
    const h = setup();
    h.provider.processingPolls = 2;
    let out: ExecuteOutcome = await h.executor.execute('j1', 'w1');
    h.clock.set(expectWait(out, 'POLL_MEDIA'));
    out = await h.executor.execute('j1', 'w1');
    h.clock.set(expectWait(out, 'POLL_MEDIA'));
    out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'SIMULATED' });
    assert.equal(h.provider.callCount('createReelContainer'), 1);
  });
});

describe('quota enforcement', () => {
  it('exhausted quota defers the job BEFORE spending a container, then publishes once quota frees up', async () => {
    const h = setup();
    h.provider.quota.used = h.provider.quota.total;
    let out = await h.executor.execute('j1', 'w1');
    const runAt = expectWait(out, 'DEFERRED');
    assert.equal(runAt.getTime(), T0.getTime() + 15 * MIN);
    const job = h.store.get('j1');
    assert.equal(job.status, 'DEFERRED');
    assert.equal(job.deferredReason, 'QUOTA_EXHAUSTED');
    assert.equal(h.provider.callCount('createReelContainer'), 0);
    assert.equal(h.provider.publications.length, 0);

    h.provider.quota.used = 0;
    h.clock.set(runAt);
    out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'SIMULATED' });
  });

  it('a quota rejection AT publish defers (not fails), keeps the container, and later publishes once', async () => {
    const h = setup();
    h.provider.scriptFault('publishContainer', {
      error: new ProviderError('QUOTA_EXHAUSTED', 'daily limit reached', { code: '9/2207042' }),
    });
    let out = await h.executor.execute('j1', 'w1');
    const runAt = expectWait(out, 'DEFERRED');
    const job = h.store.get('j1');
    assert.equal(job.status, 'DEFERRED');
    assert.equal(job.publishRequestedAt, null, 'definitive rejection clears the publish marker');
    assert.ok(job.containerId);

    h.clock.set(runAt);
    out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'SIMULATED' });
    assert.equal(h.provider.callCount('createReelContainer'), 1, 'same container reused');
    assert.equal(h.provider.publications.length, 1);
  });

  it('an unreadable quota fails closed (deferred), never publishing blind', async () => {
    const h = setup();
    h.provider.quota.total = 0; // invalid quota payload
    const out = await h.executor.execute('j1', 'w1');
    expectWait(out, 'DEFERRED');
    assert.equal(h.store.get('j1').deferredReason, 'QUOTA_UNKNOWN');
    assert.equal(h.provider.publications.length, 0);
  });
});

describe('expired tokens and revoked permissions', () => {
  it('an expired token pauses the cycle, returns the job to SCHEDULED and publishes nothing', async () => {
    const h = setup();
    h.provider.scriptFault('createReelContainer', { error: new ProviderError('AUTH_EXPIRED', 'token expired', { code: '190' }) });
    let out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'CYCLE_PAUSED', reason: 'ACCOUNT_REAUTH_REQUIRED' });
    assert.deepEqual(h.store.pauses, [{ cycleId: 'cycle-1', reason: 'ACCOUNT_REAUTH_REQUIRED' }]);
    assert.equal(h.store.get('j1').status, 'SCHEDULED');
    assert.equal(h.provider.publications.length, 0);

    // still paused until the user reconnects and resumes
    out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'CYCLE_PAUSED', reason: 'CYCLE_PAUSED' });

    h.store.setCycleStatus('cycle-1', 'ACTIVE'); // user reconnected + resumed
    out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'SIMULATED' });
  });

  it('an auth failure detected at the quota check also pauses the cycle without retrying', async () => {
    const h = setup();
    h.provider.scriptFault('getPublishingQuota', { error: new ProviderError('PERMISSION_REVOKED', 'permission revoked') });
    const out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'CYCLE_PAUSED', reason: 'PERMISSION_REVOKED' });
    assert.equal(h.provider.callCount('getPublishingQuota'), 1);
    assert.equal(h.provider.callCount('createReelContainer'), 0);
  });

  it('a token revoked exactly at publish is a definitive rejection: pause, no duplicate risk', async () => {
    const h = setup();
    h.provider.scriptFault('publishContainer', { error: new ProviderError('AUTH_EXPIRED', 'token expired') });
    const out = await h.executor.execute('j1', 'w1');
    assert.equal(out.kind, 'CYCLE_PAUSED');
    const job = h.store.get('j1');
    assert.equal(job.status, 'SCHEDULED');
    assert.equal(job.publishRequestedAt, null);
    assert.equal(h.provider.publications.length, 0);
  });
});

describe('stop, pause and expiry semantics', () => {
  it('stop between executions cancels the job before any publish', async () => {
    const h = setup();
    h.provider.processingPolls = 3;
    let out = await h.executor.execute('j1', 'w1');
    h.clock.set(expectWait(out, 'POLL_MEDIA'));
    h.store.setCycleStatus('cycle-1', 'STOPPED');
    out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'CANCELLED' });
    assert.equal(h.store.get('j1').status, 'CANCELLED');
    assert.equal(h.store.get('j1').failureReason, 'CYCLE_STOPPED');
    assert.equal(h.provider.callCount('publishContainer'), 0);
  });

  it('stop racing in right before the irreversible call still prevents the publish', async () => {
    const h = setup();
    const orig = h.provider.getContainerStatus.bind(h.provider);
    h.provider.getContainerStatus = async (a, c) => {
      const r = await orig(a, c);
      h.store.setCycleStatus('cycle-1', 'STOPPED'); // user hits Stop mid-flight
      return r;
    };
    const out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'CANCELLED' });
    assert.equal(h.provider.callCount('publishContainer'), 0);
    assert.equal(h.provider.publications.length, 0);
  });

  it('a job whose cycle expired while waiting is EXPIRED, not published (no stale publishing)', async () => {
    const h = makeHarness();
    h.addCycle('cycle-1', { endsAt: new Date(T0.getTime() + 10 * MIN) });
    h.addJob('j1');
    h.provider.processingPolls = 1;
    let out = await h.executor.execute('j1', 'w1');
    h.clock.set(expectWait(out, 'POLL_MEDIA'));
    h.clock.advanceMinutes(11); // past endsAt; the cycle row still says ACTIVE (expiry job is late)
    out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'EXPIRED' });
    assert.equal(h.store.get('j1').status, 'EXPIRED');
    assert.equal(h.provider.publications.length, 0);
  });

  it('a stale job from an old, stopped cycle never publishes even if redelivered later', async () => {
    const h = setup();
    h.store.setCycleStatus('cycle-1', 'STOPPED');
    const out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'CANCELLED' });
    h.addCycle('cycle-2'); // a later cycle starts; the old job stays dead
    const again = await h.executor.execute('j1', 'w1');
    assert.equal(again.kind === 'NOT_CLAIMED' && again.reason, 'TERMINAL');
    assert.equal(h.provider.publications.length, 0);
  });

  it('pause returns the job to SCHEDULED; resume lets it complete', async () => {
    const h = setup();
    h.store.setCycleStatus('cycle-1', 'PAUSED');
    let out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'CYCLE_PAUSED', reason: 'CYCLE_PAUSED' });
    assert.equal(h.store.get('j1').status, 'SCHEDULED');
    h.store.setCycleStatus('cycle-1', 'ACTIVE');
    out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'SIMULATED' });
  });

  it('an in-flight publish is never cancelled by Stop: it is reconciled to learn the true outcome', async () => {
    const h = setup();
    h.provider.scriptFault('publishContainer', { error: new ProviderError('TIMEOUT', 'no response'), applyEffect: true });
    let out = await h.executor.execute('j1', 'w1');
    const runAt = expectWait(out, 'RECONCILE');
    h.store.setCycleStatus('cycle-1', 'STOPPED'); // user stops AFTER the publish was sent
    h.clock.set(runAt);
    out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'COMPLETED', status: 'SIMULATED' });
    assert.equal(h.provider.publications.length, 1, 'the already-accepted publish is recorded, not hidden');
  });

  it('after reconciling an UNPUBLISHED post, a stopped cycle cancels instead of re-publishing', async () => {
    const h = setup();
    h.provider.scriptFault('publishContainer', { error: new ProviderError('TIMEOUT', 'no response') });
    const out0 = await h.executor.execute('j1', 'w1');
    const runAt = expectWait(out0, 'RECONCILE');
    h.store.setCycleStatus('cycle-1', 'STOPPED');
    h.clock.set(runAt);
    const out = await h.executor.execute('j1', 'w1');
    assert.deepEqual(out, { kind: 'CANCELLED' });
    assert.equal(h.provider.callCount('publishContainer'), 1);
    assert.equal(h.provider.publications.length, 0);
  });
});

describe('per-account ordering and concurrency', () => {
  it('a later job cannot run before an earlier job of the same account', async () => {
    const h = setup(undefined, ['j1', 'j2']);
    const early = await h.executor.execute('j2', 'w1');
    assert.equal(early.kind === 'NOT_CLAIMED' && early.reason, 'OUT_OF_ORDER');
    assert.deepEqual(await h.executor.execute('j1', 'w1'), { kind: 'COMPLETED', status: 'SIMULATED' });
    assert.deepEqual(await h.executor.execute('j2', 'w1'), { kind: 'COMPLETED', status: 'SIMULATED' });
    // Ids come from one shared counter (containers and media), so assert order, not exact values.
    const ids = h.provider.publications.map((p) => Number(p.containerId.replace('mock_container_', '')));
    assert.equal(ids.length, 2);
    assert.ok((ids[0] ?? Infinity) < (ids[1] ?? -Infinity), 'j1 must be published before j2');
  });

  it('a deferred earlier job (quota) holds back later jobs so order is preserved', async () => {
    const h = setup(undefined, ['j1', 'j2']);
    h.provider.quota.used = h.provider.quota.total;
    expectWait(await h.executor.execute('j1', 'w1'), 'DEFERRED');
    const blocked = await h.executor.execute('j2', 'w1');
    assert.equal(blocked.kind === 'NOT_CLAIMED' && blocked.reason, 'OUT_OF_ORDER');
    assert.equal(h.provider.publications.length, 0);
  });

  it('a permanently failed earlier job does not block later jobs', async () => {
    const h = setup(undefined, ['j1', 'j2']);
    h.provider.rejectedUrlFragments = ['video-j1'];
    assert.equal((await h.executor.execute('j1', 'w1')).kind, 'FAILED');
    assert.deepEqual(await h.executor.execute('j2', 'w1'), { kind: 'COMPLETED', status: 'SIMULATED' });
  });

  it('two jobs of the same account never run concurrently (ACCOUNT_BUSY)', async () => {
    const h = setup(undefined, ['ja', 'jb']); // ja = sequence 1, jb = sequence 2
    // Another worker legitimately holds the earliest job's lease.
    const held = await h.store.claim('ja', { workerId: 'x', now: h.clock.now(), leaseMs: 5 * MIN });
    assert.equal(held.claimed, true);
    const out = await h.executor.execute('jb', 'w1');
    assert.equal(out.kind === 'NOT_CLAIMED' && out.reason, 'ACCOUNT_BUSY');
  });

  it('different accounts do not block each other', async () => {
    const h = makeHarness();
    h.addCycle();
    h.addJob('a1', { accountId: 'acct-1', sequenceNo: 1 });
    h.addJob('b1', { accountId: 'acct-2', sequenceNo: 1 });
    const [a, b] = await Promise.all([h.executor.execute('a1', 'w1'), h.executor.execute('b1', 'w2')]);
    assert.deepEqual(a, { kind: 'COMPLETED', status: 'SIMULATED' });
    assert.deepEqual(b, { kind: 'COMPLETED', status: 'SIMULATED' });
  });
});
