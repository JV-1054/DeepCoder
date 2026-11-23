'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
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
  ensureConfigFile,
  selfTest,
  maskKey,
  readUserEnvValue,
  ensureKeyInEnvironment,
  piUserAgent,
  DEFAULTS,
  VERSION,
} = require('../deepcoder.cjs');

function withServer(options, run) {
  return new Promise((resolve, reject) => {
    const server = createProxy(options, () => {});
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const done = (error) => {
        server.closeAllConnections();
        server.close(() => (error ? reject(error) : resolve()));
      };
      run({ port, baseUrl: `http://127.0.0.1:${port}` }, done);
    });
  });
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function fakeUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try {
          json = raw.length ? JSON.parse(raw.toString('utf8')) : null;
        } catch {
          json = null;
        }
        handler(req, res, raw, json);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('the defaults describe the AgentRouter route the harness needs', () => {
  const config = validateConfig();
  assert.equal(config.upstream, 'https://agentrouter.org');
  assert.equal(config.port, 8899);
  assert.equal(config.apiProtocol, 'openai-responses');
  assert.equal(config.apiKeyEnv, 'AGENTROUTER_API_KEY');
  assert.equal(config.outputTokenFloors['gpt-6.1-sol'], 16384);
  assert.equal(config.models.length, 1);
  assert.equal(config.models[0].id, 'gpt-6.1-sol');
  assert.equal(config.models[0].contextWindow, 262144);
  assert.equal(config.models[0].maxTokens, 16384);
  assert.match(config.headers['user-agent'], /^pi \(/);
  assert.equal(config.headers.originator, 'pi');
});

test('an unknown configuration field is refused', () => {
  assert.throws(() => validateConfig({ nope: 1 }), /Unknown configuration field/);
});

test('the port must be a valid TCP port', () => {
  assert.throws(() => validateConfig({ port: 0 }), /port must be an integer/);
  assert.throws(() => validateConfig({ port: 70000 }), /port must be an integer/);
  assert.throws(() => validateConfig({ port: 'x' }), /port must be an integer/);
});

test('the timeout must be a positive integer', () => {
  assert.throws(() => validateConfig({ timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => validateConfig({ timeoutMs: 1.5 }), /timeoutMs/);
});

test('the upstream must be an HTTPS origin', () => {
  assert.throws(() => validateConfig({ upstream: 'http://example.com' }), /HTTPS/);
  assert.throws(() => validateConfig({ upstream: 'https://example.com/v1' }), /origin/);
  assert.throws(() => validateConfig({ upstream: 'https://user:pw@example.com' }), /origin/);
  assert.throws(() => validateConfig({ upstream: 'not a url' }), /valid absolute URL/);
  assert.equal(validateConfig({ upstream: 'http://127.0.0.1:8080' }).upstream, 'http://127.0.0.1:8080');
  assert.equal(validateConfig({ upstream: 'http://localhost:8080' }).upstream, 'http://localhost:8080');
});

test('transport and authentication headers cannot be overridden', () => {
  assert.throws(() => validateConfig({ headers: { authorization: 'Bearer x' } }), /cannot be overridden/);
  assert.throws(() => validateConfig({ headers: { 'content-length': '5' } }), /cannot be overridden/);
  assert.throws(() => validateConfig({ headers: { 'x-api-key': 'x' } }), /cannot be overridden/);
});

test('an empty header value removes an inherited default', () => {
  const config = validateConfig({ headers: { originator: '' } });
  assert.equal(Object.hasOwn(config.headers, 'originator'), false);
  assert.equal(config.headers['user-agent'], DEFAULTS.headers['user-agent']);
});

test('the client identity is computed for the running system', () => {
  assert.equal(piUserAgent(), `pi (${os.platform()} ${os.release()}; ${os.arch()})`);
  assert.match(piUserAgent(), /^pi \([^;]+ [^;]+; [^)]+\)$/);
});

test('a header name and value must be valid HTTP', () => {
  assert.throws(() => validateConfig({ headers: { 'bad header': 'x' } }), /valid HTTP token/);
  assert.throws(() => validateConfig({ headers: { 'x-test': 'bad\nvalue' } }), /not valid/);
});

test('output token floors must be positive integers', () => {
  assert.throws(() => validateConfig({ outputTokenFloors: { 'gpt-6.1-sol': 0 } }), /positive/);
  assert.throws(() => validateConfig({ outputTokenFloors: { '': 10 } }), /positive/);
});

test('a floor cannot exceed the output budget of its model', () => {
  assert.throws(() => validateConfig({ outputTokenFloors: { 'gpt-6.1-sol': 999999 } }), /exceeds/);
});

test('the credential variable must be an environment variable name', () => {
  assert.throws(() => validateConfig({ apiKeyEnv: 'not a name' }), /environment variable/);
  assert.throws(() => validateConfig({ apiKeyEnv: '1BAD' }), /environment variable/);
});

test('the key injection switch must be true or false', () => {
  assert.throws(() => validateConfig({ injectApiKey: 'yes' }), /injectApiKey/);
  assert.equal(validateConfig({ injectApiKey: false }).injectApiKey, false);
  assert.equal(validateConfig({}).injectApiKey, true);
});

test('the harness protocol must be one the harness supports', () => {
  assert.throws(() => validateConfig({ apiProtocol: 'grpc' }), /apiProtocol/);
  for (const protocol of ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']) {
    assert.equal(validateConfig({ apiProtocol: protocol }).apiProtocol, protocol);
  }
});

test('the profile name must be a short identifier', () => {
  assert.throws(() => validateConfig({ dshProfile: 'with space' }), /dshProfile/);
});

test('stripped parameters need a model identifier and field names', () => {
  assert.throws(() => validateConfig({ stripParams: { 'gpt-6.1-sol': 'temperature' } }), /stripParams/);
  assert.throws(() => validateConfig({ stripParams: { 'gpt-6.1-sol': ['not a field'] } }), /stripParams/);
  const config = validateConfig({ stripParams: { '*': ['temperature'] } });
  assert.deepEqual(config.stripParams['*'], ['temperature']);
});

test('model descriptors are checked field by field', () => {
  assert.throws(() => validateConfig({ models: [{ id: 'a', nope: 1 }] }), /Unknown model field/);
  assert.throws(() => validateConfig({ models: [{ id: 'bad id!' }] }), /Model id is missing/);
  assert.throws(() => validateConfig({ models: [{ id: 'a' }, { id: 'a' }] }), /Duplicate model id/);
  assert.throws(() => validateConfig({ models: [{ id: 'a', contextWindow: 0 }] }), /positive integer/);
  assert.throws(() => validateConfig({ models: [{ id: 'a', input: ['audio'] }] }), /input must be a list/);
  assert.throws(() => validateConfig({ models: [{ id: 'a', reasoningEfforts: { high: 1 } }] }), /map level names to non-empty strings/);
  assert.throws(() => validateConfig({ models: [{ id: 'a', reasoningEfforts: { turbo: 'high' } }] }), /unknown level/);
  assert.throws(() => validateConfig({ models: [{ id: 'a', reasoningEfforts: {} }] }), /must not be empty/);
  assert.throws(() => validateConfig({ models: [{ id: 'a', reasoningEfforts: { off: null } }] }), /no level beyond/);
  assert.throws(() => validateConfig({ models: [{ id: 'a', reasoningEfforts: { high: null } }] }), /non-empty strings/);
});

test('the reasoning levels of the shipped model are offered to the harness', () => {
  const config = validateConfig({});
  const model = config.models.find((entry) => entry.id === 'gpt-6.1-sol');
  assert.deepEqual(Object.keys(model.reasoningEfforts), [
    'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
  ]);
  for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(model.reasoningEfforts[level], level);
  }
});

test('a configuration file is read, byte order mark included', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepcoder-config-'));
  const file = path.join(dir, 'deepcoder-config.json');
  fs.writeFileSync(file, `\ufeff${JSON.stringify({ port: 9123 })}`, 'utf8');
  try {
    assert.equal(loadConfig(file).port, 9123);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken configuration file reports a clear error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepcoder-config-'));
  const file = path.join(dir, 'deepcoder-config.json');
  fs.writeFileSync(file, '{ not json', 'utf8');
  try {
    assert.throws(() => loadConfig(file), /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing configuration file that was named explicitly is reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepcoder-config-'));
  try {
    assert.throws(() => loadConfig(path.join(dir, 'absent.json')), /does not exist/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without a configuration file the defaults are used', () => {
  const saved = process.env.DEEPCODER_CONFIG;
  delete process.env.DEEPCODER_CONFIG;
  try {
    const config = loadConfig();
    assert.equal(config.upstream, 'https://agentrouter.org');
    assert.equal(config.port, 8899);
  } finally {
    if (saved !== undefined) process.env.DEEPCODER_CONFIG = saved;
  }
});

test('only loopback hosts of the bridge port are allowed', () => {
  assert.equal(isAllowedHost(`127.0.0.1:8899`, 8899), true);
  assert.equal(isAllowedHost('localhost:8899', 8899), true);
  assert.equal(isAllowedHost('[::1]:8899', 8899), true);
  assert.equal(isAllowedHost('example.com:8899', 8899), false);
  assert.equal(isAllowedHost('127.0.0.1:1234', 8899), false);
  assert.equal(isAllowedHost(undefined, 8899), false);
});

test('only the /v1 API surface is forwarded', () => {
  assert.equal(isApiTarget('/v1/responses'), true);
  assert.equal(isApiTarget('/v1/models'), true);
  assert.equal(isApiTarget('/v1'), true);
  assert.equal(isApiTarget('/v1/responses?x=1'), true);
  assert.equal(isApiTarget('/v2/responses'), false);
  assert.equal(isApiTarget('/health'), false);
  assert.equal(isApiTarget('/v1/../admin'), false);
  assert.equal(isApiTarget('/v1/%252e%252e'), false);
  assert.equal(isApiTarget('/v1\\responses'), false);
});

test('the output token budget is raised to the floor and capped at the model limit', () => {
  const payload = { model: 'gpt-6.1-sol', max_output_tokens: 16 };
  assert.equal(applyTokenBudget(payload, ['max_output_tokens'], { 'gpt-6.1-sol': 16384 }, { 'gpt-6.1-sol': 16384 }), true);
  assert.equal(payload.max_output_tokens, 16384);

  const over = { model: 'gpt-6.1-sol', max_output_tokens: 999999 };
  applyTokenBudget(over, ['max_output_tokens'], { 'gpt-6.1-sol': 16384 }, { 'gpt-6.1-sol': 16384 });
  assert.equal(over.max_output_tokens, 16384);

  const missing = { model: 'gpt-6.1-sol' };
  applyTokenBudget(missing, ['max_output_tokens'], { 'gpt-6.1-sol': 16384 }, {});
  assert.equal(missing.max_output_tokens, 16384);

  const other = { model: 'other-model', max_output_tokens: 16 };
  assert.equal(applyTokenBudget(other, ['max_output_tokens'], { 'gpt-6.1-sol': 16384 }, {}), false);
  assert.equal(other.max_output_tokens, 16);
});

test('the token budget rewrite leaves bodies that need no change untouched', () => {
  const body = Buffer.from(JSON.stringify({ model: 'gpt-6.1-sol', max_output_tokens: 16384 }));
  const rewritten = rewriteTokenBudget(body, '/v1/responses', { 'gpt-6.1-sol': 16384 }, { 'gpt-6.1-sol': 16384 });
  assert.equal(rewritten, body);

  const raised = rewriteTokenBudget(Buffer.from(JSON.stringify({ model: 'gpt-6.1-sol', max_output_tokens: 8 })), '/v1/responses', { 'gpt-6.1-sol': 16384 }, {});
  assert.equal(JSON.parse(raised.toString('utf8')).max_output_tokens, 16384);

  const notJson = Buffer.from('not json');
  assert.equal(rewriteTokenBudget(notJson, '/v1/responses', { 'gpt-6.1-sol': 16384 }, {}), notJson);
});

test('unsupported parameters are removed for the model that rejects them', () => {
  const payload = { model: 'gpt-6.1-sol', temperature: 0.7, top_p: 0.9, max_output_tokens: 16384 };
  assert.equal(applyStripParams(payload, DEFAULTS.stripParams), true);
  assert.equal(Object.hasOwn(payload, 'temperature'), false);
  assert.equal(Object.hasOwn(payload, 'top_p'), false);
  assert.equal(payload.max_output_tokens, 16384);

  const other = { model: 'other-model', temperature: 0.7 };
  assert.equal(applyStripParams(other, DEFAULTS.stripParams), false);
  assert.equal(other.temperature, 0.7);

  const global = { model: 'other-model', temperature: 0.7 };
  assert.equal(applyStripParams(global, { '*': ['temperature'] }), true);
  assert.equal(Object.hasOwn(global, 'temperature'), false);
});

test('the request rewrite applies both the strip list and the token floor', () => {
  const config = validateConfig();
  const body = Buffer.from(JSON.stringify({ model: 'gpt-6.1-sol', temperature: 0.7, max_output_tokens: 16 }));
  const rewritten = rewriteRequestBody(body, '/v1/responses', config);
  const payload = JSON.parse(rewritten.toString('utf8'));
  assert.equal(Object.hasOwn(payload, 'temperature'), false);
  assert.equal(payload.max_output_tokens, 16384);
});

test('the model catalog is the OpenAI shape the harness reads', () => {
  const catalog = buildModelCatalog(validateConfig());
  assert.equal(catalog.object, 'list');
  assert.equal(catalog.data.length, 1);
  assert.equal(catalog.data[0].id, 'gpt-6.1-sol');
  assert.equal(catalog.data[0].context_window, 262144);
  assert.equal(catalog.data[0].max_output_tokens, 16384);
});

test('the generated harness patch registers the route the harness can read', () => {
  const profile = buildDshProfile(validateConfig());
  assert.match(profile.yaml, /- id: llm-pi-ai/);
  assert.match(profile.yaml, /api: openai-responses/);
  assert.match(profile.yaml, /baseURL: http:\/\/127\.0\.0\.1:8899\/v1/);
  assert.match(profile.yaml, /apiKeyEnv: AGENTROUTER_API_KEY/);
  assert.match(profile.yaml, /contextWindow: 262144/);
  assert.match(profile.yaml, /maxTokens: 16384/);
  assert.match(profile.yaml, /- id: agent-default-model/);
  assert.match(profile.yaml, /provider: deepcoder/);
  // Every reasoning level the harness offers must be in the route.
  assert.match(profile.yaml, /reasoningEfforts:/);
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.match(profile.yaml, new RegExp(`\\n\\s+${level}: `));
  }
  assert.match(profile.yaml, /supportsStrictMode: false/);
  // Compatibility switches the Responses protocol does not read must not appear.
  assert.doesNotMatch(profile.yaml, /maxTokensField/);
  assert.doesNotMatch(profile.yaml, /thinkingFormat/);
  assert.equal(profile.path, dshPatchPath('desktop'));
});

test('a reasoning level without a value is written without a value', () => {
  const profile = buildDshProfile(validateConfig({
    models: [{ id: 'a', reasoningEfforts: { off: null, high: 'high' } }],
  }));
  assert.match(profile.yaml, /\n\s+off:\n/);
  assert.match(profile.yaml, /\n\s+high: "high"/);
});

test('a chat completions route keeps the compatibility switch that protocol reads', () => {
  const profile = buildDshProfile(validateConfig({ apiProtocol: 'openai-completions' }));
  assert.match(profile.yaml, /api: openai-completions/);
  assert.match(profile.yaml, /maxTokensField: max_tokens/);
  assert.doesNotMatch(profile.yaml, /supportsMaxOutputTokens/);
});

test('the profile route is appended once and never duplicated', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deepcoder-home-'));
  const savedHome = process.env.DSH_HOME;
  const savedProfile = process.env.DSH_PROFILE;
  process.env.DSH_HOME = home;
  delete process.env.DSH_PROFILE;
  try {
    const config = validateConfig({ dshProfile: 'desktop' });
    const file = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml');

    const first = installDshProfile(config);
    assert.equal(first.providerAction, 'appended');
    assert.equal(fs.existsSync(file), true);
    const written = fs.readFileSync(file, 'utf8');
    assert.match(written, /- id: llm-pi-ai/);
    assert.match(written, /deepcoder:/);
    assert.match(written, /api: openai-responses/);

    const second = installDshProfile(config);
    assert.equal(second.providerAction, 'updated');
    const refreshed = fs.readFileSync(file, 'utf8');
    // The route is refreshed in place, never duplicated.
    assert.equal(refreshed.match(/- id: llm-pi-ai/g).length, 1);
    assert.equal(refreshed.match(/deepcoder:/g).length, 1);
    assert.equal(refreshed, written);
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    if (savedProfile !== undefined) process.env.DSH_PROFILE = savedProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an existing profile file keeps its entries', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deepcoder-home-'));
  const savedHome = process.env.DSH_HOME;
  const savedProfile = process.env.DSH_PROFILE;
  process.env.DSH_HOME = home;
  delete process.env.DSH_PROFILE;
  try {
    const dir = path.join(home, 'profiles', 'desktop');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'cordis.patch.yml');
    fs.writeFileSync(file, '- id: ui-chat\n  name: "@deepseek-ai/dsh-ui-chat"\n  config: {}\n', 'utf8');
    const result = installDshProfile(validateConfig({ dshProfile: 'desktop' }));
    assert.equal(result.providerAction, 'appended');
    const written = fs.readFileSync(file, 'utf8');
    assert.match(written, /^- id: ui-chat/m);
    assert.match(written, /- id: llm-pi-ai/);
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    if (savedProfile !== undefined) process.env.DSH_PROFILE = savedProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an existing provider route is merged and never replaced', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deepcoder-home-'));
  const savedHome = process.env.DSH_HOME;
  const savedProfile = process.env.DSH_PROFILE;
  process.env.DSH_HOME = home;
  delete process.env.DSH_PROFILE;
  try {
    const dir = path.join(home, 'profiles', 'desktop');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'cordis.patch.yml');
    const original = [
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      '      otari:',
      '        displayName: Otari',
      '        apiKeyEnv: OTARI_API_KEY',
      '        api: openai-completions',
      '        baseURL: https://api.otari.ai/api/v1',
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      '    provider: otari',
      '    model: "some/other-model"',
      '',
    ].join('\n');
    fs.writeFileSync(file, original, 'utf8');

    const result = installDshProfile(validateConfig({ dshProfile: 'desktop' }));
    assert.equal(result.providerAction, 'merged');
    assert.equal(result.defaultModelAction, 'left-unchanged');
    const written = fs.readFileSync(file, 'utf8');
    // The other provider survives untouched.
    assert.match(written, /otari:/);
    assert.match(written, /apiKeyEnv: OTARI_API_KEY/);
    assert.match(written, /baseURL: https:\/\/api\.otari\.ai\/api\/v1/);
    // The default model of the profile is not changed.
    assert.match(written, /provider: otari/);
    assert.match(written, /model: "some\/other-model"/);
    // Exactly one route entry and one DeepCoder provider.
    assert.equal(written.match(/^- id: llm-pi-ai$/gm).length, 1);
    assert.equal(written.match(/^\s*deepcoder:$/gm).length, 1);
    assert.match(written, /^\s*deepcoder:\n\s+displayName: DeepCoder/m);
    assert.match(written, /api: openai-responses/);
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    if (savedProfile !== undefined) process.env.DSH_PROFILE = savedProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the health endpoint reports the service', async () => {
  await withServer({}, async ({ baseUrl }, done) => {
    const response = await request(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.service, 'deepcoder');
    assert.equal(payload.status, 'ok');
    assert.equal(payload.version, VERSION);
    done();
  });
});

