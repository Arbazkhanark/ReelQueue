/**
 * Object-storage port (S3-compatible: Cloudflare R2 by default).
 * Only storage KEYS are persisted in the database; URLs are minted on demand and short-lived.
 */
export interface PresignedUpload {
  url: string;
  /** Headers the client MUST send with the PUT (they are part of the signature). */
  headers: Record<string, string>;
}

export interface ObjectHead {
  exists: boolean;
  sizeBytes?: number;
  contentType?: string;
}

export interface StorageProvider {
  presignUpload(key: string, opts: { contentType: string; expiresSeconds: number }): Promise<PresignedUpload>;
  /** Short-lived, publicly fetchable URL (used for previews and handed to Meta). */
  presignDownload(key: string, opts: { expiresSeconds: number }): Promise<string>;
  head(key: string): Promise<ObjectHead>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
}
