const { resolveAllowedOrigin } = require('../../src/middleware/cors');
const { formatZodError, errorHandler, notFoundHandler } = require('../../src/middleware/error');
const { z } = require('zod');

console.log('=== ADVERSARIAL STRESS TEST ===');

// 1. CORS Origin Bypass Tests
console.log('\n--- 1. Testing CORS Origin Injection & Subdomain Spoofing ---');
const testCases = [
  { origin: 'http://localhost:3000', debug: 'true', expected: 'http://localhost:3000' },
  { origin: 'http://127.0.0.1:8080', debug: 'true', expected: 'http://127.0.0.1:8080' },
  { origin: 'http://localhost.attacker.com', debug: 'true', expected: null },
  { origin: 'http://127.0.0.1.attacker.com', debug: 'true', expected: null },
  { origin: 'http://evil-localhost:3000', debug: 'true', expected: null },
  { origin: 'https://localhost:443', debug: 'true', expected: 'https://localhost:443' },
  { origin: 'javascript:alert(1)', debug: 'true', expected: null },
  { origin: 'null', debug: 'true', expected: null },
  { origin: 'http://localhost:5500', debug: 'false', expected: 'http://localhost:5500' }, // in default list
  { origin: 'http://localhost:9999', debug: 'false', expected: null }, // not in default list
  { origin: 'https://malicious.com', debug: 'false', expected: null },
];

let corsPassed = true;
for (const tc of testCases) {
  const res = resolveAllowedOrigin(tc.origin, { DEBUG: tc.debug });
  const ok = res === tc.expected;
  if (!ok) {
    corsPassed = false;
    console.error(`FAIL: origin="${tc.origin}", debug=${tc.debug}. Expected: ${tc.expected}, Got: ${res}`);
  } else {
    console.log(`PASS: origin="${tc.origin}" (debug=${tc.debug}) => ${res}`);
  }
}

// 2. Error Handler Constraint Spoofing & Edge Cases
console.log('\n--- 2. Testing Error Handling Sanitization ---');
const zodSchema = z.object({
  nested: z.object({
    field: z.string({ required_error: 'Required' }),
  }),
  num: z.number({ invalid_type_error: 'Expected string, received' }),
});

const parseResult = zodSchema.safeParse({ nested: {}, num: 'abc' });
if (!parseResult.success) {
  const formatted = formatZodError(parseResult.error);
  console.log('Formatted Zod error output:', formatted);
  if (formatted.includes('[object Object]') || !formatted.includes('nested.field')) {
    console.error('FAIL: formatZodError failed formatting nested field!');
  } else {
    console.log('PASS: formatZodError cleanly flattens nested schema validation errors.');
  }
}

console.log('\nCORS Test Summary:', corsPassed ? 'ALL PASSED' : 'SOME FAILED');