test('the model catalog is served locally', async () => {
  await withServer({}, async ({ baseUrl }, done) => {
    const response = await request(`${baseUrl}/v1/models`);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).data[0].id, 'gpt-6.1-sol');
    done();
  });
});

test('a foreign Host header is refused', async () => {
  await withServer({}, async ({ port }, done) => {
    const response = await request(`http://127.0.0.1:${port}/health`, { headers: { host: 'example.com' } });
    assert.equal(response.status, 403);
    done();
  });
});

test('a browser origin is refused', async () => {
  await withServer({}, async ({ port }, done) => {
    const response = await request(`http://127.0.0.1:${port}/v1/models`, { headers: { origin: 'http://localhost:3000' } });
    assert.equal(response.status, 403);
    done();
  });
});

test('routes outside the API surface are not forwarded', async () => {
  await withServer({}, async ({ port }, done) => {
    const response = await request(`http://127.0.0.1:${port}/admin`);
    assert.equal(response.status, 404);
    done();
  });
});

test('a request is forwarded with the upstream identity headers', async () => {
  const upstream = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, userAgent: req.headers['user-agent'], originator: req.headers.originator }));
  });
  try {
    await withServer({ upstream: upstream.origin, headers: { 'user-agent': 'pi (test 1.0; x64)' } }, async ({ baseUrl }, done) => {
      const response = await request(`${baseUrl}/v1/responses`, { method: 'POST', body: '{}' });
      assert.equal(response.status, 200);
      const payload = JSON.parse(response.body);
      assert.equal(payload.ok, true);
      assert.equal(payload.userAgent, 'pi (test 1.0; x64)');
      assert.equal(payload.originator, 'pi');
      done();
    });
  } finally {
    upstream.server.close();
  }
});

