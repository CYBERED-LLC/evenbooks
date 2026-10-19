import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Object storage abstraction. Keys are always company-scoped
 * (`companies/<companyId>/...`). The web app authorizes every download; for S3
 * it hands out short-lived presigned URLs, for local disk it streams the file
 * itself.
 */
export interface StoredObject {
  body: Uint8Array;
  contentType: string;
  size: number;
}

export interface ObjectStorage {
  readonly driver: 'local' | 's3';
  putObject(key: string, body: Uint8Array, contentType: string): Promise<{ sha256: string; size: number }>;
  getObject(key: string): Promise<StoredObject | null>;
  deleteObject(key: string): Promise<void>;
  headObject(key: string): Promise<{ size: number; contentType: string } | null>;
  /** Presigned URL for direct download when supported; null means stream through the app. */
  presignedGetUrl(key: string, opts: { expiresInSeconds: number; fileName: string; contentType: string }): Promise<string | null>;
}

function assertSafeKey(key: string): void {
  if (!/^companies\/[0-9a-f-]{36}\/[A-Za-z0-9_\-./]+$/.test(key) || key.includes('..')) {
    throw new Error(`Unsafe object key: ${key}`);
  }
}

export function sha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

export class LocalStorage implements ObjectStorage {
  readonly driver = 'local' as const;
  constructor(private readonly rootDir: string) {}

  private resolve(key: string): string {
    assertSafeKey(key);
    return path.join(this.rootDir, key);
  }

  async putObject(key: string, body: Uint8Array, contentType: string) {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    await writeFile(`${file}.meta.json`, JSON.stringify({ contentType }));
    return { sha256: sha256(body), size: body.byteLength };
  }

  async getObject(key: string): Promise<StoredObject | null> {
    const file = this.resolve(key);
    try {
      const body = await readFile(file);
      const meta = JSON.parse(await readFile(`${file}.meta.json`, 'utf8').catch(() => '{}')) as { contentType?: string };
      return { body, contentType: meta.contentType ?? 'application/octet-stream', size: body.byteLength };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    const file = this.resolve(key);
    await rm(file, { force: true });
    await rm(`${file}.meta.json`, { force: true });
  }

  async headObject(key: string) {
    const file = this.resolve(key);
    try {
      const s = await stat(file);
      const meta = JSON.parse(await readFile(`${file}.meta.json`, 'utf8').catch(() => '{}')) as { contentType?: string };
      return { size: s.size, contentType: meta.contentType ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  }

  async presignedGetUrl(): Promise<string | null> {
    return null;
  }
}

export interface S3StorageConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

/** S3-compatible storage (Railway buckets, AWS S3). Loaded lazily so local dev does not need the SDK at startup. */
export class S3Storage implements ObjectStorage {
  readonly driver = 's3' as const;
  private clientPromise: Promise<import('@aws-sdk/client-s3').S3Client> | null = null;

  constructor(private readonly cfg: S3StorageConfig) {}

  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = import('@aws-sdk/client-s3').then(
        ({ S3Client }) =>
          new S3Client({
            endpoint: this.cfg.endpoint,
            region: this.cfg.region,
            forcePathStyle: this.cfg.forcePathStyle ?? false,
            credentials: { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey },
            // Some S3-compatible stores reject the SDK's default CRC checksums.
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
          }),
      );
    }
    return this.clientPromise;
  }

  async putObject(key: string, body: Uint8Array, contentType: string) {
    assertSafeKey(key);
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.client()).send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType }));
    return { sha256: sha256(body), size: body.byteLength };
  }

  async getObject(key: string): Promise<StoredObject | null> {
    assertSafeKey(key);
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      const res = await (await this.client()).send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      const body = await res.Body!.transformToByteArray();
      return { body, contentType: res.ContentType ?? 'application/octet-stream', size: body.byteLength };
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    assertSafeKey(key);
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.client()).send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }

  async headObject(key: string) {
    assertSafeKey(key);
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      const res = await (await this.client()).send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return { size: Number(res.ContentLength ?? 0), contentType: res.ContentType ?? 'application/octet-stream' };
    } catch (err) {
      if ((err as { name?: string }).name === 'NotFound') return null;
      throw err;
    }
  }

  async presignedGetUrl(key: string, opts: { expiresInSeconds: number; fileName: string; contentType: string }): Promise<string> {
    assertSafeKey(key);
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const safeName = opts.fileName.replace(/[^A-Za-z0-9._-]/g, '_');
    return getSignedUrl(
      await this.client(),
      new GetObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${safeName}"`,
        ResponseContentType: opts.contentType,
      }),
      { expiresIn: opts.expiresInSeconds },
    );
  }
}

export function createStorageFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectStorage {
  if ((env.STORAGE_DRIVER ?? 'local') === 's3') {
    const required = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;
    for (const k of required) if (!env[k]) throw new Error(`${k} is required when STORAGE_DRIVER=s3`);
    return new S3Storage({
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION ?? 'auto',
      bucket: env.S3_BUCKET!,
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    });
  }
  return new LocalStorage(resolveLocalDir(env.STORAGE_LOCAL_DIR ?? './.data/storage'));
}

/**
 * Relative STORAGE_LOCAL_DIR values are resolved against the repository root
 * (nearest ancestor containing pnpm-workspace.yaml), not the process cwd, so
 * web, worker and scripts share one store in local development.
 */
export function resolveLocalDir(dir: string): string {
  if (path.isAbsolute(dir)) return dir;
  let cur = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(cur, 'pnpm-workspace.yaml'))) return path.resolve(cur, dir);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(dir);
}
