// Global test setup for Vitest
import { beforeAll, afterAll } from 'vitest';

beforeAll(() => {
  // Ensure Node environment variables
  process.env.TZ = 'UTC';
});

afterAll(() => {
  // Cleanups if any
});
