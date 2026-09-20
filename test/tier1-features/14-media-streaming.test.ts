import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { apiRequest } from '../harness/app';
import mainApp from '../../src/index';

describe('Tier 1: Feature 14 - Media Storage & Range Streaming', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = mainApp;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  async function seedAdminMedia(filename: string, data: Uint8Array | string, contentType: string) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await ctx.r2.put(filename, bytes, { httpMetadata: { contentType } });
    await ctx.db.prepare(`
      INSERT INTO media_files (id, filename, url, content_type, size_bytes, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      `mf_${filename.replace(/[^a-zA-Z0-9_]/g, '_')}`,
      filename,
      `/media-files/${filename}`,
      contentType,
      bytes.byteLength,
      ctx.fixtures.users.admin.id,
    ).run();
  }

  it('14.1 should return 200 OK with full file content for GET /media-files/:name without Range header', async () => {
    const dummyVideo = new Uint8Array(5000).fill(65); // 5KB
    await seedAdminMedia('sample_lecture.mp4', dummyVideo, 'video/mp4');

    const res = await apiRequest(app, 'GET', '/media-files/sample_lecture.mp4', {
      token: ctx.fixtures.users.admin.token,
    }, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('video/mp4');
    expect(res.headers.get('Content-Length')).toBe('5000');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
  });

  it('14.2 should return ETag header on media requests', async () => {
    await seedAdminMedia('doc.pdf', 'dummy pdf content', 'application/pdf');

    const res = await apiRequest(app, 'GET', '/media-files/doc.pdf', {
      token: ctx.fixtures.users.admin.token,
    }, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBeDefined();
  });

  it('14.3 should support HTTP Range request returning 206 Partial Content', async () => {
    const data = new Uint8Array(10000);
    for (let i = 0; i < 10000; i++) data[i] = i % 256;
    await seedAdminMedia('video_stream.mp4', data, 'video/mp4');

    const res = await apiRequest(app, 'GET', '/media-files/video_stream.mp4', {
      token: ctx.fixtures.users.admin.token,
      headers: { Range: 'bytes=0-999' },
    }, ctx);

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 0-999/10000');
    expect(res.headers.get('Content-Length')).toBe('1000');
  });

  it('14.4 should support middle Range request (e.g. bytes=2000-3999)', async () => {
    const data = new Uint8Array(10000);
    await seedAdminMedia('video_stream_mid.mp4', data, 'video/mp4');

    const res = await apiRequest(app, 'GET', '/media-files/video_stream_mid.mp4', {
      token: ctx.fixtures.users.admin.token,
      headers: { Range: 'bytes=2000-3999' },
    }, ctx);

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 2000-3999/10000');
    expect(res.headers.get('Content-Length')).toBe('2000');
  });

  it('14.5 should return correct Content-Type for PDF booklets', async () => {
    await seedAdminMedia('handout.pdf', 'PDF-1.4 test', 'application/pdf');

    const res = await apiRequest(app, 'GET', '/media-files/handout.pdf', {
      token: ctx.fixtures.users.admin.token,
    }, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });

  it('14.6 should allow admin to upload media file via POST /api/admin/media/upload', async () => {
    const content = new TextEncoder().encode('%PDF-1.7 Test file content');
    const res = await apiRequest(app, 'POST', '/api/admin/media/upload', {
      token: ctx.fixtures.users.admin.token,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': 'lecture_anatomy_notes.pdf',
      },
      body: content,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.filename).toMatch(/^admin_media_[a-f0-9]{12}\.pdf$/);
    expect(data.url).toBe(`/media-files/${data.filename}`);
  });

  it('14.7 should list uploaded media files via GET /api/admin/media', async () => {
    const content = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await apiRequest(app, 'POST', '/api/admin/media/upload', {
      token: ctx.fixtures.users.admin.token,
      headers: { 'X-Filename': 'media_item_1.png' },
      body: content,
    }, ctx);

    const res = await apiRequest(app, 'GET', '/api/admin/media', {
      token: ctx.fixtures.users.admin.token,
    }, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((m: any) => /^admin_media_[a-f0-9]{12}\.png$/.test(m.filename))).toBe(true);
  });

  it('14.8 should return 404 for non-existent media file', async () => {
    const res = await apiRequest(app, 'GET', '/media-files/non_existent_file_xyz.mp4', {}, ctx);
    expect(res.status).toBe(404);
  });
});
