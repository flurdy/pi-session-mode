# Pi Session Mode

A [Pi](https://pi.dev) extension for guarded plan mode, Git-worktree writer leases, confirmed non-Git file/folder grants and attended admin runs.

**An accidental-change guard, not a sandbox.** Leases coordinate cooperating local Pi sessions; shell/script effects are not path-confined. See the [guard contract](docs/guard.md) for policy and failure boundaries.

## Requirements

- Pi 0.85.1 or newer; development and lifecycle checks use 0.85.1. An open host peer range does not certify later versions.
- Git and util-linux `flock`; Linux `lslocks` for optional occupancy observation.
- Node.js from `.nvmrc` for development. Pi supplies its core package at runtime.
- Optional guarded reviewers: `pi-subagents` 0.68.0+ with its compiled discovery API. Missing/incompatible discovery fails closed; see [runtime compatibility](docs/guard.md#runtime-and-distribution).

## Install

Pin a reviewed immutable Git ref:

```bash
pi install git:github.com/flurdy/pi-session-mode@<commit-or-tag>
```

Or, from a reviewed mutable checkout, run `make apply` to manage `~/.pi/agent/extensions/flurdy-session-mode`. **Do not enable both sources.** Restart Pi after first installation; use `/reload` for later edits. Reload releases old leases before reacquiring the saved selection.

## Everyday use

A fresh session or `/new` starts **lazy**, holding no worktree lease. The first native `edit`/`write` acquires its target's canonical worktree. Contention blocks the write, with an optional attended wait of up to five minutes; there is no automatic retry after refusal.

### Modes and repository work

| Command | Effect |
|---|---|
| `/plan` | Guard writes, drain pending acquisitions, release all worktree/file/folder leases and save plan mode. |
| `/lazy` | Release all worktree leases, keep file/folder grants and save lazy mode. |
| `/implement` | Acquire cwd's worktree if none is held; otherwise keep the current set. |
| `/implement repos/api repos/web` | Add only those worktree roots, not the workspace root. |

For shell-first repository work, acquire the intended roots explicitly:

```text
/implement repos/api "repos/web client"
/leases
```

Paths are literal worktree roots, not subdirectories; quote spaces. While no worktree is held, obvious Bash, package, Git, system and writer-subagent mutations remain guarded. Use `run_admin`, not an unrelated lease or a dummy edit, for administration outside held worktrees.

### Non-Git files and folders

| Command | Effect |
|---|---|
| `/grant-file ~/.agents/tool/config.json` | Confirm canonical exact-file identities, then allow native edits/writes to those files. |
| `/grant-folder ~/.agents/notes` | Confirm non-Git folders, then allow native edits/writes beneath them. |
| `/revoke-grants [paths...]` | Release named or all file/folder grants; keep worktrees. |

For example, grant an existing non-Git configuration file, then revoke it when finished:

```text
/grant-file ~/.agents/tool/config.json
/grants
/revoke-grants ~/.agents/tool/config.json
```

Grants require interactive TUI confirmation. An exact-file grant also permits one missing leaf beneath an existing canonical parent. Folder grants permit new descendants, never symlink escapes or repository files. Grants authorize native writes only, not Bash; grant-only sessions keep the bounded shell guard. See [scope validation](docs/guard.md#scope-selection) and [folder grants/admin runs](docs/admin-runs.md).

### Inspect without acquiring

- `/leases [roots...]` — held/requested/failed worktrees; supplied roots are inspected only.
- `/grants [paths...]` — held/requested/failed grants; supplied paths are resolved only.
- `/lease-holders` — kernel-validated inventory of live local Pi holders, grouped by session.

The `leases:N` / `grants:N` statuses and grant widget expose active scopes. See [diagnostics](docs/guard.md#diagnostics-and-footer).

## Safety and session lifetime

- **Native writes can expand scope without another prompt** in lazy or healthy repository implementation sessions, including linked, nested and sibling repositories. A parent lease does not cover a nested repository. Plan, conflict, lost, unguarded and file-only sessions never auto-expand. Leases prevent cooperating-writer collisions, not wrong-repository targeting.
- Reads, Beads claims, prose, environment variables, project configuration and arbitrary tools do not acquire leases. Bash/script effects cannot trigger expansion and remain outside native path enforcement.
- Failed additions retain healthy held scopes; loss of any lease guards the whole session and releases the combined set. Unavailable explicit roots fail closed. Legacy implicit-cwd non-Git/unavailable sessions can instead be visibly **unguarded**; use lazy, plan or explicit valid roots for protection.
- Release is explicit, never automatic on tracker close, completion or idle; there is no per-root worktree release. The agent's `release_scopes` tool returns to lazy only after committed, verified work; dirty roots need the user's explicit allowance and reason, and busy transitions refuse release. `/plan` also releases grants.
- `PI_SESSION_GUARD=0` is the explicit, visibly unguarded emergency bypass. Other editors, machines, trusted extensions and typed `!` / `!!` can bypass the guard. Native preflight is not atomic filesystem isolation.

See [dynamic acquisition and contention](docs/guard.md#dynamic-native-write-acquisition), [persistence and compatibility](docs/guard.md#failure-and-persistence) and [explicit limitations](docs/guard.md#explicit-limitations).

### Startup selection

```bash
pi --lazy
pi --implement --lease-roots '["repos/api","repos/web"]'
pi --plan
```

`--plan` wins; explicit startup flags override saved selection and reapply on reload. Do not combine `--lazy` with `--implement` or `--lease-roots`: that starts guarded plan mode. Otherwise saved selections restore; a lazy session saves acquired roots for reload. See [selection precedence](docs/guard.md#scope-selection).

## Task-specific tools and integrations

These are agent tools or installed helpers, not slash commands. Each keeps its own authorization boundary.

| Operation | Tool or helper | Boundary and details |
|---|---|---|
| Administrative script or installer | `run_admin` | Fresh confirmation of one exact command, cwd and declared non-Git folders; effects are not confined. Git mutations, publication and remote sync are refused. [Contract](docs/admin-runs.md#run_admin). |
| Resume handoff | `save_handoff` | Fixed `~/.agents/handoffs` destination in every guard state; new files auto-save, replacement needs fresh TUI confirmation. Requires the reviewed installed helper and Python 3.10+. [Contract](docs/handoff-save.md). |
| Exact-commit push | `publish_commit` | Every guard state, no source lease; each push needs its own native `defer` / `push` / `cancel` / `why?` dialog and single-use token. No force, tags or retry. [Contract](docs/publication.md). |
| Installed Pi Git package update | `activate_pi_package` | Live implement state, an already-installed allowlisted package and fresh TUI confirmation; no publication or reload. [Contract](docs/package-activation.md). |
| Read-only named review panel | Installed private stdin helper | Guarded use without source leases or general temporary-write authority. [Supported shape](docs/guard.md#read-only-second-opinions). |
| Release-manager bookkeeping | Installed `release-state` helper | Guarded use without source leases; `update` requires the exact documented shape. [Supported shape](docs/guard.md#release-state-bookkeeping). |

The lease observer never acquires locks and has no third-party runtime dependencies. Consumers import `probeWorktreeLeaseOccupancy` from `@flurdy/pi-session-mode/lease-observer`. Separate Pi installation does not supply another extension's Node dependency: [ai-tools statusline](https://github.com/flurdy/ai-tools/tree/main/pi/statusline) documents explicit wiring. Keep guard and observer on the same revision and reload together.

## Develop and verify

Use `.nvmrc`'s Node version:

```bash
npm ci
npm run check
# After committing:
npm run verify:git-install
```

`check` runs tests, typechecking, the exact package allowlist and documentation-link checks. Git-install verification tests the exact local commit in an isolated agent directory, including real native-write lifecycle checks with a local scripted provider; it makes no external model requests and leaves the user installation unchanged. See [verification options and helper smokes](docs/guard.md#verification-options) for optional cross-repository coverage and current-host checks.

`make verify-apply` checks a checkout link; `make check` runs the npm checks. See the [extraction record](https://github.com/flurdy/pi-session-mode/blob/main/docs/extraction-history.md) for history provenance.

## Rollback

1. Enter `/plan`, remove only the selected package or checkout link, then restart Pi.
2. Before downgrading, roll back launcher `--lazy` emission. Reload **all sessions on the machine together** when upgrading or rolling back: older sessions lack shared file/folder ancestor-intent coordination.
3. Never delete runtime lock files to force takeover. Older readers reject newer checkpoint formats into guarded plan. Removing the extension makes its entries inert; downgrading or removing it can remove exact-file and scoped native-write enforcement. Do not assume mixed-version sessions provide equivalent protection.

See [checkpoint compatibility](docs/guard.md#failure-and-persistence) and [file/folder coordination gaps](docs/admin-runs.md#leases-and-coordination).

## License

[MIT](LICENSE).
