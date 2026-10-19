# Pi Session Mode

A [Pi](https://pi.dev) extension for guarded plan mode, Git-worktree writer leases with native-write-driven expansion, and confirmed exact-file grants outside Git. Disjoint repositories and configuration files can be coordinated independently. This is an accidental-change guard, not a sandbox.

See [the guard contract](docs/guard.md) for policy, lease lifetime, compatibility, failure behavior, and explicit bypasses.

## Requirements

- Pi 0.85.1 or newer; development and lifecycle checks use 0.85.1.
- Git and util-linux `flock` for writer exclusion; Linux `lslocks` for optional occupancy observation.
- Node.js from `.nvmrc` for development.

Pi supplies its core package at runtime; the peer range deliberately accepts the host version. The optional guarded-reviewer integration requires the compiled package layout from `pi-subagents` 0.68.0 or newer and fails closed when its discovery API is unavailable; see the contract.

## Install

Pin a reviewed immutable Git ref:

```bash
pi install git:github.com/flurdy/pi-session-mode@<commit-or-tag>
```

For a reviewed mutable checkout, run `make apply`. It owns the existing `~/.pi/agent/extensions/flurdy-session-mode` link. Do not enable a Git package and a checkout link together. Restart Pi after first installation; use `/reload` for later edits. Each reload releases the old lease before attempting to reacquire it.

## Use

- A fresh session or `/new` starts `lazy`: implementation intent with no worktree lease. The first native `edit`/`write` acquires only its target's canonical worktree; contention blocks that write and the session stays lazy. Until a worktree is held, obvious Bash, package, Git, system and writer-subagent mutations stay guarded, so use `/implement <root>` for shell-first work.
- `/plan` guards writes, drains pending additions, releases every worktree and file lease, and saves plan mode.
- `/lazy` releases held worktree leases, keeps exact-file grants, and saves lazy mode. The `release_scopes` agent tool does the same after a task's work is committed and verified; it refuses dirty worktrees unless explicitly allowed with a reason, and refuses while writes or scope transitions are active.
- `/implement` acquires the cwd worktree when none is held; otherwise it retains the current worktree set.
- `/implement repos/api repos/web` adds those worktree roots without implicitly leasing the workspace root. Quote literal paths containing spaces.
- `/grant-file ~/.agents/tool/config.json` resolves exact non-Git files, displays their canonical identities, and requires an interactive confirmation before acquiring them. It can establish file-only implementation mode without leasing cwd; the bounded guarded Bash/subagent policy remains active until a worktree is also leased.
- `/leases` shows held/requested/failed worktree scopes. `/leases repos/api` inspects that root without acquiring.
- `/lease-holders` lists every lease held by live local Pi sessions, grouped by session, validated against kernel locks; holder metadata is reported only when it matches.
- `/grants` shows held/requested/failed exact-file scopes. `/grants path` resolves that file identity without acquiring it.
- Named second-opinion panels can use the installed private stdin helper in plan mode, without source leases or general `/tmp` write permission. The helper requires a supporting guard and owns its scratch files; see [read-only second opinions](docs/guard.md#read-only-second-opinions).
- `save_handoff` saves a rendered resume block to the fixed user handoff directory in every guard state, without repository or `/grant-file` authority. New files auto-save; overwrite requires fresh TUI confirmation. See [handoff saves](docs/handoff-save.md) for helper requirements, concurrency and failure boundaries.
- Release-manager bookkeeping through the installed `release-state` helper works in guarded sessions without source leases; `update` is exempt only in its exact documented shape. See [release-state bookkeeping](docs/guard.md#release-state-bookkeeping).
- `publish_commit` publishes one exact, freshly confirmed commit to its same-name upstream in every guard state, without a source-writer lease. Each push needs its own native TUI confirmation and single-use token; no force, tags or retry. See [attended commit publication](docs/publication.md).
- `activate_pi_package` is an opt-in agent tool for one already-installed allowlisted Pi Git package. It requires live implement state and fresh TUI confirmation, but does not publish or reload. See [confirmed package activation](docs/package-activation.md).
- `pi --implement --lease-roots '["repos/api","repos/web"]'` selects explicit startup roots. `pi --lazy` saves lazy mode. `--plan` wins; explicit startup flags override saved selection, and `--lazy` combined with `--implement` or `--lease-roots` starts guarded plan mode instead.
- `PI_SESSION_GUARD=0` is the explicit, visibly unguarded emergency bypass.

**Compatibility change in 0.3:** once an implement session holds at least one live worktree lease, native `edit`/`write` preflight can acquire and persist additional canonical target worktrees without another prompt. Linked, nested and sibling repositories still require their own locks; a supported parallel wrapper acquires all missing roots atomically. This replaces the explicit-only expansion policy in released 0.2.1: leases now prevent writer collisions, not accidental targeting of a different repository. Plan, conflict, lost, unguarded and file-only sessions never auto-expand.

**Compatibility change after 0.5.0:** sessions without a saved selection, including `/new` and `--continue` with no history, start `lazy` instead of leasing cwd. Concurrent sessions launched at a workspace root no longer contend for that root; each takes the member worktree its first write targets. Saved selections still restore, bare `/implement` still leases cwd, and a lazy session that acquires a worktree saves it as explicit roots so a reload reacquires in-progress work. Lazy selections use a v4 checkpoint after a v1 plan checkpoint; older readers resume guarded.

Bash/script effects remain outside path enforcement and cannot trigger expansion. Legacy non-Git or unavailable implicit-cwd sessions (bare `/implement`, `--implement` or a saved cwd selection) remain visibly `unguarded`; start lazy or in plan mode, or explicitly select valid roots, to obtain protection.

A failed addition preserves previously held worktree and file scopes. Any lost lease guards the whole session and releases the combined set. File grants are limited to exact regular files with one filesystem link, or one missing leaf beneath an existing canonical parent; directories, missing parents, filesystem-marker-detectable Git ownership or administration, reserved Git marker names, hardlinks, dangling links, and special files fail closed. Marker-less or externally redirected worktrees are not detectable from an ordinary file path and remain outside this cooperative guarantee. Revalidation before every native edit/write catches identity and scope-revision changes.

Beads claims, prose, reads, environment variables, project configuration, and arbitrary model tools cannot trigger expansion. Only concrete native-write targets in an eligible session do so; `/grant-file` remains interactive-only. Release is always explicit: there is no automatic release on tracker close, completion or idle, no per-root release, and no special cross-repository owner. `/lazy` and `release_scopes` release the whole worktree set; `/plan` also releases file grants. Separate `leases:N` and `grants:N` extension statuses plus `/leases` and `/grants` expose the active identities. A bounded grant widget remains visible even when a custom footer ignores extension statuses.

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

After committing, run `npm run verify:git-install`. It installs the exact local commit through a temporary loopback Git server into an isolated Pi agent directory, verifies commands and real lease lifecycle, and checks the exported observer from a scratch consumer. It also runs the `verify:dynamic` helper against the installed package using a local scripted provider fixture: actual Pi native tools, contention, cancellation, in-turn persistence and reload, with no external model requests. No user installation is modified. Set `PANEL_STDIN_HELPER` to the reviewed agent-skills
`skills/second-opinion/scripts/review-panel-stdin.py` path to include the cross-repository plan-mode
check/run/evaluate smoke with a stub reviewer and no external model requests. Without it, that
coverage is explicitly skipped. Likewise, `RELEASE_STATE_HELPER` set to the reviewed agent-skills
`skills/release-manager/scripts/release-state` path adds a plan-mode release-state read/update smoke
against an ignored fixture state file. For a separate current-host smoke, run `node scripts/verify-dynamic.mjs`
with `PI_VERIFY_HOST_VERSION` matching `pi --version` (npm scripts prefer the development-pinned Pi).

`make verify-apply` verifies a checkout link; `make check` runs tests, typechecking, and the exact package allowlist. History provenance is recorded in [the extraction record](https://github.com/flurdy/pi-session-mode/blob/main/docs/extraction-history.md).

## Rollback

Enter `/plan`, remove only the selected package or checkout link, then restart Pi. Do not delete runtime lock files to force takeover. Roll back launcher `--lazy` emission before downgrading this extension. Worktree-only selections keep the safe v1-plan-plus-v2 checkpoint format; lazy selections write v1 plan then v4, which older versions restore as guarded plan. Selections containing file grants write a safe v1 plan checkpoint before their v3 combined record, so v2 readers resume guarded rather than retaining only part of the authority. Removing the extension makes its custom entries inert. Downgrading also removes exact-file and scoped native-write enforcement; do not assume mixed-version sessions provide the same protection.

## License

[MIT](LICENSE).
