# Contributing to DeepCoder

Thanks for helping out. DeepCoder is deliberately small, so the bar for a change
is mostly about being careful, not about being clever.

## Before you start

- **Open an issue first** for anything larger than a bug fix. A short discussion
  is cheaper than a large pull request that has to be rewritten.
- **Do not include keys, tokens or real conversation payloads** in an issue, a
  pull request, a test or a log. The test suite uses the placeholder
  `sk-EXAMPLE-KEY-0123456789abcdef`.

## Development

```bash
npm install
npm test
npm run lint
npm run verify      # lint + tests + manifest + checksum check
```

Requirements: Node.js 22 or newer (Windows for the autostart helpers, any
platform for the bridge itself). There are no runtime dependencies; the dev
dependencies are only used for the tests and the linter.

## Commit credits

Every commit carries a
`Co-authored-by: MiniMax-AI-Dev <192945411+MiniMax-AI-Dev@users.noreply.github.com>`
trailer, so the agent that wrote the code is credited next to the human who
owns it, and GitHub links the account in the contributors list. The trailer
comes from the tracked hook in `.githooks/commit-msg`. Turn it on in a fresh
clone with:

```bash
git config core.hooksPath .githooks
```

The hook never touches a merge or squash commit, replaces an older MiniMax
trailer instead of adding a second one, and leaves every other co-author
alone.

Commit your own work with an address GitHub can link to your account, for
example the verified form `160837614+JV-1054@users.noreply.github.com`.
Without a linked address the commit still shows up, but the account stays out
of the contributors list.

## Rules the code follows

These are the properties that make DeepCoder trustworthy. A change that breaks
one of them needs a very good reason and a test that proves the new behaviour.

1. **Loopback only.** The server binds `127.0.0.1` and refuses a `Host` header
   that does not match the local port.
2. **No browser access.** Every request with an `Origin` header is refused.
3. **Only `/v1` is forwarded.**
4. **The key is never stored or logged.** It is read from the environment (or the
   registry) and used for one request.
5. **A key sent by the client is never replaced.**
6. **The configuration is validated with an allowlist.** An unknown key is an
   error, not a silent no-op.
7. **No process is ever killed.** A busy port is reported, never taken.
8. **The harness profile is merged, never rewritten.** Other providers and the
   existing default model stay untouched.

## Style

- Plain CommonJS, no build step, no transpiler, no framework.
- The bridge stays in a single file (`deepcoder.cjs`) on purpose: it has to be
  readable, copyable and auditable without a toolchain.
- Comments explain *why*, not *what*.
- Every new behaviour comes with a test in `deepcoder.test.cjs`.

## Pull requests

1. Branch off `main`.
2. Make the change, add the tests, run `npm run verify`.
3. Describe what changes for the user, not only what changed in the code.
4. Update `README.md` and `docs/DSH-SETUP.md` when you change the behaviour, the
   configuration or the commands.

## Reporting a security issue

Please do not open a public issue. See [SECURITY.md](SECURITY.md).
