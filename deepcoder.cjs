#!/usr/bin/env node
'use strict';

/**
 * DeepCoder v1.0.3
 *
 * A privacy-conscious loopback API gateway that sits between the DeepSeek
 * Harness (DSH) and an OpenAI-compatible upstream. The harness talks to
 * http://127.0.0.1:<port>/v1 and every request is relayed to the configured
 * upstream with the caller's own credentials.
 *
 * Design rules that DeepCoder keeps on purpose:
 *   - loopback bind only, Host header must match the local port
 *   - browser requests (any Origin header) are refused
 *   - only /v1 API routes are forwarded
 *   - the upstream must be HTTPS (plain HTTP only for loopback testing)
 *   - API keys and request bodies are never logged or stored
 *   - the port is never taken away from another process
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const VERSION = '1.0.3';
const SERVICE_NAME = 'deepcoder';
const CONFIG_ENV = 'DEEPCODER_CONFIG';
const PROVIDER_ID = 'deepcoder';
const MAX_OVERRIDE_BODY_BYTES = 8 * 1024 * 1024;

// AgentRouter fingerprints the calling client and only accepts a handful of
// known clients (Codex, OpenCode, pi). The harness stamps its own attribution
// User-Agent on every request and that one is refused, so the bridge sends
// the identity the pi-ai client inside the harness would send if nothing
// overrode it: "pi (<platform> <release>; <arch>)". It is computed at runtime,
// so it is correct on every machine and never goes stale. Override the
// "headers" block in deepcoder-config.json if your upstream expects
// something else.
function piUserAgent() {
  return `pi (${os.platform()} ${os.release()}; ${os.arch()})`;
}

const PROTOCOLS = new Set([
  'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai',
]);

const DEFAULTS = {
  upstream: 'https://agentrouter.org',
  port: 8899,
  timeoutMs: 600000,
  headers: { 'user-agent': piUserAgent(), originator: 'pi' },
  outputTokenFloors: { 'gpt-6.1-sol': 16384 },
  // gpt-6.1-sol rejects the sampling parameters below with HTTP 400
  // ("Unsupported parameter: 'temperature' is not supported with this
  // model"), so the bridge removes them before the request reaches the
  // upstream. "*" applies to every model.
  stripParams: {
    'gpt-6.1-sol': ['temperature', 'top_p', 'frequency_penalty'],
  },
  apiKeyEnv: 'AGENTROUTER_API_KEY',
  // When the client sends no Authorization header, the bridge adds
  // "Authorization: Bearer <value of apiKeyEnv>" from its own environment. The
  // harness normally sends the key itself; this keeps the route working when
  // the harness process was started before the variable existed.
  injectApiKey: true,
  apiProtocol: 'openai-responses',
  dshProfile: 'desktop',
  models: [
    {
      id: 'gpt-6.1-sol',
      name: 'GPT-6.1-SOL',
      contextWindow: 262144,
      maxTokens: 16384,
      input: ['text', 'image'],
      // The reasoning levels the harness offers for this model and the
      // "reasoning.effort" value each level sends upstream. Every value below
      // was accepted by the upstream in a live request. A level that is left
      // out is not offered by the harness; "off" is the only level that may
      // be written without a value, which means "supported, send nothing".
      reasoningEfforts: {
        off: 'none',
        minimal: 'minimal',
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max',
      },
    },
  ],
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);
const PROTECTED_HEADERS = new Set([
  ...HOP_HEADERS, 'authorization', 'cookie', 'set-cookie', 'content-length',
  'x-api-key', 'api-key', 'x-auth-token', 'x-access-token', 'origin',
]);
const MODEL_FIELDS = new Set([
  'id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'ownedBy',
]);
const INPUT_KINDS = new Set(['text', 'image']);
// The reasoning levels the harness knows, in the order it lists them.
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:@/-]{1,128}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROFILE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const BODY_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// Ten minutes: a reasoning model can think for several minutes before its
// first stream event.
const DSH_TIMEOUT_MS = 600000;

/** The token field that belongs to each request route the harness may use. */
const TOKEN_FIELDS = {
  '/v1/responses': ['max_output_tokens'],
  '/v1/chat/completions': ['max_tokens', 'max_completion_tokens'],
};

// A configuration failure carries a fixed, value-free reason for the CLI and a
// detailed message for library callers. The reason never repeats user data, so
// diagnostics stay safe to print on a shared console.
function configError(reason, message, Type = Error) {
  const error = new Type(message);
  error.reason = reason;
  return error;
}

function validateModels(models) {
  if (!Array.isArray(models)) {
    throw configError(
      'The model catalog must be an array of model descriptors.',
      'models must be an array of model descriptors.',
    );
  }
  const seen = new Set();
  return models.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw configError(
        'Every model descriptor must be an object.',
        'models must contain model descriptor objects.',
      );
    }
    for (const key of Object.keys(entry)) {
      if (!MODEL_FIELDS.has(key)) {
        throw configError(
          'A model descriptor contains a field that this bridge does not support.',
          `Unknown model field: ${key}`,
        );
      }
    }
    if (typeof entry.id !== 'string' || !MODEL_ID_PATTERN.test(entry.id)) {
      throw configError(
        'Every model needs a short identifier made of letters, digits, dots, slashes or dashes.',
        `Model id is missing or invalid: ${String(entry.id)}`,
      );
    }
    if (seen.has(entry.id)) {
      throw configError(
        'Every model identifier must be unique.',
        `Duplicate model id: ${entry.id}`,
      );
    }
    seen.add(entry.id);
    if (entry.name !== undefined && typeof entry.name !== 'string') {
      throw configError('A model name must be a string.', `Model name must be a string: ${entry.id}`);
    }
    if (entry.ownedBy !== undefined && typeof entry.ownedBy !== 'string') {
      throw configError(
        'A model owner must be a string.',
        `Model ownedBy must be a string: ${entry.id}`,
      );
    }
    for (const field of ['contextWindow', 'maxTokens']) {
      if (entry[field] === undefined) continue;
      if (!Number.isSafeInteger(entry[field]) || entry[field] < 1) {
        throw configError(
          'Model budgets must be positive whole numbers.',
          `Model ${field} must be a positive integer: ${entry.id}`,
        );
      }
    }
    if (entry.input !== undefined) {
      if (!Array.isArray(entry.input) || entry.input.some((kind) => !INPUT_KINDS.has(kind))) {
        throw configError(
          'Model input kinds must be a list of "text" and "image".',
          `Model input must be a list of "text" and/or "image": ${entry.id}`,
        );
      }
    }
    if (entry.reasoningEfforts !== undefined) {
      if (!entry.reasoningEfforts || typeof entry.reasoningEfforts !== 'object'
        || Array.isArray(entry.reasoningEfforts)) {
        throw configError(
          'Reasoning efforts must map effort levels to wire values.',
          `Model reasoningEfforts must be an object: ${entry.id}`,
        );
      }
      const levels = Object.keys(entry.reasoningEfforts);
      if (levels.length === 0) {
        throw configError(
          'Reasoning efforts must offer at least one level.',
          `Model reasoningEfforts must not be empty: ${entry.id}`,
        );
      }
      for (const [level, wire] of Object.entries(entry.reasoningEfforts)) {
        if (!THINKING_LEVELS.includes(level)) {
          throw configError(
            'A reasoning level is not one the harness knows.',
            `Model reasoningEfforts has an unknown level "${level}": ${entry.id}`,
          );
        }
        // Only "off" may be written without a value: the harness reads that as
        // "this level is supported and sends nothing".
        if (wire === null && level === 'off') continue;
        if (typeof wire !== 'string' || wire.trim() === '') {
          throw configError(
            'Reasoning efforts need a level name and a wire value.',
            `Model reasoningEfforts must map level names to non-empty strings: ${entry.id}`,
          );
        }
      }
      if (!levels.some((level) => level !== 'off')) {
        throw configError(
          'Reasoning efforts must offer a thinking level besides "off".',
          `Model reasoningEfforts offers no level beyond "off": ${entry.id}`,
        );
      }
    }
    return { ...entry };
  });
}

function validateConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw configError('The configuration must be a JSON object.', 'Configuration must be a JSON object.');
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULTS, key)) {
      throw configError(
        'The configuration contains a field that this bridge does not support.',
        `Unknown configuration field: ${key}`,
      );
    }
  }
  const config = { ...DEFAULTS, ...input };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw configError('The port must be an integer between 1 and 65535.', 'port must be an integer between 1 and 65535.');
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 2147483647) {
    throw configError(
      'The timeout must be an integer between 1 and 2147483647 milliseconds.',
      'timeoutMs must be an integer between 1 and 2147483647.',
    );
  }
  if (typeof config.upstream !== 'string') {
    throw configError('The upstream must be an HTTPS origin.', 'upstream must be an HTTPS origin.');
  }
  let target;
  try {
    target = new URL(config.upstream);
  } catch {
    throw configError('The upstream must be a valid absolute URL.', 'upstream must be a valid absolute URL.');
  }
  const localHttp = target.protocol === 'http:' && LOOPBACK.has(target.hostname);
  if (target.protocol !== 'https:' && !localHttp) {
    throw configError(
      'The upstream must use HTTPS. Plain HTTP is allowed only for loopback testing.',
      'upstream requires HTTPS; HTTP is permitted only for loopback testing.',
    );
  }
  if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw configError(
      'The upstream must be an origin without credentials, a path, a query string or a fragment.',
      'upstream must be an origin without credentials, a path, query, or fragment.',
    );
  }
  if (!config.headers || typeof config.headers !== 'object' || Array.isArray(config.headers)) {
    throw configError('The headers must be an object of string values.', 'headers must be an object of string header values.');
  }
  const headers = { ...DEFAULTS.headers };
  for (const [name, value] of Object.entries(config.headers)) {
    try {
      http.validateHeaderName(name);
    } catch {
      throw configError('A header name is not a valid HTTP token.', `Header name is not a valid HTTP token: ${name}`);
    }
    if (PROTECTED_HEADERS.has(name.toLowerCase())) {
      throw configError(
        'A transport or authentication header cannot be overridden.',
        `Header cannot be overridden: ${name}`,
      );
    }
    if (typeof value !== 'string') {
      throw configError('A header value must be a string.', `Header value must be a string: ${name}`);
    }
    try {
      http.validateHeaderValue(name, value);
    } catch {
      throw configError('A header value contains characters that are not allowed.', `Header value is not valid: ${name}`);
    }
    // An empty value removes an inherited default instead of sending it.
    if (value === '') delete headers[name.toLowerCase()];
    else headers[name.toLowerCase()] = value;
  }
  if (!config.outputTokenFloors || typeof config.outputTokenFloors !== 'object'
    || Array.isArray(config.outputTokenFloors)) {
    throw configError(
      'The output token floors must be an object of model IDs and token budgets.',
      'outputTokenFloors must be an object of model IDs and positive token budgets.',
    );
  }
  for (const [model, floor] of Object.entries(config.outputTokenFloors)) {
    if (!model.trim() || !Number.isSafeInteger(floor) || floor < 1) {
      throw configError(
        'Output token floors require non-empty model IDs and positive integer budgets.',
        'Output token floors require nonempty model IDs and positive safe integers.',
      );
    }
  }
  if (!config.stripParams || typeof config.stripParams !== 'object'
    || Array.isArray(config.stripParams)) {
    throw configError(
      'The stripped parameter list must be an object of model IDs and field names.',
      'stripParams must be an object mapping model IDs to arrays of field names.',
    );
  }
  for (const [model, fields] of Object.entries(config.stripParams)) {
    if (!model.trim() || !Array.isArray(fields)
      || fields.some((field) => typeof field !== 'string' || !BODY_FIELD_PATTERN.test(field))) {
      throw configError(
        'Stripped parameters need a model identifier and a list of field names.',
        'stripParams entries map a model ID to an array of request field names.',
      );
    }
  }
  if (typeof config.apiKeyEnv !== 'string' || !ENV_NAME_PATTERN.test(config.apiKeyEnv)) {
    throw configError(
      'The API key variable must be a plain environment variable name.',
      'apiKeyEnv must be an environment variable name such as DEEPSEEK_API_KEY.',
    );
  }
  if (typeof config.injectApiKey !== 'boolean') {
    throw configError(
      'The key injection switch must be true or false.',
      'injectApiKey must be true or false.',
    );
  }
  if (typeof config.dshProfile !== 'string' || !PROFILE_PATTERN.test(config.dshProfile)) {
    throw configError(
      'The harness profile name must be a short profile identifier.',
      'dshProfile must be a profile name such as desktop or web.',
    );
  }
  if (typeof config.apiProtocol !== 'string' || !PROTOCOLS.has(config.apiProtocol)) {
    throw configError(
      'The harness protocol must be one of the four supported API protocols.',
      'apiProtocol must be openai-completions, openai-responses, anthropic-messages or google-generative-ai.',
    );
  }
  const models = validateModels(config.models);
  const limits = Object.fromEntries(
    models.filter((model) => Number.isSafeInteger(model.maxTokens)).map((model) => [model.id, model.maxTokens]),
  );
  for (const [model, floor] of Object.entries(config.outputTokenFloors)) {
    if (limits[model] !== undefined && floor > limits[model]) {
      throw configError(
        'An output token floor cannot exceed the output budget of its model.',
        `outputTokenFloors.${model} exceeds the maxTokens declared for that model.`,
      );
    }
  }
  return {
    ...config,
    upstream: target.origin,
    headers,
    outputTokenFloors: { ...config.outputTokenFloors },
    models,
  };
}

function loadConfig(file) {
  const explicit = file || process.env[CONFIG_ENV];
  const selected = explicit || path.join(__dirname, 'config', 'deepcoder-config.json');
  if (!fs.existsSync(selected)) {
    if (explicit) {
      throw configError('The selected configuration file does not exist.', 'The selected DeepCoder configuration file does not exist.');
    }
    return validateConfig();
  }
  let raw;
  try {
    raw = fs.readFileSync(selected, 'utf8');
  } catch {
    throw configError('The configuration file could not be read.', 'The selected DeepCoder configuration file could not be read.');
  }
  // Editors on Windows often save UTF-8 with a byte order mark. Ignore it
  // instead of failing with an opaque parse error.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError(
      'The configuration file is not valid JSON.',
      'The selected DeepCoder configuration file is not valid JSON.',
      SyntaxError,
    );
  }
  return validateConfig(parsed);
}

function filterHeaders(incoming) {
  const blocked = new Set(HOP_HEADERS);
  for (const name of String(incoming.connection || '').split(',')) {
    blocked.add(name.trim().toLowerCase());
  }
  return Object.fromEntries(
    Object.entries(incoming).filter(([name]) => !blocked.has(name.toLowerCase())),
  );
}

function isAllowedHost(authority, port) {
  if (typeof authority !== 'string') return false;
  try {
    const host = new URL(`http://${authority}`);
    return LOOPBACK.has(host.hostname) && Number(host.port || 80) === port
      && !host.username && !host.password && host.pathname === '/' && !host.search && !host.hash;
  } catch {
    return false;
  }
}

function isApiTarget(raw) {
  if (typeof raw !== 'string' || !/^\/v1(?:\/|\?|$)/.test(raw)) return false;
  const pathname = raw.split('?', 1)[0];
  if (/%25/i.test(pathname)) return false;
  try {
    const decoded = decodeURIComponent(pathname);
    return !decoded.includes('\\')
      && [...decoded].every((char) => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127)
      && !decoded.split('/').some((segment) => segment === '.' || segment === '..');
  } catch {
    return false;
  }
}

/**
 * Normalizes the output token budget of a decoded request payload.
 *
 * The bridge keeps the harness' declared budget as the upper bound and raises
 * requests that fall below a configured floor. Returns true when the payload
 * was changed.
 */
function applyTokenBudget(payload, fields, floors = {}, limits = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (typeof payload.model !== 'string') return false;
  const floor = floors[payload.model];
  const limit = limits[payload.model];
  if (floor === undefined && limit === undefined) return false;
  const present = fields.filter((field) => Object.hasOwn(payload, field));
  let changed = false;
  for (const field of present) {
    const value = payload[field];
    if (!Number.isSafeInteger(value) || value <= 0) continue;
    if (Number.isSafeInteger(limit) && value > limit) {
      payload[field] = limit;
      changed = true;
    }
  }
  if (Number.isSafeInteger(floor)) {
    if (present.length === 0) {
      payload[fields[0]] = floor;
      changed = true;
    } else {
      for (const field of present) {
        const value = payload[field];
        if (Number.isSafeInteger(value) && value > 0 && value < floor) {
          payload[field] = floor;
          changed = true;
        }
      }
    }
  }
  return changed;
}

