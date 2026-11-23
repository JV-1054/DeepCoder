# Changelog

All notable changes to DeepCoder are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.3] - 2026-11-22

The bridge now speaks as pi.

### Changed

- **The client identity is now `pi (<platform> <release>; <arch>)`**, computed at
  runtime from the running system, and the `originator` header names `pi` as
  well. `pi-ai` is the LLM client inside the harness, so this is the identity the
  request would have carried if the harness did not replace it with its own
  attribution. The previous default, `codex_cli_rs/0.104.0`, also works — the
  provider accepts both — but it claimed to be a different product and carried a
  version number copied out of someone else's release.
  Measured on 2026-11-22 against `agentrouter.org` with `gpt-6.1-sol`:
  `pi (win32 10.0.26300; x64)` with `originator: pi` → `200 completed`; the
  harness attribution → `401 unauthorized client detected`.
- The configuration only has to name the client now: a configuration without a
  `user-agent` entry inherits the computed one. The example configuration shows
  `"headers": { "originator": "pi" }`.
- `tools/probe-upstream.cjs` sends the `originator` header as well and compares
  five identities: the one DeepCoder sends, the harness attribution, the
  attribution plus `DSH_USER_AGENT_SUFFIX`, the pi-ai default and the Codex
  client identity.
- The README explains why the identity is `pi`, and the troubleshooting entry in
  `docs/DSH-SETUP.md` was updated.

### Added

- Two new tests cover the computed identity (80 tests instead of 78).

## [1.0.2] - 2026-11-21

One command that says what is wrong.

### Added

- **`node deepcoder.cjs --doctor`** checks the whole chain in one run and names
  what is missing: the Node version, the configuration, the provider key (shown
  as a hint, never in full), the harness route and the port it points at, the
  default model of the profile, the bridge, the port, the autostarts and the
  provider itself. Every check prints `PASS`, `WARN`, `FAIL` or `SKIP`, a
  failure names the command that fixes it, and the exit code is `1` when
  something failed, so the doctor can be used in a script.
- **`node deepcoder.cjs --doctor --json`** prints the same report as a document.
- `npm run doctor` runs it from the package.
- Thirteen new tests cover the doctor helpers (78 tests instead of 65).

### Changed

- The README gained a section about the doctor, the troubleshooting table points
  at it, and the `package.json` author now uses the account address that
  GitHub links to the owner.

## [1.0.1] - 2026-11-21

The proof that a gateway is needed, shipped with the tool that produces it.

### Added

- **`tools/probe-upstream.cjs`** sends the same small request with every client
  identity that matters — the one the bridge sends, the harness attribution, the
  harness attribution with `DSH_USER_AGENT_SUFFIX` and the pi-ai default — and
  prints what the provider answers for each. The key is never printed.
- **README section "Why not just a harness route?"** with the source references
  (`attributionHeaders()` in `@deepseek-ai/dsh-llm`, the adapter that writes the
  attribution headers last) and the measured answers from the provider.

### Changed

- The test suite now runs every file in `test/` and covers the probe helpers
  (65 tests instead of 57).

### Fixed

- The test script uses the glob `test/*.test.cjs` instead of a directory. Node 22
  — the version the CI runs on — does not accept a directory as a test argument
  and answered `Cannot find module '…/test'`.

## [1.0.0] - 2026-11-21

The first public release.

### Added

- **Loopback gateway** between the DeepSeek Harness and an OpenAI-compatible
  upstream: binds `127.0.0.1` only, checks the `Host` header, refuses every
  request with an `Origin` header and forwards only `/v1` routes.
- **Client identity** (`codex_cli_rs/<version>` by default) so providers that
  fingerprint their clients accept the request.
- **Output token floors** per model, with the budget clamped to the model limit,
  so the provider does not answer `incomplete`.
- **Parameter stripping** per model (`temperature`, `top_p`, `frequency_penalty`
  for `gpt-6.1-sol`), including a `"*"` wildcard.
- **Key handling**: the key is read from the environment or from the Windows
  registry, is never logged, never written to disk by the bridge and never put
  on a command line. A key sent by the client is never replaced.
- **`--set-key`** reads the key from the standard input with the echo off and
  stores it in the user environment.
- **Harness integration**: writes a route into the harness profile, merged into
  the existing `llm-pi-ai` entry so other providers and the current default
  model stay untouched. Supports `openai-completions` and `openai-responses`.
- **Reasoning levels** (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
  `max`) are declared in the route and mapped onto the provider's effort names.
- **Native tool calls** are forwarded unchanged and verified end to end,
  including the tool-result round trip.
- **Local model catalog**: `GET /v1/models` is answered by the bridge itself.
- **`--setup`**: one command for configuration, harness route, autostart, hidden
  start and a self test that prints `PASS` / `FAIL` for every step.
- **Windows autostart**: a Startup folder entry for every sign-in and an
  optional scheduled task (`DeepCoder`) for every boot, both without a console
  window.
- **Release tooling**: `release-manifest.json` with a SHA-256 checksum per file,
  a verification script, and a GitHub Actions workflow that attaches
  `DeepCoder-v<version>.zip` to a release.

### Security

- Loopback bind, `Host` check, `Origin` refusal, `/v1` only.
- `Authorization`, `Cookie` and the other credential headers cannot be
  overridden by the configuration.
- Bodies larger than 8 MiB are refused instead of being buffered.
- The upstream must be an HTTPS origin (plain HTTP only for a loopback upstream).
- Another process is never killed to take a port.
