# Guard and lease contract

The current contract uses explicit, incrementally growing sets of canonical Git-worktree leases and confirmed exact-file grants outside Git. It is a cooperative, same-user/same-machine accidental-change guard, not filesystem isolation or a security sandbox.

## Scope selection

| Action | Result |
|---|---|
| Fresh session without a saved selection, or `/new` | Lazy: hold no worktree lease until a native write needs one. |
| Bare `/implement`, no leases | Request the cwd Git worktree. |
| Bare `/implement` with a healthy set | No-op; keep existing scopes. |
| `/implement path-a path-b` | Add the named roots; never implicitly add cwd. |
| Native `edit`/`write` in a healthy repository implementation or lazy session | Acquire missing canonical target worktrees without another prompt, then revalidate the write. |
| `/lazy` | Release every worktree lease, keep exact-file grants, select lazy. |
| `release_scopes` agent tool | After verified task completion, release every worktree lease back to lazy; refuses dirty, busy or ineligible sessions. |
| `/grant-file path-a path-b` | Resolve exact non-Git files, require interactive confirmation, then add their file leases. |
| `/plan` | Guard writes, cancel/drain acquisition, release every worktree and file lease, clear selection. |
| `/leases [paths...]` | Read-only worktree diagnostics, or explicit occupancy inspection. |
| `/lease-holders` | Read-only inventory of every lease held by live local Pi sessions, grouped by session. |
| `/grants [paths...]` | Read-only file-grant diagnostics, or canonical identity inspection. |

Explicit `/implement` paths must identify existing worktree roots or their symlink aliases. Subdirectories are rejected rather than silently broadening to an ancestor. Paths are quoted literals, with no shell execution, variable substitution or glob expansion. File URLs can represent unusual literal characters. The startup string flag `--lease-roots` accepts a JSON array.

`/grant-file` accepts only exact non-repository files after showing the complete bounded canonical set in a fresh TUI confirmation. It is TUI-only (RPC and headless calls are denied), unavailable while the guard is disabled, and expires after 60 seconds. Session identity plus idle/pending-message state are checked again after the dialog. Existing regular files must have exactly one filesystem link. A missing leaf is accepted only beneath an existing canonical directory; missing parents are rejected because native `write` would otherwise create unleased directories. Existing symlink aliases resolve to their targets and share one identity. Directories, hardlinks, dangling links, loops, special nodes, paths beneath `.git`, reserved Git marker names, filesystem-marker-detectable worktree files, and bare or malformed Git-administration shapes fail closed. Git command failure is never evidence that a target is safe non-repository state; independent filesystem marker checks must establish it. Marker-less or externally redirected worktrees cannot be discovered from an ordinary target path and remain outside the guarantee.

Worktrees and files each have an independent limit of 32. Each combined addition has a ten-second cancellation deadline; cleanup may require draining pending process termination before returning. Confirmation evidence is rebound during acquisition: changed canonical identities fail before any new scope is published.

Startup precedence is `--plan`, then `--lease-roots`, then `--implement`, then `--lazy`, then the saved selection, then the lazy fresh default. `--plan` is a per-launch guarded override; use `/plan` to clear saved selection. `--lazy` combined with `--implement` or `--lease-roots` is rejected into guarded plan mode with an error notice and no checkpoint. Successful explicit startup roots, `--implement` and `--lazy` selections are checkpointed for later restoration. Explicit startup roots replace restored selection; explicit `--implement` without roots selects cwd. Startup flags are reapplied on reload, so they also replace a selection saved during the session.

`/new` starts an empty session rather than inheriting interactive `/plan` selection. Without an explicit startup override, it starts lazy and takes no lease. A failed addition reports retained leases only when a healthy prior set remains, and retains lazy intent when it started from a healthy lazy session.

