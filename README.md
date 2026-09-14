# Pi Session Mode

A [Pi](https://pi.dev) extension for guarded plan mode, Git-worktree writer leases with native-write-driven expansion, and confirmed exact-file grants outside Git. Disjoint repositories and configuration files can be coordinated independently. This is an accidental-change guard, not a sandbox.

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

- `/plan` guards writes, drains pending additions, releases every worktree and file lease, and saves plan mode.
- `/implement` acquires the cwd worktree when none is held; otherwise it retains the current worktree set.
- `/implement repos/api repos/web` adds those worktree roots without implicitly leasing the workspace root. Quote literal paths containing spaces.
- `/grant-file ~/.agents/tool/config.json` resolves exact non-Git files, displays their canonical identities, and requires an interactive confirmation before acquiring them. It can establish file-only implementation mode without leasing cwd; the bounded guarded Bash/subagent policy remains active until a worktree is also leased.
- `/leases` shows held/requested/failed worktree scopes. `/leases repos/api` inspects that root without acquiring.
- `/grants` shows held/requested/failed exact-file scopes. `/grants path` resolves that file identity without acquiring it.
- `pi --implement --lease-roots '["repos/api","repos/web"]'` selects explicit startup roots. `--plan` wins; explicit startup flags override saved selection.
- `PI_SESSION_GUARD=0` is the explicit, visibly unguarded emergency bypass.

**Compatibility change in 0.3:** once an implement session holds at least one live worktree lease, native `edit`/`write` preflight can acquire and persist additional canonical target worktrees without another prompt. Linked, nested and sibling repositories still require their own locks; a supported parallel wrapper acquires all missing roots atomically. This replaces the explicit-only expansion policy in released 0.2.1: leases now prevent writer collisions, not accidental targeting of a different repository. Plan, conflict, lost, unguarded and file-only sessions never auto-expand.

Bash/script effects remain outside path enforcement and cannot trigger expansion. Legacy non-Git or unavailable implicit-cwd sessions remain visibly `unguarded`; start in plan mode or explicitly select valid roots to obtain protection.

A failed addition preserves previously held worktree and file scopes. Any lost lease guards the whole session and releases the combined set. File grants are limited to exact regular files with one filesystem link, or one missing leaf beneath an existing canonical parent; directories, missing parents, filesystem-marker-detectable Git ownership or administration, reserved Git marker names, hardlinks, dangling links, and special files fail closed. Marker-less or externally redirected worktrees are not detectable from an ordinary file path and remain outside this cooperative guarantee. Revalidation before every native edit/write catches identity and scope-revision changes.

Beads claims, prose, reads, environment variables, project configuration, and arbitrary model tools cannot trigger expansion. Only concrete native-write targets in an eligible session do so; `/grant-file` remains interactive-only. There is also no automatic release on completion/idle, individual release, or special cross-repository owner. Narrow a set with `/plan`, then select the desired scopes again. Separate `leases:N` and `grants:N` extension statuses plus `/leases` and `/grants` expose the active identities. A bounded grant widget remains visible even when a custom footer ignores extension statuses.

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

After committing, run `npm run verify:git-install`. It installs the exact local commit through a temporary loopback Git server into an isolated Pi agent directory, verifies commands and real lease lifecycle, and checks the exported observer from a scratch consumer. It also runs the `verify:dynamic` helper against the installed package using a local scripted provider fixture: actual Pi native tools, contention, cancellation, in-turn persistence and reload, with no external model requests. No user installation is modified.

`make verify-apply` verifies a checkout link; `make check` runs tests, typechecking, and the exact package allowlist. History provenance is recorded in [the extraction record](https://github.com/flurdy/pi-session-mode/blob/main/docs/extraction-history.md).

## Rollback

Enter `/plan`, remove only the selected package or checkout link, then restart Pi. Do not delete runtime lock files to force takeover. Worktree-only selections keep the safe v1-plan-plus-v2 checkpoint format. Selections containing file grants write a safe v1 plan checkpoint before their v3 combined record, so v2 readers resume guarded rather than retaining only part of the authority. Removing the extension makes its custom entries inert. Downgrading also removes exact-file and scoped native-write enforcement; do not assume mixed-version sessions provide the same protection.

## License

[MIT](LICENSE).
