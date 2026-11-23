# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.x | yes |

## Reporting a vulnerability

Please report security issues privately, not through a public issue tracker.

Use GitHub's **Security → Report a vulnerability** button on this repository
(private advisory). Include:

- what the problem is,
- how to reproduce it,
- what an attacker gains from it.

You will get an acknowledgement within a few days and a fix or a mitigation plan
once the report is confirmed.

## What DeepCoder does and does not protect

DeepCoder is a **local** gateway. It is designed so that a compromised or
careless configuration cannot expose your provider key:

- The server binds `127.0.0.1` only. It is not reachable from the network.
- Requests with a `Host` header that does not match the local port are refused.
- Requests with an `Origin` header are refused, so a page in your browser
  cannot drive the bridge (this blocks DNS-rebinding and CSRF style attacks).
- Only `/v1` routes are forwarded to the upstream.
- The provider key is never written to disk by the bridge, never logged and
  never put on a command line. It is read from the process environment or from
  `HKCU\Environment` at request time.
- An `Authorization` header sent by the client is used unchanged.
- Request and response bodies are never logged or stored.
- Bodies larger than 8 MiB are refused instead of being buffered.
- The upstream must be an HTTPS origin. Plain HTTP is only allowed for a
  loopback upstream.

## What DeepCoder cannot protect against

- **A compromised operating system or user account.** The key is readable by
  any process that runs as you.
- **A malicious local process.** Anything running on the machine can reach
  `127.0.0.1:8899` and use the key while the bridge is running. Do not share the
  machine with untrusted programs while the bridge is up.
- **The provider itself.** DeepCoder does not audit or vouch for the upstream.
- **A modified package.** The release manifest contains a SHA-256 checksum for
  every shipped file; verify it with `node tools/verify-manifest.cjs` if you
  are not sure where a copy came from.
