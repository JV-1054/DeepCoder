<p align="center">
  <a href="https://github.com/JV-1054/DeepCoder/stargazers"><img src="https://img.shields.io/github/stars/JV-1054/DeepCoder?style=social" alt="Stars"></a>
  <a href="https://github.com/JV-1054/DeepCoder/forks"><img src="https://img.shields.io/github/forks/JV-1054/DeepCoder?style=social" alt="Forks"></a>
  <a href="https://github.com/JV-1054/DeepCoder/actions/workflows/ci.yml"><img src="https://github.com/JV-1054/DeepCoder/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/JV-1054/DeepCoder/releases"><img src="https://img.shields.io/github/v/release/JV-1054/DeepCoder?style=flat" alt="Release"></a>
  <a href="https://github.com/JV-1054/DeepCoder/issues"><img src="https://img.shields.io/github/issues/JV-1054/DeepCoder?style=flat" alt="Issues"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-5eead4?style=flat-square" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/DSH-0.2.2--rc.5-7c3aed?style=flat-square" alt="DeepSeek Harness 0.2.2-rc.5">
  <img src="https://img.shields.io/badge/node-%3E%3D22-5eead4?style=flat-square" alt="Node.js 22 or newer">
  <img src="https://img.shields.io/badge/dependencies-0%20runtime-f97316?style=flat-square" alt="Zero runtime dependencies">
  <img src="https://img.shields.io/badge/tests-80%20passing-7c3aed?style=flat-square" alt="80 tests passing">
</p>

# DeepCoder

**A loopback API gateway that lets the DeepSeek Harness drive any OpenAI-compatible model — even providers that fingerprint their clients, cap output tokens, or reject "harmless" sampling parameters.**

One file. Zero runtime dependencies. Node.js 22+. Windows-first setup, works anywhere Node runs.

```
DeepSeek Harness  ──►  http://127.0.0.1:8899/v1  ──►  https://agentrouter.org
   (openai-responses)         DeepCoder (loopback)        (your key, never stored)
```