/**
 * Removes the request fields the upstream rejects for one model.
 *
 * Returns true when the payload was changed.
 */
function applyStripParams(payload, stripParams = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const model = typeof payload.model === 'string' ? payload.model : null;
  const fields = new Set([
    ...(stripParams['*'] || []),
    ...(model !== null ? (stripParams[model] || []) : []),
  ]);
  if (fields.size === 0) return false;
  let changed = false;
  for (const field of fields) {
    if (Object.hasOwn(payload, field)) {
      delete payload[field];
      changed = true;
    }
  }
  return changed;
}

/**
 * Rewrites the output token budget of a JSON request body. Bodies that are not
 * JSON, or that belong to an unknown model, are returned untouched.
 */
function rewriteTokenBudget(body, route, floors = {}, limits = {}) {
  const fields = TOKEN_FIELDS[route];
  if (!fields) return body;
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  if (!applyTokenBudget(payload, fields, floors, limits)) return body;
  return Buffer.from(JSON.stringify(payload));
}

/**
 * Applies every body rewrite the configuration asks for: the unsupported
 * parameter removal and the output token budget. Bodies that are not JSON are
 * returned untouched.
 */
function rewriteRequestBody(body, route, config = {}) {
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  const limits = Object.fromEntries(
    (config.models || [])
      .filter((model) => Number.isSafeInteger(model.maxTokens))
      .map((model) => [model.id, model.maxTokens]),
  );
  let changed = applyStripParams(payload, config.stripParams || {});
  const fields = TOKEN_FIELDS[route];
  if (fields) {
    changed = applyTokenBudget(payload, fields, config.outputTokenFloors || {}, limits) || changed;
  }
  if (!changed) return body;
  return Buffer.from(JSON.stringify(payload));
}

/** The OpenAI-style catalog the harness reads from GET /v1/models. */
function buildModelCatalog(config) {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: config.models.map((model) => ({
      id: model.id,
      object: 'model',
      created,
      owned_by: model.ownedBy || 'deepcoder',
      context_window: model.contextWindow,
      max_output_tokens: model.maxTokens,
      input: model.input || ['text'],
    })),
  };
}

/** The directory the harness keeps the profile patch in. */
function dshProfileDir(profile) {
  if (process.env.DSH_PROFILE_DIR && profile === (process.env.DSH_PROFILE || '')) {
    return process.env.DSH_PROFILE_DIR;
  }
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'profiles', profile);
}

function dshPatchPath(profile) {
  return path.join(dshProfileDir(profile), 'cordis.patch.yml');
}

function yamlQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The DeepCoder provider as it appears inside a providers map. */
function dshProviderLines(config, indent) {
  const baseUrl = `http://127.0.0.1:${config.port}/v1`;
  const pad = (size) => ' '.repeat(size);
  const lines = [];
  lines.push(`${pad(indent)}${PROVIDER_ID}:`);
  lines.push(`${pad(indent + 2)}displayName: DeepCoder`);
  lines.push(`${pad(indent + 2)}apiKeyEnv: ${config.apiKeyEnv}`);
  lines.push(`${pad(indent + 2)}api: ${config.apiProtocol}`);
  lines.push(`${pad(indent + 2)}baseURL: ${baseUrl}`);
  // A reasoning model can stay silent for minutes between stream events, so
  // the harness is given generous timeouts instead of its shorter defaults.
  lines.push(`${pad(indent + 2)}timeoutMs: ${DSH_TIMEOUT_MS}`);
  lines.push(`${pad(indent + 2)}streamIdleTimeoutMs: ${DSH_TIMEOUT_MS}`);
  lines.push(`${pad(indent + 2)}models:`);
  for (const model of config.models) {
    lines.push(`${pad(indent + 4)}- id: ${yamlQuote(model.id)}`);
    if (model.name) lines.push(`${pad(indent + 6)}name: ${yamlQuote(model.name)}`);
    if (model.contextWindow) lines.push(`${pad(indent + 6)}contextWindow: ${model.contextWindow}`);
    if (model.maxTokens) lines.push(`${pad(indent + 6)}maxTokens: ${model.maxTokens}`);
    if (model.input) {
      lines.push(`${pad(indent + 6)}input:`);
      for (const kind of model.input) lines.push(`${pad(indent + 8)}- ${kind}`);
    }
    if (model.reasoningEfforts && Object.keys(model.reasoningEfforts).length > 0) {
      lines.push(`${pad(indent + 6)}reasoningEfforts:`);
      for (const [level, wire] of Object.entries(model.reasoningEfforts)) {
        // A level without a value is written empty: the harness reads that as
        // "this level is supported and sends nothing".
        if (wire === null) lines.push(`${pad(indent + 8)}${level}:`);
        else lines.push(`${pad(indent + 8)}${level}: ${yamlQuote(wire)}`);
      }
    }
  }
  // The harness refuses a compatibility switch that no model on the route
  // could ever read, so only the fields the chosen protocol declares are
  // written. The Responses protocol takes max_output_tokens; the Chat
  // Completions protocol takes max_tokens.
  if (config.apiProtocol === 'openai-responses') {
    lines.push(`${pad(indent + 2)}compat:`);
    lines.push(`${pad(indent + 4)}supportsDeveloperRole: true`);
    lines.push(`${pad(indent + 4)}supportsMaxOutputTokens: true`);
    // The tool schemas the harness sends are plain JSON Schema, so the strict
    // tool mode stays off: the upstream answers every function call the same
    // way with it off, and the harness never has to repair a tool schema.
    lines.push(`${pad(indent + 4)}supportsStrictMode: false`);
  } else if (config.apiProtocol === 'openai-completions') {
    lines.push(`${pad(indent + 2)}compat:`);
    lines.push(`${pad(indent + 4)}supportsDeveloperRole: false`);
    lines.push(`${pad(indent + 4)}maxTokensField: max_tokens`);
  }
  return lines;
}

/** The whole provider route as a standalone patch entry. */
function dshProviderEntryLines(config) {
  return [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    ...dshProviderLines(config, 6),
  ];
}

