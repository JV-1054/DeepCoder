'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCases,
  buildRequest,
  summarize,
  HARNESS_UA,
  PI_UA,
  CODEX_UA,
} = require('../tools/probe-upstream.cjs');
const { piUserAgent, DEFAULTS } = require('../deepcoder.cjs');

const CONFIG = {
  upstream: 'https://agentrouter.org',
  apiProtocol: 'openai-responses',
  apiKeyEnv: 'AGENTROUTER_API_KEY',
  headers: { 'user-agent': 'pi (linux 6.8.0; x64)', originator: 'pi' },
};

test('buildCases compares the identity the bridge sends with the harness identity', () => {
  const cases = buildCases(CONFIG);
  assert.equal(cases.length, 5);
  assert.equal(cases[0].userAgent, 'pi (linux 6.8.0; x64)');
  assert.equal(cases[0].originator, 'pi');
  assert.equal(cases[1].userAgent, HARNESS_UA);
  assert.match(cases[1].userAgent, /^deepseek-harness\//);
  assert.equal(cases[1].originator, null);
  assert.match(cases[2].userAgent, /DSH_USER_AGENT_SUFFIX|pi \(/);
  assert.equal(cases[3].userAgent, PI_UA);
  assert.equal(cases[4].userAgent, CODEX_UA);
});

test('buildCases falls back to the default identity when the config has no user agent', () => {
  const cases = buildCases({ headers: {} });
  assert.equal(cases[0].userAgent, DEFAULTS.headers['user-agent']);
  assert.equal(cases[0].originator, 'pi');
});

test('the default identity is the pi client computed for this machine', () => {
  assert.equal(DEFAULTS.headers['user-agent'], piUserAgent());
  assert.match(piUserAgent(), /^pi \([^)]+; [^)]+\)$/);
});

test('buildRequest uses the responses endpoint for the responses protocol', () => {
  const request = buildRequest(CONFIG, 'gpt-6.1-sol');
  assert.equal(request.path, '/v1/responses');
  assert.equal(request.body.model, 'gpt-6.1-sol');
  assert.equal(request.body.stream, false);
  assert.equal(request.body.store, false);
  assert.equal(typeof request.body.input, 'string');
});

test('buildRequest uses the chat completions endpoint for the chat protocol', () => {
  const request = buildRequest({ ...CONFIG, apiProtocol: 'openai-completions' }, 'gpt-6.1-sol');
  assert.equal(request.path, '/v1/chat/completions');
  assert.equal(request.body.model, 'gpt-6.1-sol');
  assert.equal(request.body.messages.length, 1);
  assert.equal(request.body.messages[0].role, 'user');
});

test('summarize pulls the provider error message out of the answer', () => {
  const body = JSON.stringify({ error: { message: 'unauthorized client detected' } });
  assert.equal(summarize(401, body), 'unauthorized client detected');
});

test('summarize survives a body that is not json', () => {
  assert.equal(summarize(500, 'upstream exploded'), 'upstream exploded');
});

test('summarize returns nothing for an empty body', () => {
  assert.equal(summarize(204, ''), '');
});

test('summarize cuts a long message down', () => {
  const body = JSON.stringify({ error: { message: 'x'.repeat(500) } });
  const note = summarize(400, body);
  assert.equal(note.length, 120);
  assert.match(note, /\.\.\.$/);
});