Lazy workspace-root sessions do not contend until they write into the same worktree. Two sessions holding the workspace root itself, for example through bare `/implement`, still contend. Workspace files require the workspace lease; tracking-only local Beads operations remain permitted without it. A Beads store identifies tracking ownership, not every source repository a task needs. Claims and `/next` selections have no runtime lease side effect; a subsequent concrete native write is the dynamic trigger.

## Lazy implementation and release

Lazy separates implementation intent from held scope. A lazy session holds no worktree lease; native edit/write tools stay visible. Its first native write resolves the target's canonical owning worktree, including nested, linked and sibling repositories, and acquires only that root through the same atomic transaction, deadline, identity, revision and rollback checks as other dynamic acquisition (described below). The session then shows `implement` and saves the acquired roots as an explicit v2/v3 selection with the lazy origin cwd, so a reload or resume reacquires in-progress work rather than leaving it unprotected.

Contention, unavailable identity, cancellation or an ungranted non-repository target blocks that write and keeps the session lazy; lazy never escalates to `conflict` because no lease was held. Reads, Bash, Beads claims, prose, model-supplied paths and subagent requests never acquire roots. While no worktree is held, lazy applies the file-only boundary: the bounded guarded Bash, package, Git, system and writer-subagent policy, with verified read-only reviewers permitted. Shell-first work needs an explicit `/implement <root>`; never make a dummy edit to unlock shell authority.

Exact-file grants compose with lazy. `/grant-file` in a lazy session keeps lazy intent and saves a v4 record with the files; restoration reacquires those file leases without another prompt. A restored lazy selection whose canonical origin cwd changed enters plan with a reselect notice. A failed file reacquisition or other restore failure also guards to plan.

`/lazy` is an idle-only user command. From implement it saves lazy, releases every worktree lease while keeping file grants, and reports dirty released roots as warnings. From plan, conflict, lost or legacy unguarded states it selects lazy intent without acquiring anything. It is unavailable while `PI_SESSION_GUARD=0`.

`release_scopes` is a model-callable tool for the end of a verified task. It runs in Pi's sequential execution mode, refuses while any native write (including codemode-nested writes, tracked from Pi's tool-execution start event, which precedes `tool_call` preflight), scope acquisition, package activation, release or shutdown is active, and reserves the transition before checking so no write or acquisition can start between inspection and release. Each held root is checked with a bounded `git status --porcelain`; a failed or timed-out probe refuses. Dirty roots refuse unless `allowDirty` is true with a nonempty reason, which is reported with the affected roots. The model must not set it without the user's explicit decision. On success every worktree lease is released together, exact-file grants stay held, the lease revision bump invalidates pending preflights, and the session saves and shows `lazy`. If the checkpoint fails after release, the result and a notice say so; restart with `--lazy`. A lazy session with no worktree returns success unchanged. Plan, conflict, lost, acquiring, file-only and unguarded sessions are refused and unchanged, so a file-only grant never becomes lazy worktree intent. Supported parallel wrappers reject nested `release_scopes`.

Tracker status is not runtime authority: closing a bead never releases scopes by itself. The completion workflow calls `release_scopes` after a verified close and reports a refusal; `/plan` remains the full reset of worktrees and file grants.

## Local Beads triage in guarded sessions

Local Beads means a local issue mutation in the resolver-proven owning store, not only the
invoking cwd. A plan-mode session in repository A may use `bd -C <proven directory>` to add
comments or create, update and close issues in repository B without `/implement` or a source
worktree lease. Ambiguous, unavailable or not-found ownership resolution writes nothing, and
repository-specific tracker rules still win. The guard does not resolve tracking ownership;
follow the shared Beads resolver workflow before a mutation. No Beads operation grants or
acquires source authority.

Keep local issue updates, remote synchronization and source/Git/package/system changes distinct.
A configured Dolt remote alone does not make a comment a sync request. Verify effective export,
backup, hook and synchronization settings and actual side effects, not commented examples or
local-looking command syntax. Effects beyond local tracking require their own applicable
authority; `/implement` alone does not authorize remote or destructive actions.

