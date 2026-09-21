import http from 'k6/http';
import { check, fail } from 'k6';
import { Trend } from 'k6/metrics';
import exec from 'k6/execution';

// Input records are { token, attempt_id } for unfinished staging attempts.
const baseUrl = (__ENV.KIUR_BASE_URL || '').replace(/\/$/, '');
const burstSeconds = Number(__ENV.KIUR_BURST_SECONDS || 120);
let attempts = [];
try { attempts = JSON.parse(__ENV.KIUR_ATTEMPTS_JSON || '[]'); } catch { fail('KIUR_ATTEMPTS_JSON must be valid JSON.'); }

if (__ENV.KIUR_CONFIRM_STAGING !== 'YES' || !baseUrl || !Number.isInteger(burstSeconds) || burstSeconds < 1 || !Array.isArray(attempts) || attempts.length < 1 || attempts.some((attempt) => !attempt?.token || !attempt?.attempt_id)) {
  fail('Set KIUR_CONFIRM_STAGING=YES, KIUR_BASE_URL, KIUR_BURST_SECONDS, and KIUR_ATTEMPTS_JSON with unfinished staging attempts.');
}

const finishDuration = new Trend('exam_finish_duration', true);

export const options = {
  scenarios: {
    finish_burst: {
      executor: 'constant-arrival-rate',
      rate: Math.ceil(attempts.length / burstSeconds),
      timeUnit: '1s',
      duration: `${burstSeconds}s`,
      preAllocatedVUs: Math.min(attempts.length, 100),
      maxVUs: Math.min(attempts.length, 300),
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    exam_finish_duration: ['p(95)<2000'],
  },
};

export default function () {
  const attempt = attempts[exec.scenario.iterationInTest % attempts.length];
  const response = http.post(`${baseUrl}/api/exams/attempts/${attempt.attempt_id}/finish`, null, {
    headers: {
      Authorization: `Bearer ${attempt.token}`,
      'Idempotency-Key': `finish-${exec.scenario.iterationInTest}-${Date.now()}`,
    },
  });
  finishDuration.add(response.timings.duration);
  check(response, { 'finish succeeds': (res) => res.status === 200 });
}
