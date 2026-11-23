'use strict';

// Probes the upstream with every client identity that matters and reports
// which one the provider accepts.
//
//   node tools/probe-upstream.cjs [--config <file>] [--model <id>] [--timeout <ms>] [--json]
//
// Why this exists
// ---------------
// The DeepSeek Harness identifies itself to every provider as
//
//   deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)
//
// because the Harness applies its attribution headers *after* the headers of
// the route: `@deepseek-ai/dsh-llm` exports `attributionHeaders()`, which
// returns exactly `{'user-agent': ...}`, and the pi-ai adapter writes them
// last with the comment "Harness attribution wins reserved names". The
// attribute says: "nothing can suppress attribution entirely".
//
// `DSH_USER_AGENT_SUFFIX` only *appends* a token to that identity, so it
// cannot replace it either.
//
// A provider that fingerprints its clients answers that identity with
// "401 unauthorized client detected". This script sends the same small
// request with each identity and prints what the provider answers, so the
// difference is a measured fact instead of a claim.
//
// The provider looks at two headers: the "User-Agent" and the "originator".
// A request is accepted when either of them names a client the provider
// knows. DeepCoder therefore sends the identity of the pi-ai client that
// lives inside the Harness, and names the same client in "originator".
//
// The key is read from the environment (or from the Windows user registry) and
// is never printed, logged or written anywhere.
//
// The requests are real and billed to you. They are small: one short prompt
// and the model's own output budget.

const { parseArgs } = require('node:util');

const { loadConfig, readUserEnvValue, piUserAgent, DEFAULTS } = require('../deepcoder.cjs');

// The identity the Harness sends. The version does not matter for the
// answer - only the shape of the product token does - so a fixed value is
// used to keep the output stable across harness releases.
const HARNESS_UA = 'deepseek-harness/0.0.0 (+https://github.com/deepseek-ai/deepseek-harness)';

// The identity pi-ai uses when nothing overrides it. It is computed from the
// running system, exactly like the bridge computes it.
const PI_UA = piUserAgent();

// The identity of the other client the provider accepts, kept as a control so
// the table shows that the choice is a preference, not a workaround.
const CODEX_UA = 'codex_cli_rs/0.104.0';

const PROMPT = 'Reply with the single word OK.';

/**
 * The identities the probe compares.
 *
 * @param {object} config the validated DeepCoder configuration
 * @returns {{label: string, userAgent: string, originator: string|null}[]}
 */
function buildCases(config) {
  const configured = String((config.headers || {})['user-agent'] || '').trim()
    || String((DEFAULTS.headers || {})['user-agent'] || '').trim();
  const configuredOriginator = String((config.headers || {}).originator || '').trim()
    || String((DEFAULTS.headers || {}).originator || '').trim();
  return [
    {
      label: 'the identity DeepCoder sends',
      userAgent: configured,
      originator: configuredOriginator || null,
    },
    { label: 'the harness attribution', userAgent: HARNESS_UA, originator: null },
    {
      label: 'the harness attribution + DSH_USER_AGENT_SUFFIX',
      userAgent: `${HARNESS_UA} ${configured}`,
      originator: null,
    },
    { label: 'the pi-ai default', userAgent: PI_UA, originator: null },
    { label: 'the Codex client identity', userAgent: CODEX_UA, originator: null },
  ];
}

/**
 * The request the probe sends, in the shape the configured protocol expects.
 *
 * @param {object} config the validated DeepCoder configuration
 * @param {string} model the model id to ask for
 * @returns {{path: string, body: object}}
 */
function buildRequest(config, model) {
  if (config.apiProtocol === 'openai-completions') {
    return {
      path: '/v1/chat/completions',
      body: { model, messages: [{ role: 'user', content: PROMPT }] },
    };
  }
  return {
    path: '/v1/responses',
    body: { model, input: PROMPT, store: false, stream: false },
  };
}

/**
 * Reads the provider key without ever putting it on a command line or on
 * screen.
 *
 * @param {object} config the validated DeepCoder configuration
 * @returns {string}
 */
function readKey(config) {
  const name = config.apiKeyEnv;
  const current = String(process.env[name] || '').trim();
  if (current) return current;
  const stored = readUserEnvValue(name);
  return String(stored || '').trim();
}

