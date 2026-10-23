# Security Policy

open-eyes drives a real browser that may hold your logged-in sessions, so we take
security reports seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through
[GitHub private vulnerability reporting](https://github.com/SchlaftGut0-1/open-eyes/security/advisories/new).

Include what you found, how to reproduce it, and the impact you expect. We aim to
acknowledge reports within 7 days and will keep you updated until a fix ships.

## Supported versions

open-eyes is pre-1.0. Only the latest release on `main` receives security fixes.

## Scope notes

- The site policy, confirmations and audit log (`open-eyes policy`, `open-eyes log`)
  protect against pages steering the agent. They are not a sandbox: an agent that is
  itself compromised can edit the policy file. Reports of ways for a *page* to bypass
  them are in scope.
- open-eyes connects to the browser's remote debugging port on `127.0.0.1`. Anything
  that can reach that port can control the browser; do not expose it to a network.
- Scripts passed to `open-eyes run` execute with your user's permissions, the same as
  any command your agent runs in a terminal.
