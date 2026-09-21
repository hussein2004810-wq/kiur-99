import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import exec from 'k6/execution';

// Creates real attempts and answers. It is deliberately blocked without an
// explicit staging confirmation and one entitled token per virtual student.
const baseUrl = (__ENV.KIUR_BASE_URL || '').replace(/\/$/, '');
const examId = __ENV.KIUR_EXAM_ID || '';
const targetStudents = Number(__ENV.KIUR_TARGET_STUDENTS || 600);
const windowMinutes = Number(__ENV.KIUR_WINDOW_MINUTES || 30);
const answerDelaySeconds = Number(__ENV.KIUR_ANSWER_DELAY_SECONDS || 45);
let tokens = [];
try { tokens = JSON.parse(__ENV.KIUR_AUTH_TOKENS_JSON || '[]'); } catch { fail('KIUR_AUTH_TOKENS_JSON must be valid JSON.'); }

if (__ENV.KIUR_CONFIRM_STAGING !== 'YES' || !baseUrl || !examId || !Number.isInteger(targetStudents) || targetStudents < 1 || !Number.isInteger(windowMinutes) || windowMinutes < 1 || !Number.isFinite(answerDelaySeconds) || answerDelaySeconds < 1 || !Array.isArray(tokens) || tokens.length < targetStudents) {
  fail('Set KIUR_CONFIRM_STAGING=YES, KIUR_BASE_URL, KIUR_EXAM_ID, KIUR_TARGET_STUDENTS, KIUR_WINDOW_MINUTES, KIUR_ANSWER_DELAY_SECONDS, and one entitled staging token per student.');
}

const startDuration = new Trend('exam_start_duration', true);
const answerDuration = new Trend('exam_answer_duration', true);
const finishDuration = new Trend('exam_finish_duration', true);

export const options = {
  scenarios: {
    class_session: {
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
    exam_start_duration: ['p(95)<2000'],
    exam_answer_duration: ['p(95)<750'],
    exam_finish_duration: ['p(95)<2000'],
  },
};

function postWithOneRetry(url, body, token, idempotencyKey) {
  const params = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey } };
  let response = http.post(url, body, params);
  if (response.status === 0 || response.status >= 500) response = http.post(url, body, params);
  return response;
}

export default function () {
  const iteration = exec.scenario.iterationInTest;
  const token = tokens[iteration % tokens.length];
  const keyPrefix = `class-${iteration}-${Date.now()}`;
  const start = postWithOneRetry(`${baseUrl}/api/exams/${examId}/start`, null, token, `${keyPrefix}-start`);
  startDuration.add(start.timings.duration);
  if (!check(start, { 'start succeeds': (res) => res.status === 200 })) return;

  const attempt = start.json();
  const question = attempt.questions?.[0];
  const choice = question?.choices?.[0];
  if (!attempt.attempt_id || !question?.id || !choice?.id) fail('The staging exam must contain at least one question and choice.');

  sleep(answerDelaySeconds);
  const answer = postWithOneRetry(`${baseUrl}/api/exams/attempts/${attempt.attempt_id}/answer`, JSON.stringify({ question_id: question.id, choice_id: choice.id }), token, `${keyPrefix}-answer`);
  answerDuration.add(answer.timings.duration);
  check(answer, { 'answer succeeds': (res) => res.status === 200 });

  const finish = postWithOneRetry(`${baseUrl}/api/exams/attempts/${attempt.attempt_id}/finish`, null, token, `${keyPrefix}-finish`);
  finishDuration.add(finish.timings.duration);
  check(finish, { 'finish succeeds': (res) => res.status === 200 });
}