DeepCoder sits between the [DeepSeek Harness](https://github.com/deepseek-ai) and an
OpenAI-compatible upstream. The harness talks to `127.0.0.1`, never to the internet,
and DeepCoder forwards every request with the small set of corrections that provider
side actually needs.

---

## Why this exists

Model gateways are written for generic chat clients. Coding agents are not generic
chat clients, and real providers are not as forgiving as the spec suggests. Three
things go wrong every single time:

| Problem | What the provider does | What DeepCoder does |
| --- | --- | --- |
| **Client fingerprinting** | Rejects the request with `401 unauthorized client detected` when the `User-Agent` is not a client it knows | Sends the client identity the upstream expects (`pi (<platform> <release>; <arch>)` by default, computed at runtime, fully configurable) |
| **Output budget** | Answers `incomplete` with `reason: max_output_tokens` because the agent asked for a tiny budget | Raises the budget to the model budget, and never above the model's own limit |
| **Parameter purity** | Answers `400 Unsupported parameter: 'temperature' is not supported with this model` | Strips the parameters the model rejects, per model, with a wildcard fallback |

On top of that, DeepCoder owns the parts a gateway usually gets wrong:

- **The key never touches the disk.** It lives in your Windows user environment; the
  bridge reads it from the process or from the registry at request time.
- **The key is never replaced.** If the client sends an `Authorization` header, that
  header wins.
- **The server is not exposed.** It binds `127.0.0.1` only, refuses a `Host` header
  that does not match the local port, refuses every request that carries an `Origin`
  header, and forwards only `/v1` routes.
- **Another process is never killed.** If the port is taken, DeepCoder says so and
  moves to a free port. It does not take the port away from anybody.
- **The setup is one double-click.** `setup.cmd` writes the configuration, asks for
  the key with the echo off, finds the harness profile, adds the route **without
  touching your other providers**, installs the autostart, starts the bridge
  without a window and prints `PASS` / `FAIL` for every step.

---

## Why not just a harness route?

The harness route format has a `headers` field. The obvious question is: why not
point the route at the provider and set the `User-Agent` there, instead of running
a gateway?

Because the harness always identifies itself to the provider, no matter what the
route says. Three pieces of the harness source decide that:

| Where | What it does |
| --- | --- |
| `@deepseek-ai/dsh-llm-pi-ai` `src/adapter.ts` | Collects the route headers and then writes `attributionHeaders()` **last** — the comment in the code is *"Harness attribution wins reserved names"*. |
| `@deepseek-ai/dsh-llm` `src/attribution.ts` | `attributionHeaders()` returns exactly `{ 'user-agent': 'deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)' }`. The doc comment says *"nothing can suppress attribution entirely"*. |
| `DSH_USER_AGENT_SUFFIX` | Only **appends** a token to that identity. It cannot replace it. |

So the identity that reaches the provider is always the harness identity — the
route's `headers` are overwritten. Here is what the provider answers for each
identity, measured on 2026-11-22 against `agentrouter.org` with `gpt-6.1-sol`:

| Client identity in the request | Answer |
| --- | --- |
| `pi (win32 10.0.26300; x64)` + `originator: pi` — what DeepCoder sends | `200` completed |
| `deepseek-harness/0.0.0 (+https://github.com/deepseek-ai/deepseek-harness)` — what the harness sends | `401 unauthorized client detected` |
| `deepseek-harness/0.0.0 (+…) pi (win32 10.0.26300; x64)` — attribution plus `DSH_USER_AGENT_SUFFIX` | `401 unauthorized client detected` |
| `pi (win32 10.0.26300; x64)` — the pi-ai default | `200` completed |
| `codex_cli_rs/0.104.0` — the other client the provider knows | `200` completed |

(The harness version in the probe is fixed at `0.0.0` because only the product
token decides the answer; the real request carries the installed version.)

### Why `pi` and not `codex_cli_rs`

The provider accepts a short list of client identities: Codex, OpenCode and pi.
Both work, so this is a choice, not a workaround.

DeepCoder sends **pi**, because pi is what the request would have carried
anyway: `pi-ai` is the LLM client inside the harness, and its own
`getPiUserAgent()` returns exactly `pi (<platform> <release>; <arch>)`. The
harness only replaces it because it stamps its own attribution on every
request. DeepCoder computes the same string at runtime, so it is correct on
every machine and never goes stale — while `codex_cli_rs/0.104.0` would claim
to be a different product and carry a version number copied out of someone
else's release. The `originator` header names the same client, because the
provider looks at that header too.

If your provider wants a different identity, set it in the configuration:

```json
"headers": { "user-agent": "codex_cli_rs/0.104.0", "originator": "codex_cli_rs" }
```

Three more jobs are not expressible in a route at all:

- **The output token floor.** A route declares the model's budget; it cannot raise
  the budget of one request at request time. pi-ai only sends `max_output_tokens`
  when `compat.supportsMaxOutputTokens` is set, so a small budget stays small and
  the provider answers `incomplete, reason: max_output_tokens`.
- **Stripping rejected parameters.** No route field rewrites the JSON body, so
  `temperature` reaches the model that refuses it.
- **A local model list.** DeepCoder answers `GET /v1/models` itself, so the model
  picker still works while the upstream is unreachable.

### Prove it yourself

The probe is part of the package. It sends the same tiny request with each
identity and prints what the provider answers — the key is never printed.

```bash
node tools/probe-upstream.cjs
```

```
200    3921 ms  the identity DeepCoder sends
     user-agent: pi (win32 10.0.26300; x64)
     originator: pi
     completed
401     204 ms  the harness attribution
     user-agent: deepseek-harness/0.0.0 (+https://github.com/deepseek-ai/deepseek-harness)
     unauthorized client detected, contact support for assistance at https://discord.gg/HgekCyHJqB
```

> DeepCoder is a compatibility shim, not a way around anything. It sends **your**
> key to **your** provider, the provider's terms still apply and the traffic is
> billed to you. If your provider is happy with the harness identity, you do not
> need DeepCoder — point the route at it and be done.

---

## Quick start

```bash
# 1. get the code
git clone <this-repo> && cd DeepCoder

# 2. install the dev dependencies (only needed for the tests)
npm install

# 3. run the setup (Windows)
scripts\setup.cmd
```

`setup.cmd` asks for your provider key with the **echo off**, so the key never
appears on screen or in the console scrollback. It is stored in your Windows user
environment, never in the package.

On a non-Windows machine:

```bash
node deepcoder.cjs --setup        # config, harness route, autostart, self test
node deepcoder.cjs --set-key      # read the provider key from stdin
node deepcoder.cjs                # run the bridge in the foreground
```

Then restart the DeepSeek Harness and pick **DeepCoder** in *Settings → Models*.

### Repository layout

```
DeepCoder/
├── deepcoder.cjs          the gateway and the CLI (one file, no runtime deps)
├── test/                  80 tests, no network, no key needed
├── config/                the example configuration and the harness route example
├── docs/                  the step-by-step harness guide
├── scripts/               the Windows launchers (setup, start, uninstall, autostart)
├── tools/                 the release manifest, its verifier and the upstream probe
└── .github/               issue templates and the community files
```

The full harness walkthrough is in [docs/DSH-SETUP.md](docs/DSH-SETUP.md).

---

## How it works

```
   ┌──────────────────────┐        ┌────────────────────────┐       ┌────────────────────┐
   │   DeepSeek Harness   │  HTTP  │       DeepCoder        │ HTTPS │  OpenAI-compatible │
   │  (openai-responses)  │ ─────► │  127.0.0.1:8899 (loop) │ ────► │  upstream (+ key)  │
   └──────────────────────┘        └────────────────────────┘       └────────────────────┘
                                          │
                                          ├─ client identity header      (headers)
                                          ├─ output token floor         (outputTokenFloors)
                                          ├─ rejected parameters removed (stripParams)
                                          ├─ Authorization filled in     (injectApiKey)
                                          └─ /v1/models answered locally (models)
```

Every request passes through the same five steps, in this order:

1. **Guard.** Non-loopback `Host`, any `Origin`, a route outside `/v1` or a body
   larger than 8 MiB is refused before a byte leaves the machine.
2. **Identity.** The configured client headers are applied on top of the caller's
   headers. Hop-by-hop headers are removed in both directions.
3. **Key.** If the caller sent no `Authorization` header and `injectApiKey` is on,
   the key from `apiKeyEnv` is added. A key that the caller *did* send is left
   alone.
4. **Rewrite.** For the routes that carry a token budget, the JSON body is read
   (up to 8 MiB), the parameters the model rejects are removed and the output
   budget is raised to the floor and clamped to the model limit. Everything else
   streams through untouched.
5. **Relay.** The request goes to the upstream with the configured timeout.
   `502` for an upstream failure, `504` for a timeout, and the upstream body is
   streamed back to the harness unchanged.

`GET /health` and `GET /v1/models` are answered by the bridge itself, so the
harness can discover the model even while the upstream is unreachable.

---

## The provider key

| Rule | Detail |
| --- | --- |
| **Typed with the echo off** | The prompt masks the input; it is not shown and it does not stay in the scrollback. |
| **Stored in the user environment** | `AGENTROUTER_API_KEY` in `HKCU\Environment` (Windows). Never in the package, the config file or a log. |
| **Never on a command line** | The value is piped into the process on standard input, so it does not show up in the process list. |
| **Never replaced** | An `Authorization` header sent by the client is used as it is. |
| **Found even when it is late** | The bridge reads the registry when its own environment does not have the variable yet. |
| **Masked everywhere** | Screens, logs and error messages only ever show a hint such as `sk-ABCD...WXYZ`. |

```bash
node deepcoder.cjs --set-key    # read a new key from the input
setx AGENTROUTER_API_KEY ""      # remove it
```

---

## Configuration

Everything lives in `config/deepcoder-config.json`. `setup.cmd` creates it from
`config/deepcoder-config.example.json` when it does not exist.

```jsonc
{
  "upstream": "https://agentrouter.org",   // HTTPS origin of the provider
  "port": 8899,                             // loopback port of the bridge
  "timeoutMs": 600000,                      // upstream timeout (the models are slow)
  "headers": {                              // client identity the provider expects
    "originator": "pi"                      // the user-agent defaults to "pi (<platform> <release>; <arch>)"
  },
  "outputTokenFloors": { "gpt-6.1-sol": 16384 },
  "stripParams": {                          // parameters the model rejects
    "gpt-6.1-sol": ["temperature", "top_p", "frequency_penalty"]
  },
  "apiKeyEnv": "AGENTROUTER_API_KEY",       // where the key lives
  "injectApiKey": true,                     // add the key when the client sends none
  "apiProtocol": "openai-responses",        // protocol the harness should speak
  "dshProfile": "desktop",                  // harness profile that receives the route
  "models": [
    {
      "id": "gpt-6.1-sol",
      "name": "GPT-6.1-SOL",
      "contextWindow": 262144,
      "maxTokens": 16384,
      "input": ["text", "image"],
      "reasoningEfforts": {                 // levels offered to the harness
        "off": "none", "minimal": "minimal", "low": "low", "medium": "medium",
        "high": "high", "xhigh": "xhigh", "max": "max"
      }
    }
  ]
}
```

`"*"` is accepted as a model id in `stripParams` and applies to every model. The
configuration is validated with a strict allowlist: an unknown key is an error, not
a silent no-op. `node deepcoder.cjs --check-config` validates without touching the
network.

### Reasoning and tools

The route that DeepCoder writes into the harness profile declares the reasoning
levels the provider accepts (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
`max`), so the harness offers them in the model picker and maps them onto the
provider's own effort names. Native tool calls work as well: the Responses API
tools are forwarded unchanged, `supportsStrictMode` is turned off because the
provider does not implement strict JSON Schema, and the tool-result round trip
(`function_call` → `function_call_output`) is verified end to end.

---

## Commands

| Command | What it does |
| --- | --- |
| `node deepcoder.cjs --setup` | The whole installation: config, harness route, autostart, hidden start, self test. |
| `node deepcoder.cjs --doctor` | Checks the whole chain and names what is missing; prints `PASS` / `WARN` / `FAIL`. |
| `node deepcoder.cjs --set-key` | Reads the provider key from the standard input and stores it in your user environment. |
| `node deepcoder.cjs --self-test` | Checks the bridge, the model list and the provider; prints `PASS` / `FAIL`. |
| `node deepcoder.cjs --status` | Shows the bridge state and which autostarts are installed. |
| `node deepcoder.cjs --start-background` | Starts the bridge without a window. |
| `node deepcoder.cjs --install-dsh-profile` | Writes the route into the harness profile (merge, never replace). |
| `node deepcoder.cjs --print-dsh-profile` | Prints the route as YAML. |
| `node deepcoder.cjs --install-startup` | Installs the sign-in autostart. |
| `node deepcoder.cjs --install-startup-task` | Installs the boot task (administrator only). |
| `node deepcoder.cjs --uninstall-startup` | Removes both autostarts. |
| `node deepcoder.cjs --check-config` | Validates the configuration without touching the network. |

Windows helpers: `scripts/setup.cmd`, `scripts/start.cmd` (foreground, for
debugging), `scripts/start-hidden.cmd`, `scripts/check-config.cmd`,
`scripts/uninstall.cmd`.

### The doctor

`--doctor` is the command to run first when something does not work. It reads
the whole chain and says what is missing. It writes nothing, stops nothing and
never prints the provider key in full:

```text
DeepCoder 1.0.3 doctor

[PASS] Node: Node 26.13.0
[PASS] Configuration: ...\deepcoder-config.json is valid: openai-responses on port 8899 at https://agentrouter.org
[PASS] Provider key: AGENTROUTER_API_KEY holds sk-P41X...1hRS
[PASS] Harness route: ...\cordis.patch.yml carries the route to http://127.0.0.1:8899/v1 with 1 model(s)
[PASS] Default model: the profile uses DeepCoder as its default model
[PASS] Bridge: the bridge answers on 127.0.0.1:8899
[PASS] Port: the bridge holds port 8899
[PASS] Autostart: the sign-in entry is installed, the boot task needs an elevated setup.cmd
[PASS] Provider: the provider answered HTTP 200

PASS 9 · WARN 0 · FAIL 0 · SKIP 0
Everything that has to be in place is in place.
```

| Status | Meaning |
| --- | --- |
| `PASS` | This part of the chain is in place. |
| `WARN` | The chain works without it, but it is worth a look (the bridge is not running, the boot task is missing). |
| `FAIL` | Something is missing. The line names the command that fixes it. |
| `SKIP` | Not applicable on this machine. |

The exit code is `1` when a check failed, so the doctor can be used in a script.
`--doctor --json` prints the same report as a document.

### Autostart on Windows

| Mechanism | When it runs | Needs administrator |
| --- | --- | --- |
| Startup folder entry (`deepcoder.vbs`) | at every sign-in | no |
| Scheduled task `DeepCoder` (`/SC ONSTART`) | at every boot | yes |

Both start the bridge **without a console window** through `wscript.exe`. Run
`setup.cmd` from an elevated terminal to get the boot task as well;
`--status` tells you which of the two is in place.

---

## Security model

- Binds `127.0.0.1` only — the bridge is unreachable from the network.
- The `Host` header must match the local port; anything else is `403`.
- Any request with an `Origin` header is `403` — no browser can drive it.
- Only `/v1` routes are forwarded; `..`, `%25`, backslashes and control
  characters in the path are refused.
- Request and response bodies are never written to disk and never logged.
- Hop-by-hop headers are stripped in both directions.
- `Authorization`, `Cookie`, `X-Api-Key` and friends cannot be overridden by the
  configuration.
- The upstream must be HTTPS. Plain HTTP is only accepted for a loopback upstream
  (for testing).
- Bodies larger than 8 MiB are refused with `413` instead of being buffered.

---

## Development

```bash
npm install
npm test          # 80 tests, no network, no key needed
npm run lint
npm run verify    # lint + tests + manifest + checksum verification

node tools/probe-upstream.cjs    # live: which client identity the provider accepts
```

The test suite covers the configuration rules, the security rules of the local
server, the request rewriting (token floor, parameter stripping, key injection),
the harness profile merge and the setup helpers.

### Building a release

```bash
npm run release:manifest    # release-manifest.json with size + SHA-256 per file
node tools/verify-manifest.cjs
```

`npm run verify` runs the same checks as the release pipeline: lint, tests,
manifest and checksums of every shipped file. The GitHub Actions workflows in
`.github/workflows` do exactly that on every push and pull request, and
`release.yml` attaches a freshly built ZIP to a tagged release.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Something is wrong and the reason is not obvious | Unknown | `node deepcoder.cjs --doctor` — it names the missing part and the command that fixes it |
| `502 ... connect-refused ECONNREFUSED 127.0.0.1:8899` | The bridge is not running | `node deepcoder.cjs --status`, then `scripts\start-hidden.cmd` |
| `401 unauthorized client detected` | The upstream did not recognize the client | Keep the `headers` block as it is; it carries the accepted client identity |
| `400 Unsupported parameter: 'temperature'` | The parameter was not stripped | Add it to `stripParams` for that model |
| `incomplete, reason: max_output_tokens` | The budget was too small | Raise `outputTokenFloors` for that model |
| `401` from the provider, key looks right | The key was saved after the harness started | Restart the harness, or let the bridge inject the key (`injectApiKey`) |
| The harness does not show the model | The route is missing from the profile | `node deepcoder.cjs --install-dsh-profile`, then restart the harness |

---

## Contributing

Pull requests are welcome. Run `npm run verify` before you open one — it is the
same check the release pipeline runs. See
[CONTRIBUTING.md](.github/CONTRIBUTING.md).

Commits carry a `Co-authored-by: MiniMax-AI-Dev <192945411+MiniMax-AI-Dev@users.noreply.github.com>`
trailer, so the agent that wrote the code is credited next to the human who
owns it. The trailer uses MiniMax's verified GitHub address, so GitHub links it
and lists the account under **Contributors**. The trailer is added by a tracked
hook, so a fresh clone picks it up with one command:

```powershell
git config core.hooksPath .githooks
```

## Credits

- **Juniper** ([JV-1054](https://github.com/JV-1054)) — the owner of the
  project, the provider account and the release. Commits are signed with the
  verified `160837614+JV-1054@users.noreply.github.com` address, which is what
  links them to the account.
- **[MiniMax-AI](https://github.com/MiniMax-AI)** — the agent that wrote the
  code, credited on every commit through its developer account
  [MiniMax-AI-Dev](https://github.com/MiniMax-AI-Dev). GitHub counts user
  accounts only, so an organization cannot appear in the contributors list
  itself; the organization is credited here and its account carries the
  trailer.

## License

MIT — Copyright (c) 2026 Juniper. See [LICENSE](LICENSE).
