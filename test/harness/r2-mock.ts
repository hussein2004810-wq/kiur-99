export interface R2HttpMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

export interface R2Object {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: R2HttpMetadata;
  customMetadata?: Record<string, string>;
  range?: { offset: number; length: number };
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
  blob(): Promise<Blob>;
}

export class MockR2Bucket {
  private store = new Map<string, { data: Uint8Array; meta: R2Object }>();

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | Blob | ReadableStream,
    options?: {
      httpMetadata?: R2HttpMetadata;
      customMetadata?: Record<string, string>;
    }
  ): Promise<R2Object> {
    let uint8: Uint8Array;
    if (typeof value === 'string') {
      uint8 = new TextEncoder().encode(value);
    } else if (value instanceof Uint8Array) {
      uint8 = value;
    } else if (value instanceof ArrayBuffer) {
      uint8 = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
      uint8 = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else if (value instanceof Blob) {
      const buf = await value.arrayBuffer();
      uint8 = new Uint8Array(buf);
    } else if (value instanceof ReadableStream) {
      const reader = value.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        if (chunk) chunks.push(chunk);
      }
      const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
      uint8 = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) {
        uint8.set(c, offset);
        offset += c.length;
      }
    } else {
      uint8 = new Uint8Array(0);
    }

    const etag = `"${Math.random().toString(36).substring(2)}"`;
    const meta: R2Object = {
      key,
      version: '1',
      size: uint8.byteLength,
      etag,
      httpEtag: etag,
      uploaded: new Date(),
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
    };

    this.store.set(key, { data: uint8, meta });
    return meta;
  }

  async get(
    key: string,
    options?: {
      range?: { offset?: number; length?: number; suffix?: number };
    }
  ): Promise<R2ObjectBody | null> {
    const item = this.store.get(key);
    if (!item) return null;

    let data = item.data;
    let rangeInfo: { offset: number; length: number } | undefined = undefined;

    if (options?.range) {
      const total = item.data.byteLength;
      let start = options.range.offset ?? 0;
      let len = options.range.length ?? (total - start);

      if (options.range.suffix !== undefined) {
        start = Math.max(0, total - options.range.suffix);
        len = options.range.suffix;
      }

      start = Math.max(0, Math.min(start, total));
      const end = Math.min(start + len, total);
      data = item.data.slice(start, end);
      rangeInfo = { offset: start, length: data.byteLength };
    }

    const uint8 = data;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(uint8);
        controller.close();
      },
    });

    return {
      ...item.meta,
      size: item.meta.size,
      range: rangeInfo,
      body: stream,
      bodyUsed: false,
      async arrayBuffer() {
        return uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
      },
      async text() {
        return new TextDecoder().decode(uint8);
      },
      async json<T>() {
        return JSON.parse(new TextDecoder().decode(uint8)) as T;
      },
      async blob() {
        return new Blob([uint8]);
      },
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const k of arr) {
      this.store.delete(k);
    }
  }

  async head(key: string): Promise<R2Object | null> {
    const item = this.store.get(key);
    return item ? item.meta : null;
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    objects: R2Object[];
    truncated: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? '';
    const limit = options?.limit ?? 1000;
    const matched: R2Object[] = [];

    for (const [key, item] of this.store.entries()) {
      if (key.startsWith(prefix)) {
        matched.push(item.meta);
        if (matched.length >= limit) break;
      }
    }

    return {
      objects: matched,
      truncated: false,
    };
  }
}
