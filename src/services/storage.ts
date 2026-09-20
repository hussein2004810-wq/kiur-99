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

export function isStorageConfigured(bucket?: R2Bucket): bucket is R2Bucket {
  return Boolean(bucket);
}

export function createStorageService(bucket?: R2Bucket): StorageService {
  return {
    async save(name, data, contentType) {
      if (!bucket) throw new Error('R2 storage is not enabled or configured yet.');
      await bucket.put(name, data, { httpMetadata: { contentType } });
    },

    async get(name) {
      if (!bucket) return null;
      return bucket.get(name);
    },

    async delete(name) {
      if (!bucket) return;
      await bucket.delete(name);
    },

    async exists(name) {
      if (!bucket) return false;
      const head = await bucket.head(name);
      return head !== null;
    },

    async getWithRange(name, rangeHeader) {
      if (!bucket) return null;
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

/**
 * Create a server-controlled name whose extension reflects the verified file
 * signature, rather than a client-supplied filename.  This keeps URL suffixes,
 * stored MIME metadata, and the bytes in R2 consistent.
 */
export function safeUploadNameForDetectedType(
  detectedExt: string | null,
  allowedExts: string[],
  prefix: string
): string {
  if (!detectedExt) {
    throw new Error('لا يمكن تسمية ملف لم يتم التحقق من نوعه');
  }
  const canonicalExt = detectedExt === 'jpeg' ? 'jpg' : detectedExt;
  return safeUploadName(`upload.${canonicalExt}`, allowedExts, prefix);
}

export function mediaUrl(name: string): string {
  return `/media-files/${name}`;
}

export function detectFileType(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
    bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A
  ) {
    return 'png';
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return 'jpeg';
  }
  // GIF: 47 49 46 38
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'gif';
  }
  // WebP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'webp';
  }
  // PDF: %PDF (25 50 44 46)
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'pdf';
  }
  // MP4: ....ftyp (66 74 79 70 at offset 4)
  if (
    bytes.length >= 8 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  ) {
    return 'mp4';
  }
  // WebM: 1A 45 DF A3
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3
  ) {
    return 'webm';
  }
  return null;
}

export function validateFileSignature(
  data: ArrayBuffer | Uint8Array,
  allowedExts: string[]
): { valid: boolean; detectedExt: string | null } {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const detected = detectFileType(bytes);
  if (!detected) {
    // Fail-closed: Reject any file where magic bytes cannot be identified
    return { valid: false, detectedExt: null };
  }
  const normalizedAllowed = allowedExts.map((e) => e.toLowerCase());
  const isAllowed = normalizedAllowed.some((e) => {
    if (detected === 'jpeg' && (e === 'jpg' || e === 'jpeg')) return true;
    return e === detected;
  });

  return { valid: isAllowed, detectedExt: detected };
}

export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
export const PDF_EXTS = ['pdf'];
// Only formats recognized by detectFileType may be accepted for upload.
export const VIDEO_EXTS = ['mp4', 'webm'];
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
// Direct Worker uploads buffer the request before it can be stored.  Keep this
// deliberately below a large-video workflow; use signed/direct uploads plus a
// video pipeline when larger media is required.
export const MAX_DIRECT_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
