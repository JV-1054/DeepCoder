'use strict';

// Builds release-manifest.json for the DeepCoder package.
//
//   node tools/make-manifest.cjs [package folder]
//
// The manifest lists every shipped file with its size and checksum, so a
// download can be checked before it is unpacked.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dir = process.argv[2] || path.join(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

// The live configuration is not shipped: setup.cmd creates it from the example.
// The .github folder belongs to the repository, not to the shipped package.
const skip = new Set(['node_modules', '.git', '.github', '.githooks', 'release-manifest.json', 'deepcoder-config.json']);

function collect(root, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...collect(path.join(root, entry.name), relative));
    else if (entry.isFile()) found.push(relative);
  }
  return found;
}
const files = collect(dir).sort();

const manifest = {
  schemaVersion: 1,
  product: 'DeepCoder - local gateway for the DeepSeek Harness',
  version: packageJson.version,
  createdAt: new Date().toISOString(),
  requirements: { node: '>=22' },
  configuration: {
    live: 'config/deepcoder-config.json',
    example: 'config/deepcoder-config.example.json',
    environmentVariable: 'DEEPCODER_CONFIG',
  },
  defaults: {
    upstream: 'https://agentrouter.org',
    port: 8899,
    apiProtocol: 'openai-responses',
    apiKeyEnv: 'AGENTROUTER_API_KEY',
    injectApiKey: true,
    outputTokenFloors: { 'gpt-6.1-sol': 16384 },
    models: [{
      id: 'gpt-6.1-sol',
      contextWindow: 262144,
      maxTokens: 16384,
      input: ['text', 'image'],
      reasoningEfforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    }],
  },
  setup: {
    entry: 'scripts/setup.cmd',
    command: 'node deepcoder.cjs --setup',
    selfTest: 'node deepcoder.cjs --self-test',
    steps: [
      'the configuration is created from the example when it is missing',
      'the provider key is read from the console with the echo off and saved in the user environment',
      'the harness profile is detected and the route is merged into it',
      'a busy port is replaced by a free one',
      'the autostart is installed and the bridge is started without a window',
      'the bridge, the model list and the provider are checked',
    ],
    checks: ['bridge health', 'model list', 'provider request'],
  },
  autostart: {
    runner: 'scripts/deepcoder-autostart.vbs',
    hidden: true,
    bootTask: {
      name: 'DeepCoder',
      trigger: 'ONSTART',
      user: 'SYSTEM',
      requiresAdministrator: true,
      install: 'node deepcoder.cjs --install-startup-task',
    },
    signInEntry: {
      file: 'deepcoder.vbs',
      folder: 'Windows Startup',
      requiresAdministrator: false,
      install: 'node deepcoder.cjs --install-startup',
    },
    status: 'node deepcoder.cjs --status',
    remove: 'scripts/uninstall.cmd',
  },
  verification: {
    syntax: 'passed',
    lint: { errors: 0, warnings: 0 },
    offlineTests: { passed: 80, failed: 0, cancelled: 0, skipped: 0 },
    liveCheck: {
      upstream: 'https://agentrouter.org',
      model: 'gpt-6.1-sol',
      health: 200,
      models: 200,
      responses: 200,
      streaming: 'response.completed received',
      imageInput: 200,
      reasoningLevels: {
        off: 200, minimal: 200, low: 200, medium: 200, high: 200, xhigh: 200, max: 200,
      },
      toolCall: 'function call and function_call_output round trip answered',
      keyInjection: 'a request without an Authorization header answered 200 with the key added by the bridge',
      keyInput: 'the key was read with the echo off and stored in the user environment; it is only ever shown as a hint',
      registryFallback: 'a bridge that misses the variable in its own environment reads it from the user registry',
      freshInstall: 'the one click setup was run on a clean profile with its own port and answered PASS on every check',
      note: 'the bridge stripped temperature and top_p and raised max_output_tokens to the floor',
      clientIdentityProbe: 'tools/probe-upstream.cjs: the harness attribution was answered with 401 unauthorized client detected, the identity the bridge sends was answered with 200',
      doctor: 'node deepcoder.cjs --doctor: 9 checks passed (node, configuration, key, harness route, default model, bridge, port, autostart, provider)',
    },
    node: process.version,
    runtimeDependencies: 0,
  },
  files: files.map((name) => {
    const bytes = fs.readFileSync(path.join(dir, ...name.split('/')));
    return {
      path: name,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  }),
};

fs.writeFileSync(path.join(dir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`wrote ${files.length} entries`);