test('the bridge adds the provider key when the client sends none', async () => {
  const upstream = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ authorization: req.headers.authorization ?? null }));
  });
  const previous = process.env.AGENTROUTER_API_KEY;
  process.env.AGENTROUTER_API_KEY = 'test-key-value';
  try {
    await withServer({ upstream: upstream.origin }, async ({ baseUrl }, done) => {
      const response = await request(`${baseUrl}/v1/responses`, { method: 'POST', body: '{}' });
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).authorization, 'Bearer test-key-value');
      done();
    });
  } finally {
    upstream.server.close();
    if (previous === undefined) delete process.env.AGENTROUTER_API_KEY;
    else process.env.AGENTROUTER_API_KEY = previous;
  }
});

test('the key of the client is never replaced', async () => {
  const upstream = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ authorization: req.headers.authorization ?? null }));
  });
  const previous = process.env.AGENTROUTER_API_KEY;
  process.env.AGENTROUTER_API_KEY = 'bridge-key-value';
  try {
    await withServer({ upstream: upstream.origin }, async ({ baseUrl }, done) => {
      const response = await request(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer client-key-value' },
        body: '{}',
      });
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).authorization, 'Bearer client-key-value');
      done();
    });
  } finally {
    upstream.server.close();
    if (previous === undefined) delete process.env.AGENTROUTER_API_KEY;
    else process.env.AGENTROUTER_API_KEY = previous;
  }
});

