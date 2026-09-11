# Pi Session Mode

A [Pi](https://pi.dev) extension for guarded plan mode and one cooperative writer per canonical Git worktree. This is an accidental-change guard, not a sandbox.

See [the guard contract](docs/guard.md) for policy, lease lifetime, compatibility, failure behavior, and explicit bypasses.

## Requirements

- Pi 0.85.1 or newer; development and lifecycle checks use 0.85.1.
- Git and util-linux `flock` for writer exclusion; Linux `lslocks` for optional occupancy observation.
- Node.js from `.nvmrc` for development.

Pi supplies its core package at runtime; the peer range deliberately accepts the host version. The optional guarded-reviewer integration uses the installed `pi-subagents` discovery API and fails closed when unavailable; see the contract.

## Install

Pin a reviewed immutable Git ref:

```bash
pi install git:github.com/flurdy/pi-session-mode@<commit-or-tag>
```

For a reviewed mutable checkout, run `make apply`. It owns the existing `~/.pi/agent/extensions/flurdy-session-mode` link. Do not enable a Git package and a checkout link together. Restart Pi after first installation; use `/reload` for later edits. Each reload releases the old lease before attempting to reacquire it.

## Use

- `/plan` guards writes, releases the lease, and saves plan mode.
- `/implement` acquires the lease before enabling writes.
- `pi --plan` and `pi --implement` select startup mode; explicit plan wins.
- `PI_SESSION_GUARD=0` is the explicit, visibly unguarded emergency bypass.

Separate worktrees can implement concurrently. Workspace-root leases do not cover linked child repositories; this version does not implement multi-repository scopes.

## Observer integration

Consumers import the package-owned API:

```typescript
import { probeWorktreeLeaseOccupancy } from "@flurdy/pi-session-mode/lease-observer";
```

The observer has no third-party runtime dependencies and never acquires a lock. A separately installed Pi package is not automatically a Node dependency of another extension. [ai-tools statusline](https://github.com/flurdy/ai-tools/tree/main/pi/statusline) provides explicit dependency wiring to the reviewed checkout or installed Git package. Keep the guard and observer on the same selected revision and reload them together.

## Develop and verify

```bash
npm ci
npm run check
```

After committing, run `npm run verify:git-install`. It installs the exact local commit through a temporary loopback Git server into an isolated Pi agent directory, verifies commands and real lease lifecycle without a provider request, and checks the exported observer from a scratch consumer. No user installation is modified.

`make verify-apply` verifies a checkout link; `make check` runs tests, typechecking, and the exact package allowlist. History provenance is recorded in [the extraction record](https://github.com/flurdy/pi-session-mode/blob/main/docs/extraction-history.md).

## Rollback

Enter `/plan`, remove only the selected package or checkout link, then restart Pi. Do not delete runtime lock files to force takeover. Restoring a previous reviewed package revision restores its policy; v1 custom mode entries are inert when the extension is absent.

## License

[MIT](LICENSE).