Synchronization belongs to the workspace tooling, not this extension. Where available, use
`make beads-sync-check` for a local preview and `make beads-sync` only after fresh explicit human
confirmation of that workspace operation. Guarded and file-only sessions block recognizable
`make beads-sync` and `project-workspace beads-sync` invocations; the check target and explicit
`--dry-run` remain available. Raw Dolt remote commands, force, conflict resolution, migration,
bootstrap, remote changes, backup publication and source Git remain guarded. Never synchronize
during reads or local triage. Renamed targets, aliases and arbitrary script side effects remain
outside the bounded shell check; they are not authorization workarounds.

The bounded Bash checker permits ordinary triage with literal quoted prose, including words such
as `delete`, `git push` and `npm install`. It still checks executable command chains and constant
shell-wrapper payloads; a triage command does not exempt a following source or destructive
mutation. Quoting is not shell isolation: substitutions and arbitrary script side effects remain
outside this accidental-change guard's guarantee.

## Attended publication

Publishing a commit is a remote action, not a source edit, so it does not use writer leases.
`publish_commit` is available in every guard state: each exact commit needs its own native
TUI confirmation and single-use session token, then execution rechecks identity and
configuration before a non-force single-ref push. Guarded Bash still blocks raw `git push`
and recognizable `make`/`gmake` push targets, whose recipes publish whatever tip exists
when they run. Do not request `/implement` scopes to publish. See
[attended commit publication](publication.md).

## Release-state bookkeeping

Release bookkeeping is not a source edit. The release-manager `release-state` helper writes only
its project's ignored `.release-state.json` and owns target, hash, owner-key and malformed-state
validation. Its `read` and publication-record verbs pass the bounded Bash check unchanged.
`update` names its `--patch` option, which that check reads as the `patch` utility, so guarded
sessions add one exception for this fixed shape:

```bash
~/.agents/skills/release-manager/scripts/release-state update --owner <manager|maintenance> --expect <sha256|missing> --patch '<literal JSON>'
```

The patch is one single-quoted literal without ASCII control characters; encode apostrophes in
JSON values as `\u0027`. Other `update` forms gain no exception. When the bounded check blocks one,
for example with an environment prefix, interpreter, alternate or absolute path, option form,
extra argument, chain, redirect or shell wrapper, its reason names this shape instead of the
generic message. The exception does not make the bounded check complete.

No source lease, `/implement`, exact-file grant or native write is involved. This is trusted
installed-helper execution, not digest-verified code or shell isolation, and it grants no
publication: `publish_commit` keeps its own fresh confirmation.

## Read-only second opinions

Direct read-only second-opinion routes do not require a source lease. Eligibility is not proof
of executable availability, authentication, billing consent or successful launch. Verified external
children retain the inherited-cwd async-only contract; never pass native child options to expand
an external runner's tools. Current discovery and runner preflight must both succeed.

Named panels are eligible in guarded states, including file-only sessions, through the installed
`~/.agents/skills/second-opinion/scripts/review-panel-stdin.py` helper only. The fixed Bash shape is
`printf '%s' '<literal JSON>' | python3 ~/.agents/skills/second-opinion/scripts/review-panel-stdin.py`.
Encode apostrophes in JSON values as `\u0027`; no shell expansion, alternate helper path, arguments,
redirects or command chains are accepted. The helper owns fresh private scratch files and reuses
the coordinator's check/run/evaluate protocol; no source lease or native adapter is introduced.
It accepts bounded data rather than artifact paths, commands, cwd or environment overrides.

Caller-file `review-panel.sh` and `openrouter-panel.sh` commands remain blocked, including recognized
shell/`env` wrappers. `mktemp`, native writes, arbitrary redirects and cleanup remain guarded.
An older guard or missing helper is unavailable support, never permission to bypass or emulate the
panel. This is trusted installed-helper execution, not digest-verified code or shell isolation:
user-controlled runtimes, scripts, CLI hooks/caches, indirection and subprocess effects remain
outside comprehensive enforcement. The helper cleans ordinary exits and supported cancellation;
SIGKILL, power loss or uncooperative children may leave private artifacts/processes.