test('no key is added when the variable is empty or the switch is off', async () => {
  const upstream = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ authorization: req.headers.authorization ?? null }));
  });
  const previous = process.env.AGENTROUTER_API_KEY;
  delete process.env.AGENTROUTER_API_KEY;
  try {
    await withServer({ upstream: upstream.origin }, async ({ baseUrl }, done) => {
      const response = await request(`${baseUrl}/v1/responses`, { method: 'POST', body: '{}' });
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).authorization, null);
      done();
    });
    await withServer({ upstream: upstream.origin, injectApiKey: false }, async ({ baseUrl }, done) => {
      process.env.AGENTROUTER_API_KEY = 'bridge-key-value';
      const response = await request(`${baseUrl}/v1/responses`, { method: 'POST', body: '{}' });
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).authorization, null);
      done();
    });
  } finally {
    upstream.server.close();
    if (previous === undefined) delete process.env.AGENTROUTER_API_KEY;
    else process.env.AGENTROUTER_API_KEY = previous;
  }
});

test('the bridge raises the output budget and removes the rejected parameters', async () => {
  const upstream = await fakeUpstream((req, res, raw, json) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ json, length: raw.length }));
  });
  try {
    await withServer({ upstream: upstream.origin }, async ({ baseUrl }, done) => {
      const response = await request(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-6.1-sol', temperature: 0.7, max_output_tokens: 16 }),
      });
      assert.equal(response.status, 200);
      const payload = JSON.parse(response.body).json;
      assert.equal(Object.hasOwn(payload, 'temperature'), false);
      assert.equal(payload.max_output_tokens, 16384);
      done();
    });
  } finally {
    upstream.server.close();
  }
});

