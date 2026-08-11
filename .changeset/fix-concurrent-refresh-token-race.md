---
"@cloudflare/workers-auth": patch
---

Fix concurrent process race on single-use refresh tokens

When multiple wrangler processes hit the token expiry window simultaneously, they could all read the same single-use refresh token and race to exchange it. The loser's exchange would fail with `invalid_grant`, potentially killing the refresh chain permanently until interactive re-login.

The refresh operation is now serialized across processes on the same machine using an advisory file lock, and includes a retry-on-`invalid_grant` fallback that re-reads the token from disk in case a sibling process rotated it. Refresh failures are also now logged at warn level (previously debug-only) for easier diagnosis.