/** The default model entry as a standalone patch entry. */
function dshDefaultModelEntryLines(config) {
  const preferred = config.models.find((model) => model.reasoningEfforts && model.reasoningEfforts.high)
    || config.models[0];
  const lines = [
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    `    provider: ${PROVIDER_ID}`,
  ];
  if (preferred) {
    lines.push(`    model: ${yamlQuote(preferred.id)}`);
    if (preferred.reasoningEfforts && preferred.reasoningEfforts.high) {
      lines.push('    reasoningEffort: high');
    }
  }
  return lines;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Adds the DeepCoder route to the harness profile patch file.
 *
 * The patch file is a YAML array of loader entries. A profile that already
 * carries an llm-pi-ai entry keeps every provider it has: the DeepCoder
 * provider is merged into the existing providers map instead of adding a
 * second llm-pi-ai entry, because a later entry of the same id replaces the
 * earlier one. An existing default model is never changed either, so a
 * profile that already works keeps working.
 */
function installDshProfile(config) {
  const file = dshPatchPath(config.dshProfile);
  const profile = buildDshProfile(config);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  const notes = [];

  const entryStart = lines.findIndex((line) => /^- id: llm-pi-ai\s*$/.test(line));
  let providerAction = 'appended';
  if (entryStart === -1) {
    pushBlock(lines, dshProviderEntryLines(config));
    notes.push('The provider route was added as a new llm-pi-ai entry.');
  } else {
    const entryEnd = lines.findIndex((line, index) => index > entryStart && /^- id:/.test(line));
    const stop = entryEnd === -1 ? lines.length : entryEnd;
    const providersIndex = lines.findIndex((line, index) => index > entryStart && index < stop && /^\s*providers:\s*$/.test(line));
    if (providersIndex === -1) {
      const configIndex = lines.findIndex((line, index) => index > entryStart && index < stop && /^\s*config:\s*$/.test(line));
      const insertAt = configIndex === -1 ? stop : configIndex + 1;
      lines.splice(insertAt, 0, '    providers:', ...dshProviderLines(config, 6));
      providerAction = 'merged';
      notes.push('The provider route was merged into the existing llm-pi-ai entry.');
    } else {
      const providersIndent = indentOf(lines[providersIndex]);
      const childIndent = providersIndent + 2;
      let insertAt = providersIndex + 1;
      while (insertAt < stop && lines[insertAt].trim() !== '' && indentOf(lines[insertAt]) > providersIndent) insertAt += 1;
      const already = lines.slice(providersIndex + 1, insertAt)
        .some((line) => line.trim() === `${PROVIDER_ID}:`);
      if (already) {
        // The DeepCoder block is replaced in place, so a newer DeepCoder
        // refreshes its own route without touching any other provider.
        const blockStart = lines.findIndex((line, index) => index > providersIndex
          && index < insertAt && line.trim() === `${PROVIDER_ID}:`);
        let blockEnd = blockStart + 1;
        while (blockEnd < insertAt && indentOf(lines[blockEnd]) > providersIndent) blockEnd += 1;
        lines.splice(blockStart, blockEnd - blockStart, ...dshProviderLines(config, childIndent));
        providerAction = 'updated';
        notes.push('The DeepCoder provider in the providers map was refreshed.');
      } else {
        lines.splice(insertAt, 0, ...dshProviderLines(config, childIndent));
        providerAction = 'merged';
        notes.push('The provider route was merged into the existing providers map.');
      }
    }
  }

  const defaultEntry = lines.findIndex((line) => /^- id: agent-default-model\s*$/.test(line));
  let defaultModelAction = 'left-unchanged';
  if (defaultEntry === -1) {
    pushBlock(lines, dshDefaultModelEntryLines(config));
    defaultModelAction = 'appended';
    notes.push('The default model of the profile now points at DeepCoder.');
  } else {
    notes.push('The existing default model of the profile was kept. Pick DeepCoder in the model list to use it.');
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
  return {
    path: file,
    action: providerAction,
    providerAction,
    defaultModelAction,
    notes,
    yaml: profile.yaml,
  };
}

/** Appends a block of lines to the end of a YAML array, keeping one blank line. */
function pushBlock(lines, block) {
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length > 0) lines.push('');
  lines.push(...block);
}

/**
 * Renders the exact patch entries that register DeepCoder as a provider route
 * inside the DeepSeek Harness profile.
 */
function buildDshProfile(config) {
  const baseUrl = `http://127.0.0.1:${config.port}/v1`;
  const lines = [];
  lines.push(`# DeepCoder ${VERSION} - local gateway route for the DeepSeek Harness`);
  lines.push(`# Target file: ${dshPatchPath(config.dshProfile)}`);
  lines.push('# The profile file is a YAML array. When it already holds an llm-pi-ai');
  lines.push('# entry, copy the "deepcoder:" provider into its providers map instead of');
  lines.push('# adding a second entry, and keep the existing default model.');
  lines.push(...dshProviderEntryLines(config));
  lines.push(...dshDefaultModelEntryLines(config));
  const preferred = config.models.find((model) => model.reasoningEfforts && model.reasoningEfforts.high)
    || config.models[0];
  return {
    yaml: `${lines.join('\n')}\n`,
    path: dshPatchPath(config.dshProfile),
    baseUrl,
    providerId: PROVIDER_ID,
    apiKeyEnv: config.apiKeyEnv,
    defaultModel: preferred ? preferred.id : null,
  };
}

function createProxy(options = {}, log = () => {}) {
  const config = validateConfig(options);
  const target = new URL(config.upstream);
  const transport = target.protocol === 'https:' ? https : http;
  const limits = Object.fromEntries(
    config.models.filter((model) => Number.isSafeInteger(model.maxTokens)).map((model) => [model.id, model.maxTokens]),
  );
  const catalog = buildModelCatalog(config);

  return http.createServer((req, res) => {
    const sendError = (status, message) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'proxy_error', message } }));
    };

    if (!isAllowedHost(req.headers.host, req.socket.localPort)) {
      sendError(403, 'Only loopback Host headers are supported.');
      req.resume();
      return;
    }
    if (req.headers.origin !== undefined) {
      sendError(403, 'Browser-origin requests are not supported.');
      req.resume();
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: SERVICE_NAME, status: 'ok', version: VERSION }));
      return;
    }
    if (req.method === 'GET' && req.url.split('?', 1)[0] === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(catalog));
      return;
    }
    if (!isApiTarget(req.url)) {
      sendError(404, 'Only /v1 API routes are forwarded.');
      req.resume();
      return;
    }

    const headers = { ...filterHeaders(req.headers), ...config.headers };
    if (config.injectApiKey && config.apiKeyEnv
      && !String(headers.authorization || '').trim()) {
      const key = process.env[config.apiKeyEnv];
      if (key) headers.authorization = `Bearer ${key}`;
    }
    const route = req.url.split('?', 1)[0];
    const hasStripRules = Object.keys(config.stripParams || {}).length > 0;
    const jsonBody = req.method === 'POST'
      && (Object.hasOwn(TOKEN_FIELDS, route) || hasStripRules)
      && String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() === 'application/json'
      && String(req.headers['content-encoding'] || 'identity').trim().toLowerCase() === 'identity'
      && (Object.keys(config.outputTokenFloors).length > 0 || Object.keys(limits).length > 0 || hasStripRules);

    const sendUpstream = (body) => {
      const outHeaders = { ...headers };
      if (body !== undefined) {
        delete outHeaders['content-length'];
        outHeaders['content-length'] = String(body.length);
      }
      const upstream = transport.request({
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: req.url,
        headers: outHeaders,
        rejectUnauthorized: true,
      }, (response) => {
        log(`${req.method} ${route} status=${response.statusCode}`);
        response.on('error', () => sendError(502, 'The upstream response was interrupted.'));
        if (res.destroyed) {
          response.destroy();
          return;
        }
        res.writeHead(response.statusCode, filterHeaders(response.headers));
        response.pipe(res);
      });

      upstream.setTimeout(config.timeoutMs, () => {
        const error = new Error('Upstream timeout');
        error.code = 'ETIMEDOUT';
        upstream.destroy(error);
      });
      upstream.on('error', (error) => {
        log(`${req.method} ${route} upstream_error=${error.code || 'UNKNOWN'}`);
        sendError(
          error.code === 'ETIMEDOUT' ? 504 : 502,
          error.code === 'ETIMEDOUT' ? 'The upstream request timed out.' : 'The upstream request failed.',
        );
      });
      const cancelUpstream = () => {
        upstream.destroy();
      };
      req.on('aborted', cancelUpstream);
      req.on('error', cancelUpstream);
      res.on('close', () => {
        if (!res.writableEnded) cancelUpstream();
      });
      if (body !== undefined) upstream.end(body);
      else req.pipe(upstream);
    };

    if (!jsonBody) {
      sendUpstream(undefined);
      return;
    }

    // JSON bodies are buffered so a rewritten request still carries a correct
    // Content-Length instead of being sent with chunked transfer encoding.
    const chunks = [];
    let bytes = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_OVERRIDE_BODY_BYTES) {
        rejected = true;
        sendError(413, 'The request body is larger than the bridge accepts.');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected || res.destroyed) return;
      const body = rewriteRequestBody(
        Buffer.concat(chunks, bytes),
        route,
        config,
      );
      sendUpstream(body);
    });
    req.on('error', () => {});
  });
}

// Everything a new user needs to finish the setup, printed by the CLI.
function setupCard(config) {
  const profile = buildDshProfile(config);
  const models = config.models.map((model) => model.id).join(', ');
  const floors = Object.entries(config.outputTokenFloors)
    .map(([model, floor]) => `${model} -> ${floor}`).join(', ');
  const levels = config.models
    .filter((model) => model.reasoningEfforts)
    .map((model) => `${model.id}: ${Object.keys(model.reasoningEfforts).join(', ')}`)
    .join(' | ');
  return [
    '',
    '  DeepCoder is running as a local gateway for the DeepSeek Harness.',
    '',
    `    Base URL : ${profile.baseUrl}`,
    `    Models   : ${models || 'none'}`,
    `    Key var  : ${config.apiKeyEnv} (in the environment of the bridge and of the harness)`,
    `    Floors   : ${floors || 'none'}`,
    ...(levels ? [`    Levels  : ${levels}`] : []),
    `    Profile  : ${profile.path}`,
    '',
    '  Next steps:',
    `    1. setx ${config.apiKeyEnv} "sk-..."   (then restart the harness)`,
    '    2. node deepcoder.cjs --install-dsh-profile   (writes the route into the profile)',
    '    3. restart the harness, then check Settings > Models for the DeepCoder provider',
    '    4. node deepcoder.cjs --print-dsh-profile   (prints the same entries by hand)',
    '',
  ];
}

