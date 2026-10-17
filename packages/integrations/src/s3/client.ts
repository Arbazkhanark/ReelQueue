import type { Clock, ObjectHead, PresignedUpload, StorageProvider } from '@reelqueue/core';
import { EMPTY_SHA256, UNSIGNED_PAYLOAD, presignQuery, signHeaders, uriEncode, type Credentials } from './sigv4';

export interface S3Config {
  /** e.g. https://<ACCOUNT_ID>.r2.cloudflarestorage.com (R2) or https://s3.amazonaws.com */
  endpoint: string;
  /** "auto" for Cloudflare R2. */
  region: string;
  bucket: string;
  credentials: Credentials;
  /** true: https://host/bucket/key (works everywhere); false: https://bucket.host/key (virtual-hosted). */
  forcePathStyle: boolean;
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
}>;

/**
 * S3-compatible StorageProvider (Cloudflare R2 by default) using our own SigV4 signer and the platform `fetch`.
 * Errors never include URLs, signatures or credentials.
 */
export class S3StorageProvider implements StorageProvider {
  private readonly url: URL;
  constructor(
    private readonly cfg: S3Config,
    private readonly deps: { clock: Clock; fetch?: FetchFn },
  ) {
    this.url = new URL(cfg.endpoint);
  }

  private target(key: string): { host: string; path: string; origin: string } {
    const host = this.cfg.forcePathStyle ? this.url.host : `${this.cfg.bucket}.${this.url.host}`;
    const path = this.cfg.forcePathStyle ? `/${this.cfg.bucket}/${key}` : `/${key}`;
    return { host, path, origin: `${this.url.protocol}//${host}` };
  }

  async presignUpload(key: string, opts: { contentType: string; expiresSeconds: number }): Promise<PresignedUpload> {
    const t = this.target(key);
    const query = presignQuery({
      method: 'PUT', host: t.host, path: t.path, headers: { 'content-type': opts.contentType }, payloadHash: UNSIGNED_PAYLOAD,
      region: this.cfg.region, credentials: this.cfg.credentials, now: this.deps.clock.now(), expiresSeconds: opts.expiresSeconds,
    });
    // content-type is a SIGNED header: the browser must send exactly this value.
    return { url: `${t.origin}${uriEncode(t.path, false)}?${query}`, headers: { 'Content-Type': opts.contentType } };
  }

  async presignDownload(key: string, opts: { expiresSeconds: number }): Promise<string> {
    const t = this.target(key);
    const query = presignQuery({
      method: 'GET', host: t.host, path: t.path, payloadHash: UNSIGNED_PAYLOAD, region: this.cfg.region,
      credentials: this.cfg.credentials, now: this.deps.clock.now(), expiresSeconds: opts.expiresSeconds,
    });
    return `${t.origin}${uriEncode(t.path, false)}?${query}`;
  }

  async head(key: string): Promise<ObjectHead> {
    const res = await this.signedRequest('HEAD', key);
    if (res.status === 404) return { exists: false };
    if (res.status !== 200) throw new Error(`Storage HEAD failed with status ${res.status}`);
    const len = Number(res.headers.get('content-length'));
    const type = res.headers.get('content-type');
    return { exists: true, ...(Number.isFinite(len) ? { sizeBytes: len } : {}), ...(type ? { contentType: type } : {}) };
  }

  async delete(key: string): Promise<void> {
    const res = await this.signedRequest('DELETE', key);
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) throw new Error(`Storage DELETE failed with status ${res.status}`);
  }

  private async signedRequest(method: 'HEAD' | 'DELETE', key: string) {
    const t = this.target(key);
    const headers = signHeaders({
      method, host: t.host, path: t.path, payloadHash: EMPTY_SHA256, region: this.cfg.region,
      credentials: this.cfg.credentials, now: this.deps.clock.now(),
    });
    const doFetch: FetchFn = this.deps.fetch ?? ((u, i) => fetch(u, i));
    return doFetch(`${t.origin}${uriEncode(t.path, false)}`, { method, headers });
  }
}