There is no broad temporary-directory or home grant, no new native-write exception, and no change
to panel selection, prompt/panel/subset digests, limits, billing or quorum/consensus interpretation.
The guard's command eligibility does not attest model consent or task authorization. The owning skill's
[support matrix](https://github.com/flurdy/agent-skills/blob/main/skills/second-opinion/references/guarded-plan.md)
separates policy from actual runtime evidence and explains unsupported options, plan-policy denial,
unavailable executable/auth, version incompatibility and billing consent. It never recommends
implementation mode solely for a supported read-only consultation.

## Kernel authority and transitions

The identity remains SHA-256 of the canonical Git top-level path. Git's answer must match the nearest filesystem `.git` marker. Ambient location overrides, redirected `core.worktree` configurations and marker-less setups that disagree are unavailable, not alternate ownership. Normal clones, linked worktrees and initialized submodules remain supported. Each root has a stable private-runtime `flock` file plus diagnostic-only holder metadata. The fixed holder process publishes a ready handshake only after metadata publication. No JSON file or tracker claim proves ownership.

Worktree lock filenames and the public observer remain unchanged. File locks use a separate `file-<sha256>` namespace keyed by the canonical exact path. Both kinds reuse the fixed holder process and metadata-publication handshake; metadata is diagnostic only.

The controller keeps one combined committed live set H and transaction-local acquisitions N. It validates, canonicalizes, deduplicates and sorts targets, then acquires missing worktrees and files sequentially and nonblockingly. Explicit mode commands temporarily guard writes; dynamic tool preflight does not change the active tool list or visible implement state. It publishes the union only after all handles and the scope checkpoint are valid. A failed addition drains N and retains healthy H. Per-handle release promises are separate from the aggregate drain barrier.

Different overlapping transitions are rejected; identical explicit requests share their operation. User scope commands require Pi to be idle with no pending messages. Dynamic acquisitions run inside native tool preflight and use its blocking result instead of waiting for idle; simultaneous dynamic requests fail busy rather than queuing. Superseded callbacks cannot publish scope, restore tools or persist success. Unexpected loss of any handle guards immediately, invalidates the operation, drains the entire set and reports `lost`.

There is no waiting/retry loop, stealing, preemption, idle expiry, automatic completion-triggered release or per-root release; `/lazy` and `release_scopes` release the whole worktree set explicitly. Two sessions holding opposite roots may both fail to expand; one must voluntarily enter `/plan` or `/lazy`. Sorting does not eliminate this human coordination stand-off. Shutdown, reload and session replacement drain all handles; children do not inherit authority. Release closes the holder pipe, then force-terminates that owned child after one second if necessary and still waits for close. A failed drain remains fail-closed rather than being treated as successful cleanup.

## Guarded states and native paths

Plan, conflict, lost and acquiring states hide and independently block native edit/write tools. Lazy keeps them visible for first-write acquisition. They retain the existing bounded Bash mutation policy and verified read-only subagent policy. Missing/incompatible reviewer discovery stays fail-closed. Scope transitions and UI reporting do not weaken these guards.

While implementing, a separate native-write checker:

- normalizes supported Pi path forms, follows actual symlink targets, and resolves new repository files through their nearest existing parent;
- distinguishes dangling links from missing ordinary components;
- first requires exact owning Git-root membership; only an independently proven non-Git regular file or permitted missing leaf can use an exact-file grant;
- rewrites an allowed exact-file tool argument to its canonical path so Pi's same-process mutation queue cannot split one missing target across symlink aliases;
- revalidates file type, link count, Git markers and identity before every native edit/write;
- rejects ambiguous ownership and rechecks the combined scope revision after asynchronous resolution;
- recursively checks supported parallel wrappers with the existing bounded/malformed-call rules.

A parent lease does not cover a nested repository or initialized submodule. Independently proven non-Git files still require `/grant-file`. Repository targets can trigger dynamic acquisition as described below; unresolvable identity or contention blocks the native call. No Beads event grants authority.

File locks provide cooperating-session exclusion, not content compare-and-swap. Scope-revision rechecks catch loss or selection changes during asynchronous preflight. External content changes, hostile filesystem races, and holder loss between preflight and the actual write remain outside the same documented TOCTOU boundary as worktree scopes. Native Pi serializes same-process operations for the canonical file; this extension does not override edit/write implementations or claim atomic file writes.

A file-only implementation session retains the guarded bounded Bash, package, Git, system and writer-subagent policy while allowing native edit/write through the exact-file checker. Adding any worktree lease selects the ordinary implementation boundary, where shell/script effects are explicitly unscoped. This avoids turning confirmation of one configuration file into general obvious shell-mutation authority.

## Dynamic native-write acquisition

This deliberately replaces released 0.2.1's explicit-only expansion policy. A healthy `implement` session with at least one held worktree, or a healthy lazy session, may acquire additional canonical owners identified by native `edit`/`write` arguments. This includes implicit-cwd sessions, nested repositories, symlinked workspace members and siblings outside cwd. There is no topology-file or tracker authority. Consequently, an accidental write to another valid, uncontended repository can acquire that repository; leases are coordination, not a wrong-repository safety boundary.

Plan, conflict, acquiring, lost, unguarded and file-only sessions never auto-expand. Reads, Bash, arbitrary tools and subagent cwd requests are not triggers. Existing explicit `/implement` and `/grant-file` controls remain available. A candidate root containing any held exact-file grant is rejected for explicit reselection, so a newly initialized Git repository cannot silently convert a file grant into repository authority.

Preflight first validates every supported nested call and collects canonical missing owners. Malformed wrappers/native arguments, unknown nested tools, ungranted non-repository files, unavailable identity or an oversized combined set take no new leases. A complete wrapper's missing roots are acquired as one transaction, with the unchanged 32-root limit. Separate assistant sibling calls are independently preflighted by Pi before execution in parallel mode; a failed sibling does not roll back a different sibling's completed acquisition. Sequential calls use the same gate.

Generation, live-set revision, origin cwd and cancellation are checked before acquisition and again in the persistence callback. The tool's abort signal and a ten-second acquisition deadline cancel and drain pending additions. Active tools remain unchanged during this preflight. On commit, the full worktree set is saved as explicit roots with canonical origin cwd, retaining file selections via v3 when needed. Existing explicit origin must match rather than being silently replaced.

After acquisition, the original call is checked afresh against the committed set and revision. A retargeted path is blocked, not repeatedly auto-acquired. If the tool is aborted or fails after acquisition has committed, those roots remain held and selected until `/plan`, `/lazy` or `release_scopes`; no individual release is implied. A loss or shutdown cannot be overridden by a late preflight completion. This remains the existing cooperative, non-atomic preflight-to-write boundary, not filesystem isolation.

## Failure and persistence

`/plan` saves its checkpoint immediately after guarding, before release and bounded advisory dirty checks. A checkpoint failure never prevents release; it is reported, and a restart should explicitly use `--plan` if saving failed.

Empty explicit requests that fail leave no authority and save a safe plan checkpoint. Contention shows `conflict`; invalid/unavailable explicit paths never silently fall back to cwd or unguarded operation. Failed additions with healthy prior roots preserve those roots and their selected scope. A partially written compatibility checkpoint may restore more conservatively to plan.

Legacy implicit-cwd infrastructure failures retain their prominent `unguarded` fail-open behavior. In particular, a non-Git coordination directory starts unguarded and bypasses native path checks; start with `--plan` or select explicit valid Git roots instead. Implicit cwd contention retains implementation intent for a future fresh acquisition. `PI_SESSION_GUARD=0` explicitly bypasses the guard and never claims successful scoped ownership.

V1 mode entries remain readable. V2 records distinguish plan, implicit cwd and explicit worktree roots with originating cwd. Worktree-only selections continue to write v2. A selection containing exact files writes a v3 combined record after a v1 plan checkpoint; v2 readers reject that newest unknown record into plan rather than restoring only its worktrees. A lazy selection writes a v4 record (canonical origin cwd plus optional exact files) after a v1 plan checkpoint; v0.5.0 and earlier readers reject it into guarded plan. A branch with no session-mode entry starts lazy; it is not checkpointed until a selection changes. Only canonical selection is persisted; handles and ownership are not. Unknown or malformed newest records do not fall through to older authority.

Changed originating cwd, missing roots, changed file identities, new Git ownership, changed link counts, or unavailable markers require guarded reselection. Restored identities are checked before acquisition, and each explicit acquisition checks its expected identity before taking a lock. Canonical saved paths are passed as file URLs rather than reinterpreted through user-input whitespace normalization. Restoration and reload reacquire; new sessions and forks never inherit locks. Explicit startup `--plan`, `--implement`, or `--lease-roots` selections do not implicitly restore file grants.

## Fixed-destination handoff saves

`save_handoff` is an explicit operation-specific exception in every guard state, independent of
source leases and exact-file grants. It runs only the digest-verified installed wrap-up helper,
with a fixed user-home destination and bounded content; no shell or caller-selected path is allowed.
New files need no confirmation. Replacement requires fresh hash-bound native TUI confirmation;
headless/RPC replacement is denied. Temporary per-target leases last only for the save, without
changing session scope. The [handoff-save contract](handoff-save.md) owns helper trust, queueing,
concurrency, cancellation, verification, rollout and residual risks. This exception grants no
native edit/write, shell, arbitrary artifact or panel authority.

## Confirmed package activation

`activate_pi_package` is an explicit exception to the ordinary native-path boundary, not a repository lease expansion. Its mutation authority exists only inside the controller closure while the session is in live `implement` state with at least one worktree lease, no guard bypass, no scope transition and an interactive timed confirmation. Plan, conflict, acquiring, lost, unguarded and file-only states block it; the bounded generic policy also rejects the tool before execution in guarded states. No persisted selection, status value, event-bus message, project file, prompt or model assertion can grant this authority.

The adapter reads only the fixed user allowlist under Pi's runtime-provided agent directory. It revalidates the exact package source, clean canonical managed checkout, origin, manifest, version tag and expected commit after confirmation. A settings-file lease serializes cooperating adapter calls; it does not grant broad file access or constrain Pi's subprocess. The adapter then invokes the current Pi distribution with fixed argv and verifies the result. Publication and runtime reload remain separate.

The [package activation contract](package-activation.md) owns setup, detailed checks and residual risk. In particular, native Pi package installation is not an atomic tag-and-settings transaction: manual commands and other writers bypass the adapter lock, and post-verification cannot prevent every concurrent or malicious outcome.

## Diagnostics and footer

The seven exact guard labels are `acquiring`, `implement`, `lazy`, `plan`, `conflict`, `lost`, and `unguarded`. Footers should keep a textual fallback for unknown future labels. `session-mode-leases` carries the committed worktree count and bounded names, e.g. `leases:2 api, web`; `session-mode-grants` appears only while exact files are held and reports `grants:N` with bounded basenames. The same bounded information appears in a widget above the editor, so custom footers need no modification. `/leases` and `/grants` expose the respective canonical identities, current requests and last failures. `/lease-holders` inventories every worktree and exact-file lock currently held in the same-user runtime directory from one `lslocks` scan, groups holders by the live parent process read from `/proc`, and marks the current session. Holder metadata is attached as `bound` only when its hash, holder pid and parent pid all match the kernel observation; otherwise the entry stays `missing`, `invalid` or `mismatch` with only the lock identity. Holders that exited after the scan are `gone`; other users' or unreadable processes and a non-private runtime directory are `unavailable`. The inventory covers this user's local runtime directory only, never another machine or an isolated runtime directory, acquires or releases nothing, and reads no workspace topology. Paths are data; C0/C1 terminal control characters are escaped, confirmation payloads that cannot display every identity within the bound are rejected, and oversized diagnostics are explicitly marked truncated.

The companion footer drops names before counts in narrow layouts. Its `🔒cwd` observation explicitly concerns cwd, not the entire workspace. The public single-root observer export stays compatible; the batch observer inspects explicit roots using one `lslocks` scan and returns held/free/unavailable results per input. Missing lock files are free; missing commands, invalid output and timeouts are unavailable, never proof of freedom. Observers never acquire locks or trust holder metadata.

The statusline suppresses its own holder during plan release. Explicit `/leases` inspection includes self-held locks. Production Git/lock-scan deadlines remain two seconds; real-kernel semantics tests use an explicit ten-second budget, while separate scripted tests pin production deadlines and failures.

## Explicit limitations

- Except for the dedicated `save_handoff` and `activate_pi_package` adapters, Bash, PowerShell, scripts, arbitrary wrapper tools and subprocess side effects are not covered by native path enforcement. Exact-file grants authorize only native `edit`/`write`; they do not confine Bash. File-only mode keeps the guarded Bash checker, but it remains intentionally bounded and allows unknown commands. Once a worktree is leased, the ordinary implementation shell boundary applies.
- Typed `!` / `!!`, `--no-extensions`, trusted extensions, other editors and machines can bypass the guard. Pi-subagents extension ceilings/lists may also omit this extension.
- Read-only guarded delegation retains its existing limits: no dynamic workflow fan-out, writer agents, alternative cwd, output authority or managed-worktree creation without implementation mode. Same-worktree writers contend rather than borrowing parent leases.
- Worktree-root locks do not lock shared Git administration across separate worktrees.
- Preflight/path checks are not atomic OS-level file isolation; hostile concurrent filesystem changes and custom tool overrides remain outside the guarantee.
- Package activation inherits Pi's package-manager behavior, including dependency scripts, mutable-tag TOCTOU and non-transactional concurrent settings updates. Its explicit allowlist, confirmation and post-checks reduce accidental activation; they are not a supply-chain sandbox.
- Lease and native-write enforcement have no Beads, Dolt, workspace.json or mgit runtime dependency.

## Runtime and distribution

Development pins Pi 0.85.1. Its reload path awaits session shutdown before resource reload/rebinding; the package drains acquisition and release there. Confirmed activation also treats the public `getAgentDir`/`getPackageDir` exports and package CLI entry as a version-tested compatibility seam; it never imports private package-manager modules. Native tests, real temporary Git/flock fixtures and isolated RPC installation checks cover scope transitions, loss, reload and restoration. Interactive footer checks supplement—not replace—those contracts. The scripted local provider fixture runs actual Pi native tool preflight, sibling execution and wrapper dispatch, validates tool-call/result pairing through in-turn checkpoints, and checks cancellation and reload without external model requests. Recheck on upgrades; an open host peer range does not certify future Pi behavior.

The optional reviewer discovery seam requires pi-subagents 0.68.0 or newer, which introduced the
compiled JavaScript package layout. Discovery eligibility alone never proves launch compatibility or
auth. It deep-imports `src/agents/agents.js` under the active Pi agent directory and expects
`discoverAgents(cwd, "both", provider)` to return `{ scope: "both", agents: [...] }`. This internal API
is not a stability guarantee. Keep absence, malformed definitions and unsafe contracts fail-closed;
do not vendor the resolver or turn discovery failures into approval.

Consumers use `@flurdy/pi-session-mode/lease-observer`; do not copy the implementation. Its new batch function supplements the existing single-root function. See the [README](../README.md) for installation, verification and downgrade boundaries.