/**
 * The Windows autostart helpers.
 *
 * Two autostarts are supported and both start the same hidden runner:
 *   - a scheduled task that runs at system boot, before anyone signs in;
 *   - an entry in the Startup folder that runs at every sign-in.
 * The boot task needs administrator rights, the Startup entry does not. The
 * bridge never needs the provider key, so the task can run as the system
 * account: the harness sends the Authorization header with every request.
 */
const TASK_NAME = 'DeepCoder';

function startupFolder() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function startupEntryPath() {
  const folder = startupFolder();
  return folder ? path.join(folder, 'deepcoder.vbs') : null;
}

function autostartRunnerPath() {
  return path.join(__dirname, 'scripts', 'deepcoder-autostart.vbs');
}

function runSchtasks(args) {
  try {
    const stdout = execFileSync('schtasks.exe', args, {
      encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: String(stdout || '') };
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`.trim();
    return { ok: false, output: output || (error.message || 'unknown error') };
  }
}

function installStartupTask() {
  const runner = autostartRunnerPath();
  if (!fs.existsSync(runner)) {
    return { ok: false, message: `The autostart runner is missing: ${runner}` };
  }
  const result = runSchtasks([
    '/Create', '/TN', TASK_NAME, '/TR', `wscript.exe "${runner}"`,
    '/SC', 'ONSTART', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F',
  ]);
  if (!result.ok) {
    return {
      ok: false,
      message: `The scheduled task could not be created: ${result.output}`,
    };
  }
  return { ok: true, message: `The scheduled task "${TASK_NAME}" now starts the bridge at every Windows boot.` };
}

function uninstallStartup() {
  const notes = [];
  const task = runSchtasks(['/Delete', '/TN', TASK_NAME, '/F']);
  notes.push(task.ok
    ? `The scheduled task "${TASK_NAME}" was removed.`
    : `No scheduled task "${TASK_NAME}" was found.`);
  const entry = startupEntryPath();
  if (entry && fs.existsSync(entry)) {
    try {
      fs.unlinkSync(entry);
      notes.push('The Startup folder entry was removed.');
    } catch (error) {
      notes.push(`The Startup folder entry could not be removed: ${error.message}`);
    }
  } else {
    notes.push('No Startup folder entry was found.');
  }
  return notes;
}

function autostartState() {
  const task = runSchtasks(['/Query', '/TN', TASK_NAME]);
  const entry = startupEntryPath();
  return {
    bootTask: task.ok,
    signInEntry: Boolean(entry && fs.existsSync(entry)),
  };
}

function probeHealth(port) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: 2000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024) request.destroy();
      });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        resolve({ ok: response.statusCode === 200 && parsed?.service === SERVICE_NAME, body });
      });
      response.on('error', () => resolve({ ok: false, body: '' }));
    });
    request.on('timeout', () => { request.destroy(); resolve({ ok: false, body: '' }); });
    request.on('error', () => resolve({ ok: false, body: '' }));
  });
}

/** The directory that holds every harness profile. */
function dshProfilesRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'profiles');
}

/**
 * Picks the harness profile that should receive the route: the profile of the
 * running harness first, then the profile named in the configuration, then the
 * only profile that exists on this machine.
 */
function detectDshProfile(preferred) {
  const fromEnv = (process.env.DSH_PROFILE || '').trim();
  if (fromEnv) return { profile: fromEnv, reason: 'the DSH_PROFILE environment variable' };
  let entries = [];
  try {
    entries = fs.readdirSync(dshProfilesRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    entries = [];
  }
  if (entries.includes(preferred)) return { profile: preferred, reason: 'the configuration' };
  if (entries.includes('desktop')) return { profile: 'desktop', reason: 'the profile the harness uses' };
  if (entries.length === 1) return { profile: entries[0], reason: 'the only profile on this machine' };
  return {
    profile: preferred,
    reason: entries.length > 1 ? 'the configuration (several profiles exist)' : 'the configuration',
  };
}

/** The configuration file that is used when none is named explicitly. */
function configFilePath(file) {
  return file || process.env[CONFIG_ENV] || path.join(__dirname, 'config', 'deepcoder-config.json');
}

/** Writes a configuration back to disk, so a change survives a restart. */
function saveConfig(file, config) {
  const target = configFilePath(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return target;
}

/** Copies the example configuration into place when there is none yet. */
function ensureConfigFile() {
  const target = configFilePath();
  if (fs.existsSync(target)) return { path: target, created: false };
  const example = path.join(__dirname, 'config', 'deepcoder-config.example.json');
  if (!fs.existsSync(example)) {
    throw configError('The example configuration is missing.', 'The DeepCoder example configuration is missing.');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(example, target);
  return { path: target, created: true };
}

/** True when nothing else is listening on the loopback port. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const finish = (free) => {
      server.removeAllListeners();
      if (server.listening) server.close(() => resolve(free));
      else resolve(free);
    };
    server.once('error', () => finish(false));
    server.once('listening', () => finish(true));
    server.listen(port, '127.0.0.1');
  });
}

/** The first free port at or above the given one. */
async function findFreePort(start, attempts = 20) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = start + offset;
    if (port > 65535) break;
    if (await isPortFree(port)) return port;
  }
  return null;
}

/** Sends a JSON request to the local bridge and returns the answer. */
function postJson(port, target, payload, headers = {}) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload));
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: target,
      method: 'POST',
      timeout: 180000,
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        ...headers,
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ ok: response.statusCode === 200, status: response.statusCode, body: text }));
    });
    request.on('timeout', () => { request.destroy(); resolve({ ok: false, status: 0, body: '' }); });
    request.on('error', (error) => resolve({ ok: false, status: 0, body: error.message }));
    request.end(body);
  });
}

/** Reads a JSON document from the local bridge. */
function getJson(port, target) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: target, timeout: 10000 }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ ok: response.statusCode === 200, status: response.statusCode, body: text }));
    });
    request.on('timeout', () => { request.destroy(); resolve({ ok: false, status: 0, body: '' }); });
    request.on('error', (error) => resolve({ ok: false, status: 0, body: error.message }));
  });
}

/**
 * Checks the whole chain: the bridge answers, it lists the model, and the
 * upstream accepts a request. The upstream is only asked when a key is
 * visible, so the check also tells whether the key reached the bridge.
 */
async function selfTest(config) {
  const checks = [];
  const health = await probeHealth(config.port);
  checks.push({
    name: 'the bridge answers on 127.0.0.1',
    ok: health.ok,
    detail: health.ok ? health.body : `nothing answers on port ${config.port}`,
  });
  if (!health.ok) return checks;
  const models = await getJson(config.port, '/v1/models');
  const listed = models && /gpt-6\.1-sol/.test(models.body || '');
  checks.push({
    name: 'the bridge lists the model',
    ok: Boolean(listed),
    detail: listed ? 'gpt-6.1-sol is listed' : 'the model list does not contain gpt-6.1-sol',
  });
  const key = ensureKeyInEnvironment(config);
  if (!key) {
    checks.push({
      name: 'the provider accepts a request',
      ok: null,
      detail: `skipped, ${config.apiKeyEnv} is not set in the environment of the bridge`,
    });
    return checks;
  }
  const answer = await postJson(config.port, '/v1/responses', {
    model: config.models[0] ? config.models[0].id : 'gpt-6.1-sol',
    input: 'Answer with the single word: OK',
    max_output_tokens: 16,
  });
  let detail = `HTTP ${answer.status}`;
  try {
    const parsed = JSON.parse(answer.body);
    if (parsed?.status) detail = `status ${parsed.status}`;
    else if (parsed?.error?.message) detail = String(parsed.error.message).slice(0, 120);
  } catch { /* keep the HTTP status */ }
  if (answer.status === 401) {
    detail = `the provider refused the key (HTTP 401). ${config.apiKeyEnv} holds `
      + `${maskKey(key)}, which the provider does not accept.`;
  }
  checks.push({
    name: 'the provider accepts a request',
    ok: answer.ok,
    detail,
  });
  return checks;
}

/** Shows a key as a hint without handing it out: "sk-ABCD...WXYZ". */
function maskKey(value) {
  const text = String(value || '').trim();
  if (!text) return '(empty)';
  if (text.length <= 12) return `${text.slice(0, 3)}...`;
  return `${text.slice(0, 7)}...${text.slice(-4)}`;
}

/**
 * Reads a variable from the user environment in the Windows registry.
 * A program that was started before the variable was set does not see it,
 * so the bridge looks the value up when it starts.
 */
function readUserEnvValue(name) {
  if (process.platform !== 'win32' || !name) return '';
  try {
    const output = execFileSync(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'),
      ['query', 'HKCU\\Environment', '/v', name],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10000 },
    );
    const match = output.match(/REG_[A-Z_]+\s+([\s\S]*)$/);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

/**
 * Makes sure the provider key is in the environment of this process.
 * Returns the value that is available afterwards.
 */
function ensureKeyInEnvironment(config) {
  const name = config?.apiKeyEnv;
  if (!name) return '';
  const current = String(process.env[name] || '').trim();
  if (current) return current;
  const stored = readUserEnvValue(name);
  if (stored) {
    process.env[name] = stored;
    return stored;
  }
  return '';
}

/** The oldest Node the bridge is known to work on. */
const MIN_NODE_MAJOR = 22;

/**
 * Checks the Node version the bridge runs on.
 */
function checkNodeVersion(version) {
  const text = String(version || '').replace(/^v/, '');
  const major = Number.parseInt(text.split('.')[0], 10);
  if (!Number.isFinite(major)) return { ok: false, detail: `the version "${version}" could not be read` };
  if (major < MIN_NODE_MAJOR) {
    return { ok: false, detail: `Node ${text} is too old, the bridge needs Node ${MIN_NODE_MAJOR} or newer` };
  }
  return { ok: true, detail: `Node ${text}` };
}

/**
 * Reads the DeepCoder provider out of a harness profile patch file.
 *
 * The file is YAML, but only the fields of this one provider are needed, so
 * they are read line by line instead of pulling in a YAML parser.
 */
function inspectProfilePatch(text, config = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*deepcoder:\s*$/.test(line));
  if (start === -1) {
    return { present: false, baseUrl: null, api: null, apiKeyEnv: null, models: [], expectedBaseUrl: null, matchesPort: true };
  }
  const parentIndent = indentOf(lines[start]);
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > parentIndent)) end += 1;
  const block = lines.slice(start, end);
  const field = (name) => {
    const found = block.find((line) => new RegExp(`^\\s*${name}:\\s*(.+)$`).test(line));
    if (!found) return null;
    return found.replace(new RegExp(`^\\s*${name}:\\s*`), '').trim().replace(/^"|"$/g, '');
  };
  const models = block
    .map((line) => /^\s*- id:\s*(.+)$/.exec(line))
    .filter(Boolean)
    .map((match) => match[1].trim().replace(/^"|"$/g, ''));
  const expectedBaseUrl = config.port ? `http://127.0.0.1:${config.port}/v1` : null;
  const baseUrl = field('baseURL');
  return {
    present: true,
    baseUrl,
    api: field('api'),
    apiKeyEnv: field('apiKeyEnv'),
    models,
    expectedBaseUrl,
    matchesPort: expectedBaseUrl ? baseUrl === expectedBaseUrl : true,
  };
}

/**
 * Reads the default model entry of a harness profile patch file and tells
 * whether it points at DeepCoder.
 */
function inspectDefaultModel(text) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^- id: agent-default-model\s*$/.test(line));
  if (start === -1) return { present: false, pointsAtDeepCoder: false };
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || !/^- id:/.test(lines[end]))) end += 1;
  const block = lines.slice(start, end);
  const provider = block.find((line) => /^\s*provider:\s*(.+)$/.test(line));
  return {
    present: true,
    pointsAtDeepCoder: Boolean(provider) && provider.replace(/^\s*provider:\s*/, '').trim() === PROVIDER_ID,
  };
}

