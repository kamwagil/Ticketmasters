import { HeadBucketCommand, PutObjectCommand, S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { config } from './config';
import { AppError } from './errors';

export const LOCAL_MEDIA_DIR = path.resolve(process.cwd(), 'storage', 'media');

const SIGNATURES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
];

/** Object storage for event images. Driver is chosen by STORAGE_DRIVER (local | s3). */
@Injectable()
export class StorageService {
  private s3?: S3Client;
  private bucketReady = false;

  private client(): S3Client {
    if (!this.s3) {
      this.s3 = new S3Client({
        region: config.storage.region,
        endpoint: config.storage.endpoint || undefined,
        forcePathStyle: !!config.storage.endpoint,
        credentials: { accessKeyId: config.storage.accessKey, secretAccessKey: config.storage.secretKey },
      });
    }
    return this.s3;
  }

  /**
   * Stores an uploaded image. The type is decided from the file's magic bytes, not the
   * client-supplied name or Content-Type, and the stored name is server-generated.
   */
  async saveImage(buffer: Buffer, folder: string): Promise<{ url: string; key: string }> {
    if (buffer.length > 5 * 1024 * 1024) throw new AppError('FILE_TOO_LARGE', 'Images must be 5 MB or smaller', 413);
    const kind = SIGNATURES.find((s) => s.test(buffer));
    if (!kind) throw new AppError('FILE_TYPE_NOT_ALLOWED', 'Only PNG, JPEG and WebP images are accepted', 415);
    const key = `${folder.replace(/[^a-z0-9/_-]/gi, '')}/${randomUUID()}.${kind.ext}`;

    if (config.storage.driver === 's3') {
      const s3 = this.client();
      if (!this.bucketReady) {
        try {
          await s3.send(new HeadBucketCommand({ Bucket: config.storage.bucket }));
        } catch {
          await s3.send(new CreateBucketCommand({ Bucket: config.storage.bucket }));
        }
        this.bucketReady = true;
      }
      await s3.send(new PutObjectCommand({ Bucket: config.storage.bucket, Key: key, Body: buffer, ContentType: kind.mime, CacheControl: 'public, max-age=31536000, immutable' }));
      const base = config.storage.publicUrl || `${config.storage.endpoint}/${config.storage.bucket}`;
      return { key, url: `${base.replace(/\/$/, '')}/${key}` };
    }

    const file = path.join(LOCAL_MEDIA_DIR, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, buffer);
    return { key, url: `${config.apiPublicUrl}/media/${key}` };
  }

  async health(): Promise<{ ok: boolean; driver: string; detail?: string }> {
    try {
      if (config.storage.driver === 's3') {
        await this.client().send(new HeadBucketCommand({ Bucket: config.storage.bucket }));
      } else {
        await fs.mkdir(LOCAL_MEDIA_DIR, { recursive: true });
        await fs.access(LOCAL_MEDIA_DIR);
      }
      return { ok: true, driver: config.storage.driver };
    } catch (e) {
      return { ok: false, driver: config.storage.driver, detail: (e as Error).message };
    }
  }
}
