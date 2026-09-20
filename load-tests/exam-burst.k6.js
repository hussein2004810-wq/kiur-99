import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import exec from 'k6/execution';

// This test is deliberately inert until all three environment variables are
// supplied.  Use only an isolated staging database: it creates real attempts.
const baseUrl = (__ENV.KIUR_BASE_URL || '').replace(/\/$/, '');
const examId = __ENV.KIUR_EXAM_ID || '';
const tokens = JSON.parse(__ENV.KIUR_AUTH_TOKENS_JSON || '[]');
const targetStudents = Number(__ENV.KIUR_TARGET_STUDENTS || 600);

if (!baseUrl || !examId || !Array.isArray(tokens) || tokens.length < targetStudents) {
  fail('Set KIUR_BASE_URL, KIUR_EXAM_ID, and KIUR_AUTH_TOKENS_JSON with one entitled staging token per simulated student.');
}

const startDuration = new Trend('exam_start_duration', true);
const answerDuration = new Trend('exam_answer_duration', true);

export const options = {
  scenarios: {
    exam_burst: {
      executor: 'constant-arrival-rate',
      rate: targetStudents / 30,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: targetStudents,
      maxVUs: targetStudents,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    exam_start_duration: ['p(95)<1000'],
    exam_answer_duration: ['p(95)<500'],
  },
};

function headers(token, idempotencyKey) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
  };
}

function postWithOneRetry(url, body, token, key) {
  let response = http.post(url, body, headers(token, key));
  // A network failure after server acceptance must retry with the *same* key.
  if (response.status === 0 || response.status >= 500) {
    response = http.post(url, body, headers(token, key));
  }
  return response;
}

export default function () {
  const iteration = exec.scenario.iterationInTest;
  const token = tokens[iteration % tokens.length];
  const requestPrefix = `k6-${iteration}-${Date.now()}`;

  const start = postWithOneRetry(
    `${baseUrl}/api/exams/${examId}/start`,
    null,
    token,
    `${requestPrefix}-start`,
  );
  startDuration.add(start.timings.duration);
  if (!check(start, { 'start succeeds': (response) => response.status === 200 })) return;

  const attempt = start.json();
  const question = attempt.questions?.[0];
  const choice = question?.choices?.[0];
  if (!attempt.attempt_id || !question?.id || !choice?.id) {
    fail('The staging exam must expose at least one question with a choice.');
  }

  // Model the documented ten-second answer interval, then submit and finish.
  sleep(10);
  const answer = postWithOneRetry(
    `${baseUrl}/api/exams/attempts/${attempt.attempt_id}/answer`,
    JSON.stringify({ question_id: question.id, choice_id: choice.id }),
    token,
    `${requestPrefix}-answer`,
  );
  answerDuration.add(answer.timings.duration);
  check(answer, { 'answer succeeds': (response) => response.status === 200 });

  const finish = postWithOneRetry(
    `${baseUrl}/api/exams/attempts/${attempt.attempt_id}/finish`,
    null,
    token,
    `${requestPrefix}-finish`,
  );
  check(finish, { 'finish succeeds': (response) => response.status === 200 });
}