test('the bridge refuses a body larger than it accepts', async () => {
  const upstream = await fakeUpstream((req, res) => {
    res.writeHead(200);
    res.end();
  });
  try {
    await withServer({ upstream: upstream.origin }, async ({ baseUrl }, done) => {
      const response = await request(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-6.1-sol', padding: 'x'.repeat(9 * 1024 * 1024) }),
      });
      assert.equal(response.status, 413);
      done();
    });
  } finally {
    upstream.server.close();
  }
});

test('an upstream failure is reported as a bad gateway', async () => {
  await withServer({ upstream: 'http://127.0.0.1:1' }, async ({ baseUrl }, done) => {
    const response = await request(`${baseUrl}/v1/responses`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 502);
    done();
  });
});

test('an upstream that never answers is reported as a timeout', async () => {
  const upstream = await fakeUpstream(() => {});
  try {
    await withServer({ upstream: upstream.origin, timeoutMs: 250 }, async ({ baseUrl }, done) => {
      const response = await request(`${baseUrl}/v1/responses`, { method: 'POST', body: '{}' });
      assert.equal(response.status, 504);
      done();
    });
  } finally {
    upstream.server.closeAllConnections();
    upstream.server.close();
  }
});

test('the profile of the running harness wins over the configuration', () => {
  const saved = process.env.DSH_PROFILE;
  process.env.DSH_PROFILE = 'work';
  try {
    assert.equal(detectDshProfile('desktop').profile, 'work');
  } finally {
    if (saved === undefined) delete process.env.DSH_PROFILE;
    else process.env.DSH_PROFILE = saved;
  }
});

