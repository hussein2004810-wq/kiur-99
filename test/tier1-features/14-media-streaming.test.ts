import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, TestContext } from '../harness/test-context';
import { createTestApp, apiRequest } from '../harness/app';

describe('Tier 1: Feature 14 - Media Storage & Range Streaming', () => {
  let ctx: TestContext;
  let app: any;

  beforeEach(async () => {
    ctx = await createTestContext();
    app = await createTestApp(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('14.1 should return 200 OK with full file content for GET /media-files/:name without Range header', async () => {
    const dummyVideo = new Uint8Array(5000).fill(65); // 5KB
    await ctx.r2.put('sample_lecture.mp4', dummyVideo, {
      httpMetadata: { contentType: 'video/mp4' },
    });

    const res = await apiRequest(app, 'GET', '/media-files/sample_lecture.mp4', {}, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('video/mp4');
    expect(res.headers.get('Content-Length')).toBe('5000');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
  });

  it('14.2 should return ETag header on media requests', async () => {
    await ctx.r2.put('doc.pdf', 'dummy pdf content', {
      httpMetadata: { contentType: 'application/pdf' },
    });

    const res = await apiRequest(app, 'GET', '/media-files/doc.pdf', {}, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBeDefined();
  });

  it('14.3 should support HTTP Range request returning 206 Partial Content', async () => {
    const data = new Uint8Array(10000);
    for (let i = 0; i < 10000; i++) data[i] = i % 256;
    await ctx.r2.put('video_stream.mp4', data, {
      httpMetadata: { contentType: 'video/mp4' },
    });

    const res = await apiRequest(app, 'GET', '/media-files/video_stream.mp4', {
      headers: { Range: 'bytes=0-999' },
    }, ctx);

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 0-999/10000');
    expect(res.headers.get('Content-Length')).toBe('1000');
  });

  it('14.4 should support middle Range request (e.g. bytes=2000-3999)', async () => {
    const data = new Uint8Array(10000);
    await ctx.r2.put('video_stream_mid.mp4', data, {
      httpMetadata: { contentType: 'video/mp4' },
    });

    const res = await apiRequest(app, 'GET', '/media-files/video_stream_mid.mp4', {
      headers: { Range: 'bytes=2000-3999' },
    }, ctx);

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 2000-3999/10000');
    expect(res.headers.get('Content-Length')).toBe('2000');
  });

  it('14.5 should return correct Content-Type for PDF booklets', async () => {
    await ctx.r2.put('handout.pdf', 'PDF-1.4 test', {
      httpMetadata: { contentType: 'application/pdf' },
    });

    const res = await apiRequest(app, 'GET', '/media-files/handout.pdf', {}, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });

  it('14.6 should allow admin to upload media file via POST /api/admin/media/upload', async () => {
    const content = new TextEncoder().encode('Test file content');
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
    expect(data.filename).toBe('lecture_anatomy_notes.pdf');
    expect(data.url).toBe('/media-files/lecture_anatomy_notes.pdf');
  });

  it('14.7 should list uploaded media files via GET /api/admin/media', async () => {
    const content = new TextEncoder().encode('Dummy content');
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
    expect(data.some((m: any) => m.filename === 'media_item_1.png')).toBe(true);
  });

  it('14.8 should return 404 for non-existent media file', async () => {
    const res = await apiRequest(app, 'GET', '/media-files/non_existent_file_xyz.mp4', {}, ctx);
    expect(res.status).toBe(404);
  });
});
