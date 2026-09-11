# Pi Session Mode

A [Pi](https://pi.dev) extension for guarded plan mode and explicitly scoped, incremental Git-worktree writer leases. Disjoint repository sets can work concurrently. This is an accidental-change guard, not a sandbox.

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

- `/plan` guards writes, drains pending additions, releases all leases, and saves plan mode.
- `/implement` acquires the cwd worktree when none is held; otherwise it retains the current set.
- `/implement repos/api repos/web` adds those worktree roots without implicitly leasing the workspace root. Quote literal paths containing spaces.
- `/leases` shows held/requested/failed scopes. `/leases repos/api` inspects that root without acquiring.
- `pi --implement --lease-roots '["repos/api","repos/web"]'` selects explicit startup roots. `--plan` wins; explicit startup flags override saved selection.
- `PI_SESSION_GUARD=0` is the explicit, visibly unguarded emergency bypass.

**Compatibility change in 0.2:** native `edit`/`write` calls require the target's owning worktree lease, including from default cwd-only sessions. A workspace-root lease no longer lets those tools edit linked or nested repositories. Select each target explicitly. Bash/script effects remain outside path enforcement. Legacy non-Git or unavailable implicit-cwd sessions remain visibly `unguarded` and bypass native checks; start in plan mode or select explicit valid roots to obtain protection.

A failed addition preserves previously held roots. Any lost lease guards the whole session and releases the set. There is no automatic acquisition from Beads, automatic release on completion/idle, per-root release, or special cross-repository owner. Narrow a set with `/plan`, then select the desired roots again. The footer keeps the guard label and adds `leases:N`; `/leases` provides full identities.

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

Enter `/plan`, remove only the selected package or checkout link, then restart Pi. Do not delete runtime lock files to force takeover. Version 0.2 writes safe v1 plan checkpoints before v2 scope records so older versions resume guarded instead of reviving stale implementation mode. Removing the extension makes its custom entries inert. Downgrading also removes scoped native-write enforcement; do not assume mixed-version sessions provide the same protection.

## License

[MIT](LICENSE).
