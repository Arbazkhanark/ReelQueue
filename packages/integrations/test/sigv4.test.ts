import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { presignQuery, signHeaders, uriEncode, EMPTY_SHA256, UNSIGNED_PAYLOAD } from '../src/s3/sigv4';

const creds = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

describe('SigV4', () => {
  it('reproduces the AWS documentation presigned GET example', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const q = presignQuery({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      payloadHash: UNSIGNED_PAYLOAD,
      region: 'us-east-1',
      credentials: creds,
      now: new Date('2013-05-24T00:00:00Z'),
      expiresSeconds: 86400,
    });
    assert.match(q, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
    assert.ok(q.includes('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request'));
  });

  it('reproduces the AWS documentation header-signed GET with Range', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html (GET Object example)
    const h = signHeaders({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      headers: { range: 'bytes=0-9' },
      payloadHash: EMPTY_SHA256,
      region: 'us-east-1',
      credentials: creds,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    assert.match(h.authorization!, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  });

  it('encodes per RFC 3986 and keeps slashes in paths', () => {
    assert.equal(uriEncode("a b/c!'()*~.mp4"), 'a%20b%2Fc%21%27%28%29%2A~.mp4');
    assert.equal(uriEncode('a b/c', false), 'a%20b/c');
  });

  it('rejects out-of-range expiry', () => {
    const base = { method: 'GET', host: 'h', path: '/k', payloadHash: UNSIGNED_PAYLOAD, region: 'auto', credentials: creds, now: new Date() };
    assert.throws(() => presignQuery({ ...base, expiresSeconds: 0 }), RangeError);
    assert.throws(() => presignQuery({ ...base, expiresSeconds: 604_801 }), RangeError);
  });
});