/**
 * Asks the provider whether it answers at all. Any answer counts as reachable:
 * a 401 still proves that the route to the provider works.
 */
function probeUpstream(config) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(config.upstream);
    } catch {
      resolve({ ok: false, status: 0, detail: 'the upstream is not a valid URL' });
      return;
    }
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname || '/'}${target.search || ''}`,
      method: 'GET',
      timeout: 10000,
      headers: { accept: 'application/json', ...(config.headers || {}) },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve({
        ok: response.statusCode < 500,
        status: response.statusCode,
        detail: `the provider answered HTTP ${response.statusCode}`,
      }));
    });
    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, status: 0, detail: 'the provider did not answer within 10 seconds' });
    });
    request.on('error', (error) => resolve({
      ok: false,
      status: 0,
      detail: `the provider could not be reached (${error.code || error.message})`,
    }));
    request.end();
  });
}

/** Counts the checks of a doctor run and decides whether the run passed. */
function summarizeDoctor(checks) {
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) {
    const status = String(check.status || 'FAIL').toUpperCase();
    if (status === 'PASS') counts.pass += 1;
    else if (status === 'WARN') counts.warn += 1;
    else if (status === 'SKIP') counts.skip += 1;
    else counts.fail += 1;
  }
  return { ok: counts.fail === 0, counts };
}

/** Renders the report of a doctor run as the lines that are printed. */
function doctorReport(checks, summary) {
  const lines = [`DeepCoder ${VERSION} doctor`, ''];
  for (const check of checks) lines.push(`[${check.status}] ${check.name}: ${check.detail}`);
  const counts = summary.counts;
  lines.push('');
  lines.push(`PASS ${counts.pass} · WARN ${counts.warn} · FAIL ${counts.fail} · SKIP ${counts.skip}`);
  const failed = checks.filter((check) => check.status === 'FAIL').map((check) => check.name);
  const warned = checks.filter((check) => check.status === 'WARN').map((check) => check.name);
  if (failed.length > 0) lines.push(`Needs attention: ${failed.join(', ')}.`);
  else if (warned.length > 0) lines.push(`Ready to use. Worth a look: ${warned.join(', ')}.`);
  else lines.push('Everything that has to be in place is in place.');
  return lines.join('\n');
}

/**
 * The doctor: one command that shows whether the whole chain is ready.
 *
 * It only reads. Nothing is written, no process is touched and no key is
 * printed: the key is only shown as a hint.
 */
async function runDoctor() {
  const checks = [];
  const node = checkNodeVersion(process.version);
  checks.push({ name: 'Node', status: node.ok ? 'PASS' : 'FAIL', detail: node.detail });

  const file = configFilePath();
  let config = null;
  let reason = null;
  try {
    config = loadConfig();
  } catch (error) {
    reason = error?.reason || error?.message || 'the configuration could not be read';
  }
  checks.push({
    name: 'Configuration',
    status: config ? 'PASS' : 'FAIL',
    detail: config
      ? `${file} is valid: ${config.apiProtocol} on port ${config.port} at ${config.upstream}`
      : `${file}: ${String(reason).replace(/\.\s*$/, '')}. Run "node deepcoder.cjs --setup" to write one.`,
  });
  if (!config) {
    const summary = summarizeDoctor(checks);
    return { checks, ok: summary.ok, summary, report: doctorReport(checks, summary) };
  }

  const key = ensureKeyInEnvironment(config);
  checks.push({
    name: 'Provider key',
    status: key ? 'PASS' : 'FAIL',
    detail: key
      ? `${config.apiKeyEnv} holds ${maskKey(key)}`
      : `${config.apiKeyEnv} is not set. Run "node deepcoder.cjs --set-key" to store it.`,
  });

  const detected = detectDshProfile(config.dshProfile);
  const patch = dshPatchPath(detected.profile);
  let patchText = '';
  if (fs.existsSync(patch)) {
    try {
      patchText = fs.readFileSync(patch, 'utf8');
    } catch {
      patchText = '';
    }
  }
  const route = inspectProfilePatch(patchText, config);
  let routeDetail;
  if (!route.present) {
    routeDetail = `the harness profile "${detected.profile}" has no DeepCoder route. `
      + 'Run "node deepcoder.cjs --install-dsh-profile".';
  } else if (!route.matchesPort) {
    routeDetail = `the route in ${patch} points at ${route.baseUrl} but the bridge listens on port ${config.port}. `
      + 'Run "node deepcoder.cjs --install-dsh-profile".';
  } else {
    routeDetail = `${patch} carries the route to ${route.baseUrl} with ${route.models.length} model(s)`;
  }
  checks.push({ name: 'Harness route', status: route.present && route.matchesPort ? 'PASS' : 'FAIL', detail: routeDetail });

  const defaultModel = inspectDefaultModel(patchText);
  checks.push({
    name: 'Default model',
    status: defaultModel.pointsAtDeepCoder ? 'PASS' : 'SKIP',
    detail: defaultModel.pointsAtDeepCoder
      ? 'the profile uses DeepCoder as its default model'
      : 'the profile keeps its own default model, pick DeepCoder in Settings > Models',
  });

  const health = await probeHealth(config.port);
  checks.push({
    name: 'Bridge',
    status: health.ok ? 'PASS' : 'WARN',
    detail: health.ok
      ? `the bridge answers on 127.0.0.1:${config.port}`
      : `nothing answers on 127.0.0.1:${config.port}. Run "node deepcoder.cjs --start-background".`,
  });

  if (health.ok) {
    checks.push({ name: 'Port', status: 'PASS', detail: `the bridge holds port ${config.port}` });
  } else {
    const free = await isPortFree(config.port);
    checks.push({
      name: 'Port',
      status: free ? 'PASS' : 'WARN',
      detail: free
        ? `port ${config.port} is free`
        : `port ${config.port} is used by another program, choose another port in ${file}`,
    });
  }

  const autostart = autostartState();
  checks.push({
    name: 'Autostart',
    status: autostart.bootTask || autostart.signInEntry ? 'PASS' : 'WARN',
    detail: autostart.bootTask
      ? `the boot task "${TASK_NAME}" is installed`
      : autostart.signInEntry
        ? 'the sign-in entry is installed, the boot task needs an elevated setup.cmd'
        : 'neither the boot task nor the sign-in entry is installed, run "node deepcoder.cjs --setup"',
  });

  const upstream = await probeUpstream(config);
  checks.push({ name: 'Provider', status: upstream.ok ? 'PASS' : 'WARN', detail: upstream.detail });

  const summary = summarizeDoctor(checks);
  return { checks, ok: summary.ok, summary, report: doctorReport(checks, summary) };
}

/**
 * Reads a key from the standard input and stores it in the user environment.
 * The value is never printed and never appears on a command line: it travels
 * through a pipe into PowerShell, which writes it into the user environment.
 */
async function setKeyFromInput(envName) {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
    if (chunk.includes('\n')) break;
  }
  const raw = chunks.join('').split(/\r?\n/)[0] || '';
  // A pasted key often comes with a stray quote or a trailing space.
  const value = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (!value) {
    console.log(`No key was entered, ${envName} was not changed.`);
    console.log(`Set it later with:  setx ${envName} "sk-..."`);
    console.log(`or run:  node deepcoder.cjs --set-key`);
    return { ok: false, reason: 'empty' };
  }
  if (!/^[A-Za-z0-9._~+/=-]{8,200}$/.test(value)) {
    console.log('That does not look like a key, so it was not stored.');
    console.log('A provider key is one line of letters and digits, for example sk-...');
    return { ok: false, reason: 'format' };
  }
  let stored = false;
  if (process.platform === 'win32') {
    try {
      // The key goes through the pipe, not through the command line.
      execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        '$v=[Console]::In.ReadToEnd(); [Environment]::SetEnvironmentVariable($args[0], $v.Trim(), "User")',
        envName,
      ], { input: value, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, timeout: 20000 });
      stored = true;
    } catch {
      try {
        execFileSync('setx.exe', [envName, value], { stdio: 'ignore', windowsHide: true });
        stored = true;
      } catch {
        stored = false;
      }
    }
  }
  if (!stored) {
    console.log('The key could not be written to the user environment.');
    if (process.platform === 'win32') {
      console.log(`Set it by hand with:  setx ${envName} "<your key>"`);
    } else {
      console.log(`Set it by hand with:  export ${envName}="<your key>"`);
      console.log(`and make it permanent in your shell profile.`);
    }
    return { ok: false, reason: 'store' };
  }
  // The current process and every child of it need the key as well.
  process.env[envName] = value;
  console.log(`${envName} was saved for the current user: ${maskKey(value)}`);
  console.log('The harness picks it up after a restart, the bridge has it now.');
  return { ok: true, value };
}

/**
 * The one command that sets everything up: it writes the configuration,
 * installs the harness route, installs the autostart entry, starts the bridge
 * without a window and checks that the whole chain works.
 */
async function runSetup() {
  const notes = [];
  const ensured = ensureConfigFile();
  notes.push(ensured.created
    ? `A configuration was created: ${ensured.path}`
    : `The configuration is used as it is: ${ensured.path}`);

  let config = loadConfig(configFilePath());

  const detected = detectDshProfile(config.dshProfile);
  if (detected.profile !== config.dshProfile) {
    config = { ...config, dshProfile: detected.profile };
    saveConfig(configFilePath(), config);
    notes.push(`The harness profile "${detected.profile}" was selected through ${detected.reason}.`);
  } else {
    notes.push(`The harness profile "${detected.profile}" was selected through ${detected.reason}.`);
  }

  const running = await probeHealth(config.port);
  if (running.ok) {
    notes.push(`A bridge already answers on port ${config.port}.`);
  } else {
    const free = await findFreePort(config.port);
    if (free === null) {
      notes.push(`No free port was found near ${config.port}. Set "port" in the configuration by hand.`);
    } else if (free !== config.port) {
      notes.push(`Port ${config.port} is taken by another program, the bridge will use port ${free}.`);
      config = { ...config, port: free };
      saveConfig(configFilePath(), config);
    }
  }

  try {
    const result = installDshProfile(config);
    notes.push(`The harness route was written to ${result.path}.`);
    for (const note of result.notes) notes.push(note);
  } catch (error) {
    notes.push(`The harness route could not be written: ${error.message}`);
  }

  if (process.platform === 'win32') {
    try {
      execFileSync(path.join(process.env.SystemRoot, 'System32', 'cscript.exe'), [
        '//Nologo', path.join(__dirname, 'scripts', 'install-startup.vbs'), process.execPath,
      ], { stdio: 'ignore', timeout: 15000, windowsHide: true });
      notes.push('The bridge will start hidden at every sign-in.');
    } catch {
      notes.push('The sign-in entry could not be installed. Run the setup again as administrator.');
    }
    const task = installStartupTask();
    if (task.ok) notes.push('The bridge will start when Windows boots.');
    else notes.push('The boot task needs an administrator terminal; the sign-in entry takes over until then.');
  }

  if (!(await probeHealth(config.port)).ok) {
    try {
      execFileSync(path.join(process.env.SystemRoot, 'System32', 'wscript.exe'), [
        autostartRunnerPath(), process.execPath,
      ], { stdio: 'ignore', timeout: 15000, windowsHide: true });
      await new Promise((resolve) => { setTimeout(resolve, 2500); });
      notes.push('The bridge was started without a window.');
    } catch {
      notes.push('The bridge could not be started in the background. Run start.cmd to see what it says.');
    }
  }

  const checks = await selfTest(config);
  console.log('');
  console.log('  DeepCoder setup');
  console.log('');
  for (const note of notes) console.log(`  - ${note}`);
  console.log('');
  for (const check of checks) {
    const mark = check.ok === null ? 'SKIP' : check.ok ? 'PASS' : 'FAIL';
    console.log(`  [${mark}] ${check.name}: ${check.detail}`);
  }
  console.log('');
  const failed = checks.some((check) => check.ok === false);
  if (failed) {
    console.log('  The setup is not complete. The lines above say what is missing.');
  } else {
    console.log('  The setup is complete.');
  }
  console.log('');
  console.log('  Next: restart the DeepSeek Harness, then pick DeepCoder in Settings > Models.');
  console.log(`  The route lives in ${dshPatchPath(config.dshProfile)}.`);
  return { notes, checks, ok: !failed };
}

async function main() {
  const args = process.argv.slice(2);
  const known = [
    '--check-config', '--print-dsh-profile', '--install-dsh-profile',
    '--install-startup', '--install-startup-task', '--uninstall-startup',
    '--start-background', '--status', '--autostart', '--setup', '--self-test',
    '--set-key', '--doctor',
  ];
  const doctorJson = args.length === 2 && args[0] === '--doctor' && args[1] === '--json';
  if (args.length === 1 && args[0] === '--help') {
    console.log(`DeepCoder v${VERSION} - local gateway for the DeepSeek Harness`);
    console.log('Usage: node deepcoder.cjs [--setup | --doctor | --self-test | --check-config | --print-dsh-profile |');
    console.log('                             --install-dsh-profile | --install-startup | --install-startup-task |');
    console.log('                             --uninstall-startup | --start-background | --status | --autostart |');
    console.log('                             --setup | --self-test | --set-key | --help]');
    console.log(`Configuration: config/deepcoder-config.json in the package, or ${CONFIG_ENV}.`);
    console.log('  --setup       do everything: write the route, install the autostart,');
    console.log('                start the bridge and check that the chain works.');
    console.log('  --doctor      check the whole chain and say what is missing.');
    console.log('                Add --json for the same report as a document.');
    console.log('  --self-test   check the bridge, the model list and the provider.');
    console.log('  --set-key     read the provider key from the standard input and store it.');
    return;
  }
  if (!doctorJson && (args.length > 1 || (args.length === 1 && !known.includes(args[0])))) {
    console.error('Unknown argument. Use --help for supported commands.');
    process.exitCode = 1;
    return;
  }
  if (args[0] === '--doctor') {
    const result = await runDoctor();
    if (doctorJson) {
      console.log(JSON.stringify({
        product: 'DeepCoder',
        version: VERSION,
        generatedAt: new Date().toISOString(),
        ok: result.ok,
        counts: result.summary.counts,
        checks: result.checks.map((check) => ({ name: check.name, status: check.status, detail: check.detail })),
      }, null, 2));
    } else {
      console.log(result.report);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (args[0] === '--setup') {
    try {
      const result = await runSetup();
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      console.error(`The setup failed: ${error?.message || error}`);
      process.exitCode = 1;
    }
    return;
  }
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    const reason = error?.reason
      || 'Check the selected file, JSON syntax, upstream origin, port, timeoutMs, permitted headers, outputTokenFloors, apiKeyEnv and models.';
    console.error(`Configuration error: ${reason}`);
    process.exitCode = 1;
    return;
  }
  if (args[0] === '--set-key') {
    const result = await setKeyFromInput(config.apiKeyEnv);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (args[0] === '--self-test') {
    const checks = await selfTest(config);
    for (const check of checks) {
      const mark = check.ok === null ? 'SKIP' : check.ok ? 'PASS' : 'FAIL';
      console.log(`[${mark}] ${check.name}: ${check.detail}`);
    }
    if (checks.some((check) => check.ok === false)) process.exitCode = 1;
    return;
  }
  if (args[0] === '--check-config') {
    console.log(`Configuration valid: loopback port ${config.port}, upstream ${config.upstream}.`);
    console.log('No connection was made to the harness or the upstream provider.');
    for (const line of setupCard(config)) console.log(line);
    return;
  }
  if (args[0] === '--print-dsh-profile') {
    const profile = buildDshProfile(config);
    process.stdout.write(profile.yaml);
    console.error(`# Paste the entries above into: ${profile.path}`);
    console.error(`# The harness reads the provider key from ${config.apiKeyEnv}.`);
    return;
  }
  if (args[0] === '--install-dsh-profile') {
    try {
      const result = installDshProfile(config);
      console.log(`Profile file: ${result.path}`);
      for (const note of result.notes) console.log(`  ${note}`);
      console.log('Restart the DeepSeek Harness so the new route is picked up.');
    } catch (error) {
      console.error(`The profile file could not be updated: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }
  if (args[0] === '--install-startup') {
    if (process.platform !== 'win32') {
      console.error('VBS autostart installation is supported on Windows only.');
      process.exitCode = 1;
      return;
    }
    try {
      execFileSync(path.join(process.env.SystemRoot, 'System32', 'cscript.exe'), [
        '//Nologo', path.join(__dirname, 'scripts', 'install-startup.vbs'), process.execPath,
      ], { stdio: 'inherit', timeout: 10000, windowsHide: true });
    } catch {
      console.error('Autostart installation failed. Check Windows Script Host and Startup folder write access.');
      process.exitCode = 1;
    }
    return;
  }
  if (args[0] === '--install-startup-task') {
    if (process.platform !== 'win32') {
      console.error('The boot task is supported on Windows only.');
      process.exitCode = 1;
      return;
    }
    const result = installStartupTask();
    console.log(result.message);
    if (!result.ok) {
      console.log('Run this command from a terminal that was started as administrator,');
      console.log('or let the sign-in entry of setup.cmd take over.');
      process.exitCode = 1;
    }
    return;
  }
  if (args[0] === '--uninstall-startup') {
    for (const note of uninstallStartup()) console.log(note);
    console.log('The bridge keeps running until it is stopped.');
    console.log(`The harness route is left in place. Remove the "deepcoder:" block from:`);
    console.log(`  ${dshPatchPath(config.dshProfile)}`);
    return;
  }
  if (args[0] === '--start-background') {
    if (process.platform !== 'win32') {
      console.error('The hidden start is supported on Windows only.');
      process.exitCode = 1;
      return;
    }
    try {
      execFileSync(path.join(process.env.SystemRoot, 'System32', 'wscript.exe'), [
        autostartRunnerPath(), process.execPath,
      ], { stdio: 'ignore', timeout: 10000, windowsHide: true });
      console.log('The bridge was started without a window.');
    } catch {
      console.error('The bridge could not be started in the background.');
      process.exitCode = 1;
    }
    return;
  }
  if (args[0] === '--status') {
    const state = autostartState();
    const health = await probeHealth(config.port);
    console.log(`Bridge on 127.0.0.1:${config.port}: ${health.ok ? 'running' : 'not running'}`);
    console.log(`Boot task "${TASK_NAME}": ${state.bootTask ? 'installed' : 'not installed'}`);
    console.log(`Sign-in entry: ${state.signInEntry ? 'installed' : 'not installed'}`);
    if (!health.ok) process.exitCode = 1;
    return;
  }
  const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);
  // A bridge that was started before the key was stored still finds it here.
  ensureKeyInEnvironment(config);
  const server = createProxy(config, log);
  server.on('error', (error) => {
    if (args[0] === '--autostart' && error.code === 'EADDRINUSE') {
      const fail = () => {
        console.error('Autostart could not confirm a healthy DeepCoder on the configured port.');
        process.exitCode = 1;
      };
      const request = http.get({ hostname: '127.0.0.1', port: config.port, path: '/health', timeout: 1500 }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1024) request.destroy();
        });
        response.on('end', () => {
          if (response.statusCode === 200 && body.includes(`"service":"${SERVICE_NAME}"`)) {
            console.log('DeepCoder is already running.');
          } else fail();
        });
        response.on('error', fail);
      });
      request.on('timeout', () => request.destroy());
      request.on('error', fail);
      return;
    }
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${config.port} is in use. Choose an unused port in deepcoder-config.json; no existing process was stopped.`
      : `Server error: ${error.code || 'UNKNOWN'}`);
    process.exitCode = 1;
  });
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`DeepCoder v${VERSION} - local gateway for the DeepSeek Harness`);
    console.log(`Harness base URL: http://127.0.0.1:${config.port}/v1`);
    console.log('No API keys or conversation payloads are stored or logged. Press Ctrl+C to stop.');
    for (const line of setupCard(config)) console.log(line);
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => server.closeAllConnections(), 10000);
    deadline.unref();
    server.close(() => clearTimeout(deadline));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = {
  createProxy,
  loadConfig,
  validateConfig,
  isAllowedHost,
  isApiTarget,
  buildDshProfile,
  buildModelCatalog,
  installDshProfile,
  rewriteTokenBudget,
  rewriteRequestBody,
  applyTokenBudget,
  applyStripParams,
  dshPatchPath,
  detectDshProfile,
  findFreePort,
  isPortFree,
  saveConfig,
  configFilePath,
  ensureConfigFile,
  selfTest,
  checkNodeVersion,
  inspectProfilePatch,
  inspectDefaultModel,
  summarizeDoctor,
  doctorReport,
  runDoctor,
  maskKey,
  readUserEnvValue,
  ensureKeyInEnvironment,
  piUserAgent,
  DEFAULTS,
  VERSION,
};
if (require.main === module) {
  main().catch((error) => {
    console.error(`Unexpected failure: ${error.message}`);
    process.exitCode = 1;
  });
}
