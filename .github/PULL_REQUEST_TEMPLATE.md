## What this changes

<!-- One or two sentences, written for the user of the tool, not for the
     maintainer of the source. -->

## Why

<!-- The problem this solves. Link the issue if there is one. -->

## Checklist

- [ ] `npm run verify` passes (lint, tests, manifest, checksums).
- [ ] New behaviour has a test in `deepcoder.test.cjs`.
- [ ] `README.md` and `docs/DSH-SETUP.md` are updated when the behaviour, the
      configuration or the commands change.
- [ ] No key, token or real conversation payload is included.
- [ ] The loopback rules are intact: `127.0.0.1` bind, `Host` check, `Origin`
      refusal, `/v1` only, no key in a log or on disk.
