'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkNodeVersion,
  inspectProfilePatch,
  inspectDefaultModel,
  summarizeDoctor,
  doctorReport,
} = require('../deepcoder.cjs');

const PATCH = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      otari:
        displayName: otari
        apiKeyEnv: OTARI_API_KEY
      deepcoder:
        displayName: DeepCoder
        apiKeyEnv: AGENTROUTER_API_KEY
        api: openai-responses
        baseURL: http://127.0.0.1:8899/v1
        timeoutMs: 600000
        streamIdleTimeoutMs: 600000
        models:
          - id: "gpt-6.1-sol"
            name: "gpt-6.1-sol"
            contextWindow: 262144
            maxTokens: 16384
            input:
              - text
              - image
            reasoningEfforts:
              off:
              high: high
        compat:
          supportsDeveloperRole: true
          supportsMaxOutputTokens: true
          supportsStrictMode: false

- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepcoder
    model: "gpt-6.1-sol"
    reasoningEffort: high
`;

test('checkNodeVersion accepts the version the bridge runs on', () => {
  const result = checkNodeVersion('v22.23.5');
  assert.equal(result.ok, true);
  assert.match(result.detail, /22\.23\.5/);
});

test('checkNodeVersion refuses a version that is too old', () => {
  const result = checkNodeVersion('v20.11.0');
  assert.equal(result.ok, false);
  assert.match(result.detail, /22/);
});

test('checkNodeVersion refuses a version it cannot read', () => {
  assert.equal(checkNodeVersion('nonsense').ok, false);
  assert.equal(checkNodeVersion('').ok, false);
});

test('inspectProfilePatch reports a profile without a DeepCoder route', () => {
  const route = inspectProfilePatch('- id: llm-pi-ai\n  name: "other"\n', { port: 8899 });
  assert.equal(route.present, false);
  assert.deepEqual(route.models, []);
});

test('inspectProfilePatch reads the route out of a profile patch', () => {
  const route = inspectProfilePatch(PATCH, { port: 8899 });
  assert.equal(route.present, true);
  assert.equal(route.baseUrl, 'http://127.0.0.1:8899/v1');
  assert.equal(route.api, 'openai-responses');
  assert.equal(route.apiKeyEnv, 'AGENTROUTER_API_KEY');
  assert.deepEqual(route.models, ['gpt-6.1-sol']);
  assert.equal(route.matchesPort, true);
});

test('inspectProfilePatch notices a route that points at another port', () => {
  const route = inspectProfilePatch(PATCH, { port: 9123 });
  assert.equal(route.present, true);
  assert.equal(route.matchesPort, false);
  assert.equal(route.expectedBaseUrl, 'http://127.0.0.1:9123/v1');
});

test('inspectDefaultModel reads the default model entry', () => {
  const model = inspectDefaultModel(PATCH);
  assert.equal(model.present, true);
  assert.equal(model.pointsAtDeepCoder, true);
});

test('inspectDefaultModel notices a profile without a default model entry', () => {
  const model = inspectDefaultModel('- id: llm-pi-ai\n  name: "other"\n');
  assert.equal(model.present, false);
  assert.equal(model.pointsAtDeepCoder, false);
});

test('inspectDefaultModel notices a default model that points somewhere else', () => {
  const model = inspectDefaultModel('- id: agent-default-model\n  config:\n    provider: otari\n');
  assert.equal(model.present, true);
  assert.equal(model.pointsAtDeepCoder, false);
});

test('summarizeDoctor counts the checks and fails on a failure', () => {
  const summary = summarizeDoctor([
    { status: 'PASS' },
    { status: 'WARN' },
    { status: 'FAIL' },
    { status: 'SKIP' },
    { status: 'pass' },
  ]);
  assert.deepEqual(summary.counts, { pass: 2, warn: 1, fail: 1, skip: 1 });
  assert.equal(summary.ok, false);
});

test('summarizeDoctor passes when nothing failed', () => {
  const summary = summarizeDoctor([{ status: 'PASS' }, { status: 'WARN' }, { status: 'SKIP' }]);
  assert.equal(summary.ok, true);
});

test('doctorReport names the checks that need attention', () => {
  const checks = [
    { name: 'Node', status: 'PASS', detail: 'Node 26.13.0' },
    { name: 'Harness route', status: 'FAIL', detail: 'the route is missing' },
  ];
  const report = doctorReport(checks, summarizeDoctor(checks));
  assert.match(report, /\[PASS\] Node: Node 26\.13\.0/);
  assert.match(report, /\[FAIL\] Harness route: the route is missing/);
  assert.match(report, /Needs attention: Harness route\./);
});

test('doctorReport says that everything is in place when nothing failed', () => {
  const checks = [{ name: 'Node', status: 'PASS', detail: 'Node 26.13.0' }];
  const report = doctorReport(checks, summarizeDoctor(checks));
  assert.match(report, /Everything that has to be in place is in place\./);
});
