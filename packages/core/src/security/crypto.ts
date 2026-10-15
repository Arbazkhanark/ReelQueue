import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Token encryption at rest: AES-256-GCM with a versioned key ring.
 *
 * Payload format (all base64url, ':'-separated):
 *   v1:<keyId>:<iv>:<ciphertext>:<authTag>
 *
 *  - A fresh random 96-bit IV is generated per encryption.
 *  - `aad` (additional authenticated data) binds the ciphertext to its context
 *    (e.g. the Instagram account id), so a ciphertext copied to another row
 *    fails authentication.
 *  - Rotation: add a new key to the ring and make it active; old payloads still
 *    decrypt with their recorded key id and `needsRotation()` flags them for
 *    re-encryption.
 *
 * Keys come from environment variables / a secrets manager, never from source.
 */
export interface KeyRing {
  /** keyId -> 32-byte key */
  keys: Record<string, Buffer>;
  activeKeyId: string;
}

export class DecryptionError extends Error {
  constructor(message = 'Unable to decrypt payload') {
    super(message);
    this.name = 'DecryptionError';
  }
}

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export class TokenCipher {
  private readonly keys: Map<string, Buffer>;
  private readonly activeKeyId: string;

  constructor(ring: KeyRing) {
    this.keys = new Map();
    for (const [id, key] of Object.entries(ring.keys)) {
      if (!KEY_ID_PATTERN.test(id)) throw new Error(`Invalid key id "${id}"`);
      if (key.length !== 32) throw new Error(`Encryption key "${id}" must be exactly 32 bytes`);
      this.keys.set(id, Buffer.from(key));
    }
    if (!this.keys.has(ring.activeKeyId)) {
      throw new Error(`Active key id "${ring.activeKeyId}" is not in the key ring`);
    }
    this.activeKeyId = ring.activeKeyId;
  }

  /**
   * Builds a ring from env-style config, e.g.
   *   TOKEN_ENCRYPTION_KEYS="k1:<base64 32 bytes>,k2:<base64 32 bytes>"
   *   TOKEN_ENCRYPTION_ACTIVE_KEY_ID="k2"
   */
  static fromEnv(keysSpec: string, activeKeyId: string): TokenCipher {
    const keys: Record<string, Buffer> = {};
    for (const part of keysSpec.split(',').map((s) => s.trim()).filter(Boolean)) {
      const idx = part.indexOf(':');
      if (idx <= 0) throw new Error('TOKEN_ENCRYPTION_KEYS entries must look like "<id>:<base64-key>"');
      keys[part.slice(0, idx)] = Buffer.from(part.slice(idx + 1), 'base64');
    }
    return new TokenCipher({ keys, activeKeyId });
  }

  encrypt(plaintext: string, aad: string): string {
    const key = this.keys.get(this.activeKeyId) as Buffer;
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      this.activeKeyId,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      tag.toString('base64url'),
    ].join(':');
  }

  decrypt(payload: string, aad: string): string {
    const parts = payload.split(':');
    if (parts.length !== 5 || parts[0] !== VERSION) throw new DecryptionError('Malformed payload');
    const [, keyId, ivB64, ctB64, tagB64] = parts as [string, string, string, string, string];
    const key = this.keys.get(keyId);
    if (!key) throw new DecryptionError('Unknown key id');
    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64url'));
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ctB64, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Deliberately generic: do not reveal whether key, aad or data was wrong.
      throw new DecryptionError();
    }
  }

  /** True if the payload was encrypted with a non-active key and should be re-encrypted. */
  needsRotation(payload: string): boolean {
    const parts = payload.split(':');
    return parts.length === 5 && parts[0] === VERSION && parts[1] !== this.activeKeyId;
  }
}