/**
 * Turns an upstream answer into one short line.
 *
 * @param {number} status the HTTP status
 * @param {string} body the answer body, possibly truncated
 * @returns {string}
 */
function summarize(status, body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  let detail = '';
  try {
    const parsed = JSON.parse(text);
    detail = String(parsed?.error?.message || parsed?.message || parsed?.status || '');
  } catch {
    detail = text;
  }
  if (!detail) return '';
  return detail.length > 120 ? `${detail.slice(0, 117)}...` : detail;
}

/**
 * Sends one probe request.
 *
 * @param {object} options the probe options
 * @returns {Promise<{label: string, userAgent: string, originator: string|null, status: number|null, ms: number, note: string}>}
 */
async function sendProbe({ url, headers, body, timeoutMs, label, userAgent, originator }) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${headers.key}`,
        'user-agent': userAgent,
        ...(originator ? { originator } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      label,
      userAgent,
      originator: originator || null,
      status: response.status,
      ms: Date.now() - started,
      note: summarize(response.status, text),
    };
  } catch (error) {
    return {
      label,
      userAgent,
      originator: originator || null,
      status: null,
      ms: Date.now() - started,
      note: error.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the probe.
 *
 * @param {object} options the probe options
 * @returns {Promise<{results: object[], verdict: string}>}
 */
async function runProbe(options) {
  const { config, model, timeoutMs } = options;
  const key = readKey(config);
  if (!key) {
    throw new Error(
      `No provider key found. Set ${config.apiKeyEnv} in your environment `
      + '(node deepcoder.cjs --set-key) and run this again.',
    );
  }
  const { path: requestPath, body } = buildRequest(config, model);
  const url = `${String(config.upstream).replace(/\/+$/, '')}${requestPath}`;
  const results = [];
  for (const testCase of buildCases(config)) {
    results.push(await sendProbe({
      url,
      headers: { key },
      body,
      timeoutMs,
      label: testCase.label,
      userAgent: testCase.userAgent,
      originator: testCase.originator,
    }));
  }
  const accepted = results.find((entry) => entry.status && entry.status >= 200 && entry.status < 300);
  const verdict = accepted
    ? `The provider accepts "${accepted.userAgent}".`
    : 'The provider rejected every identity in this list.';
  return { results, verdict };
}

/**
 * Prints the probe result.
 *
 * @param {object} probe the probe result
 * @param {boolean} asJson print the raw result instead of the table
 */
function printProbe(probe, asJson) {
  if (asJson) {
    console.log(JSON.stringify(probe, null, 2));
    return;
  }
  for (const entry of probe.results) {
    const status = entry.status === null ? 'ERR' : String(entry.status);
    console.log(`${status.padEnd(4)} ${String(entry.ms).padStart(6)} ms  ${entry.label}`);
    console.log(`     user-agent: ${entry.userAgent}`);
    if (entry.originator) console.log(`     originator: ${entry.originator}`);
    if (entry.note) console.log(`     ${entry.note}`);
  }
  console.log('');
  console.log(probe.verdict);
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      model: { type: 'string' },
      timeout: { type: 'string', default: '60000' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log('Usage: node tools/probe-upstream.cjs [--config <file>] [--model <id>] [--timeout <ms>] [--json]');
    console.log('');
    console.log('Sends one small request per client identity and reports which one the provider accepts.');
    return 0;
  }
  const config = loadConfig(values.config);
  const model = values.model || (config.models[0] && config.models[0].id);
  if (!model) throw new Error('The configuration declares no model. Add one, or pass --model.');
  const timeoutMs = Number(values.timeout) > 0 ? Number(values.timeout) : 60000;
  const probe = await runProbe({ config, model, timeoutMs });
  printProbe(probe, values.json);
  const accepted = probe.results.some((entry) => entry.status && entry.status >= 200 && entry.status < 300);
  return accepted ? 0 : 1;
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`probe failed: ${error.message}`);
      process.exitCode = 2;
    });
}

module.exports = {
  buildCases,
  buildRequest,
  readKey,
  summarize,
  runProbe,
  HARNESS_UA,
  PI_UA,
  CODEX_UA,
};