test('the only profile on the machine is used when nothing else fits', () => {
  const saved = process.env.DSH_PROFILE;
  const savedHome = process.env.DSH_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deepcoder-home-'));
  fs.mkdirSync(path.join(home, 'profiles', 'solo'), { recursive: true });
  delete process.env.DSH_PROFILE;
  process.env.DSH_HOME = home;
  try {
    assert.equal(detectDshProfile('desktop').profile, 'solo');
  } finally {
    if (saved === undefined) delete process.env.DSH_PROFILE;
    else process.env.DSH_PROFILE = saved;
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a busy port is detected and another one is found', async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const busy = server.address().port;
  try {
    assert.equal(await isPortFree(busy), false);
    const free = await findFreePort(busy);
    assert.ok(free && free !== busy);
    assert.equal(await isPortFree(free), true);
  } finally {
    server.close();
  }
});

test('the configuration is written back and the example is copied when it is missing', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'deepcoder-config-'));
  const target = path.join(folder, 'deepcoder-config.json');
  const saved = process.env.DEEPCODER_CONFIG;
  process.env.DEEPCODER_CONFIG = target;
  try {
    const ensured = ensureConfigFile();
    assert.equal(ensured.created, true);
    assert.equal(ensured.path, target);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(parsed.models[0].id, 'gpt-6.1-sol');
    assert.equal(ensureConfigFile().created, false);

    const saved2 = saveConfig(target, { ...validateConfig(), port: 9001 });
    assert.equal(saved2, target);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).port, 9001);
  } finally {
    if (saved === undefined) delete process.env.DEEPCODER_CONFIG;
    else process.env.DEEPCODER_CONFIG = saved;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('the self test checks the bridge, the model list and the key', async () => {
  // A variable that is set nowhere, so the provider check is skipped.
  const envName = 'DEEPCODER_NO_KEY_IN_THE_ENVIRONMENT';
  const saved = process.env[envName];
  delete process.env[envName];
  try {
    await withServer({}, async ({ port }, done) => {
      const config = validateConfig({ port, apiKeyEnv: envName });
      const checks = await selfTest(config);
      assert.equal(checks[0].ok, true);
      assert.equal(checks[1].ok, true);
      assert.equal(checks[2].ok, null, 'the provider is skipped without a key');
      done();
    });
  } finally {
    if (saved !== undefined) process.env[envName] = saved;
  }
});

test('a key is masked before it is shown', () => {
  assert.equal(maskKey('sk-EXAMPLE-KEY-0123456789abcdef'), 'sk-EXAM...cdef');
  assert.equal(maskKey(''), '(empty)');
  assert.equal(maskKey('short'), 'sho...');
  assert.equal(maskKey('123456789012'), '123...');
});

test('a variable that is not set is empty', () => {
  assert.equal(readUserEnvValue('DEEPCODER_NO_SUCH_VARIABLE_9F3A'), '');
});

test('the key of the process is used before the registry is asked', () => {
  process.env.DEEPCODER_KEY_OF_THE_PROCESS = 'value-of-the-process';
  try {
    assert.equal(ensureKeyInEnvironment({ apiKeyEnv: 'DEEPCODER_KEY_OF_THE_PROCESS' }), 'value-of-the-process');
  } finally {
    delete process.env.DEEPCODER_KEY_OF_THE_PROCESS;
  }
});

function runSetKey(input, envName) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'deepcoder-key-'));
  const configPath = path.join(folder, 'deepcoder-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ apiKeyEnv: envName, port: 8902 }), 'utf8');
  const result = require('node:child_process').spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'deepcoder.cjs'), '--set-key'],
    {
      input,
      encoding: 'utf8',
      env: { ...process.env, DEEPCODER_CONFIG: configPath },
      timeout: 30000,
    },
  );
  fs.rmSync(folder, { recursive: true, force: true });
  return result;
}

test('a value that does not look like a key is refused', () => {
  const envName = 'DEEPCODER_TEST_KEY_REFUSED';
  const result = runSetKey('not a key\n', envName);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /does not look like a key/);
  assert.equal(readUserEnvValue(envName), '', 'nothing was written to the environment');
});

test('an empty input leaves the environment alone', () => {
  const envName = 'DEEPCODER_TEST_KEY_EMPTY';
  const result = runSetKey('\n', envName);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /No key was entered/);
  assert.equal(readUserEnvValue(envName), '', 'nothing was written to the environment');
});

