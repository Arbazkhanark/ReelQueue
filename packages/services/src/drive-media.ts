// packages/services/src/drive-media.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed, time-limited URLs for videos that stay in Google Drive. The API serves those bytes itself
 * (GET /v1/media/drive/:videoId), so Instagram can fetch them without any object storage.
 * The signature covers the video id and the expiry; it carries no secret and cannot be reused for another video.
 */
export class DriveMediaSigner {
  constructor(private readonly secret: string, private readonly baseUrl: string, private readonly now: () => Date) {}

  private mac(videoId: string, exp: number): Buffer {
    return createHmac('sha256', `reelqueue-drive-media:${this.secret}`).update(`${videoId}.${exp}`).digest();
  }

  sign(videoId: string, ttlSeconds: number): { url: string; expiresAt: Date } {
    const ttl = Math.min(Math.max(Math.floor(ttlSeconds), 60), 86_400);
    const exp = Math.floor(this.now().getTime() / 1000) + ttl;
    const sig = this.mac(videoId, exp).toString('base64url');
    return { url: `${this.baseUrl.replace(/\/+$/, '')}/v1/media/drive/${videoId}?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000) };
  }

  verify(videoId: string, expRaw: string, sigRaw: string): boolean {
    if (!/^\d{1,12}$/.test(expRaw) || !/^[A-Za-z0-9_-]{20,64}$/.test(sigRaw)) return false;
    const exp = Number(expRaw);
    if (exp * 1000 <= this.now().getTime()) return false;
    const want = this.mac(videoId, exp);
    const got = Buffer.from(sigRaw, 'base64url');
    return got.length === want.length && timingSafeEqual(got, want);
  }
}