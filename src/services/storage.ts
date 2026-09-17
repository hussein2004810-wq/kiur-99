/**
 * Cloudflare R2 storage service — mirrors Python app/storage.py.
 * Uses native R2 Worker bindings (env.R2_BUCKET).
 */

export interface StorageService {
  save(name: string, data: ArrayBuffer | Uint8Array, contentType: string): Promise<void>;
  get(name: string): Promise<R2ObjectBody | null>;
  delete(name: string): Promise<void>;
  exists(name: string): Promise<boolean>;
  getWithRange(name: string, rangeHeader: string | null): Promise<{
    object: R2ObjectBody;
    status: 200 | 206;
    headers: Record<string, string>;
  } | null>;
}

export function createStorageService(bucket: R2Bucket): StorageService {
  return {
    async save(name, data, contentType) {
      await bucket.put(name, data, { httpMetadata: { contentType } });
    },

    async get(name) {
      return bucket.get(name);
    },

    async delete(name) {
      await bucket.delete(name);
    },

    async exists(name) {
      const head = await bucket.head(name);
      return head !== null;
    },

    async getWithRange(name, rangeHeader) {
      if (!rangeHeader) {
        const obj = await bucket.get(name);
        if (!obj) return null;
        const headers: Record<string, string> = {
          'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
          'Content-Length': String(obj.size),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=3600',
        };
        if (obj.etag) headers['ETag'] = obj.etag;
        return { object: obj, status: 200, headers };
      }

      // Parse Range: bytes=start-end
      const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
      if (!match) return null;

      const head = await bucket.head(name);
      if (!head) return null;
      const total = head.size;

      const start = match[1] ? parseInt(match[1]) : total - parseInt(match[2]);
      const end = match[2] ? Math.min(parseInt(match[2]), total - 1) : total - 1;

      const obj = await bucket.get(name, {
        range: { offset: start, length: end - start + 1 },
      });
      if (!obj) return null;

      const headers: Record<string, string> = {
        'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
      };
      if (head.etag) headers['ETag'] = head.etag;
      return { object: obj, status: 206, headers };
    },
  };
}

/**
 * Generate a safe upload filename.
 * Mirrors Python's safe_upload_name() in admin.py.
 */
export function safeUploadName(
  originalName: string | null | undefined,
  allowedExts: string[],
  prefix: string
): string {
  const ext = (originalName ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (!allowedExts.includes(ext)) {
    throw new Error(`نوع الملف غير مسموح به. الأنواع المسموح بها: ${allowedExts.join(', ')}`);
  }
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}_${id}.${ext}`;
}

export function mediaUrl(name: string): string {
  return `/media-files/${name}`;
}

export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
export const PDF_EXTS = ['pdf'];
export const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'avi'];
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
