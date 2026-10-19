import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/**
 * AES-256-GCM envelope for stored secrets (SimpleFIN access URLs). The key is
 * APP_ENCRYPTION_KEY: 32 bytes, base64. Ciphertext format: v1:<iv>:<tag>:<data> (base64url).
 * Key recovery procedure is documented in docs/runbook.md; keep the key out of
 * database backups.
 */
export class SecretBox {
  private readonly key: Buffer;
  constructor(keyBase64: string, public readonly keyVersion = 1) {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must decode to 32 bytes');
    this.key = key;
  }

  static generateKey(): string {
    return randomBytes(32).toString('base64');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join(':');
  }

  decrypt(ciphertext: string): string {
    const [v, ivB, tagB, dataB] = ciphertext.split(':');
    if (v !== 'v1' || !ivB || !tagB || !dataB) throw new Error('Malformed ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64url')), decipher.final()]).toString('utf8');
  }
}

/** SHA-256 hex digest, used for public tokens (stored hashed, never plain). */
export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 256-bit URL-safe random token. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
