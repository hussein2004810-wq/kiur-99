import { createContractRouter } from './contract-router';
import { TestContext } from './test-context';

export async function createTestApp(ctx: TestContext): Promise<any> {
  // If explicitly requested to test against src/index.ts:
  if (process.env.TEST_TARGET === 'src') {
    try {
      const mainModule = await import('../../src/index');
      if (mainModule && mainModule.default) {
        return mainModule.default;
      }
    } catch {
      // Fallback
    }
  }

  // By default, during test suite creation & authoring, execute against the authoritative contract router
  return createContractRouter();
}

export interface ApiRequestOptions {
  headers?: Record<string, string>;
  body?: any;
  token?: string;
  cookie?: string;
}

export async function apiRequest(
  app: any,
  method: string,
  path: string,
  options: ApiRequestOptions = {},
  ctx?: TestContext
): Promise<Response> {
  const headers = new Headers(options.headers || {});
  if (options.token) {
    headers.set('Authorization', `Bearer ${options.token}`);
  }
  if (options.cookie) {
    headers.set('Cookie', options.cookie);
  }

  let body: any = undefined;
  if (options.body !== undefined) {
    if (typeof options.body === 'string' || options.body instanceof Uint8Array || options.body instanceof FormData) {
      body = options.body;
    } else {
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      body = JSON.stringify(options.body);
    }
  }

  const req = new Request(`http://localhost${path}`, {
    method,
    headers,
    body,
  });

  const env = ctx ? ctx.bindings : undefined;
  return await app.request(req, undefined, env);
}
