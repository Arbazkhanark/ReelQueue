import type { ObjectHead, PresignedUpload, StorageProvider } from '@reelqueue/core';

/** In-memory StorageProvider with failure injection. Test double: lives under test/, never on a production path. */
export class FakeStorage implements StorageProvider {
  readonly objects = new Map<string, { size: number; contentType: string }>();
  readonly deleted: string[] = [];
  failPresign = false;
  failHead = false;
  failDelete = false;
  async presignUpload(key: string, o: { contentType: string; expiresSeconds: number }): Promise<PresignedUpload> {
    if (this.failPresign) throw new Error('presign down');
    return { url: `https://fake.example/${key}?exp=${o.expiresSeconds}`, headers: { 'Content-Type': o.contentType } };
  }
  async presignDownload(key: string): Promise<string> { return `https://fake.example/${key}?dl=1`; }
  async head(key: string): Promise<ObjectHead> {
    if (this.failHead) throw new Error('storage down');
    const o = this.objects.get(key);
    return o ? { exists: true, sizeBytes: o.size, contentType: o.contentType } : { exists: false };
  }
  async delete(key: string): Promise<void> {
    if (this.failDelete) throw new Error('delete down');
    this.objects.delete(key);
    this.deleted.push(key);
  }
  /** Simulates the browser's PUT. */
  put(key: string, size: number, contentType = 'video/mp4'): void { this.objects.set(key, { size, contentType }); }
}
