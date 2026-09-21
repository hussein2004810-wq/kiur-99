import http from 'k6/http';
import { check, fail } from 'k6';
import { Trend } from 'k6/metrics';
import exec from 'k6/execution';

// Password logins mutate sessions. This test must never run against production.
const baseUrl = (__ENV.KIUR_BASE_URL || '').replace(/\/$/, '');
const targetStudents = Number(__ENV.KIUR_TARGET_STUDENTS || 600);
const windowMinutes = Number(__ENV.KIUR_WINDOW_MINUTES || 30);
let credentials = [];
try { credentials = JSON.parse(__ENV.KIUR_CREDENTIALS_JSON || '[]'); } catch { fail('KIUR_CREDENTIALS_JSON must be valid JSON.'); }

if (__ENV.KIUR_CONFIRM_STAGING !== 'YES' || !baseUrl || !Number.isInteger(targetStudents) || targetStudents < 1 || !Number.isInteger(windowMinutes) || windowMinutes < 1 || !Array.isArray(credentials) || credentials.length < targetStudents) {
  fail('Set KIUR_CONFIRM_STAGING=YES, KIUR_BASE_URL, KIUR_TARGET_STUDENTS, KIUR_WINDOW_MINUTES, and one staging email/password pair per simulated student.');
}

const loginDuration = new Trend('login_duration', true);

export const options = {
  scenarios: {
    login_ramp: {
      executor: 'constant-arrival-rate',
      rate: Math.ceil(targetStudents / windowMinutes),
      timeUnit: '1m',
      duration: `${windowMinutes}m`,
      preAllocatedVUs: Math.max(10, Math.ceil(targetStudents / windowMinutes)),
      maxVUs: Math.min(targetStudents, 100),
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    login_duration: ['p(95)<1500'],
  },
};

export default function () {
  const credential = credentials[exec.scenario.iterationInTest % credentials.length];
  if (!credential?.email || !credential?.password) fail('Every staging credential needs email and password.');
  const response = http.post(`${baseUrl}/auth/login`, JSON.stringify(credential), {
    headers: { 'Content-Type': 'application/json' },
  });
  loginDuration.add(response.timings.duration);
  check(response, { 'login succeeds': (res) => res.status === 200 });
}
