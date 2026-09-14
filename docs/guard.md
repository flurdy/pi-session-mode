# Guard and lease contract

The current contract uses explicit, incrementally growing sets of canonical Git-worktree leases and confirmed exact-file grants outside Git. It is a cooperative, same-user/same-machine accidental-change guard, not filesystem isolation or a security sandbox.

## Scope selection

| Action | Result |
|---|---|
| Fresh session / bare `/implement`, no leases | Request the cwd Git worktree. |
| Bare `/implement` with a healthy set | No-op; keep existing scopes. |
| `/implement path-a path-b` | Add the named roots; never implicitly add cwd. |
| Native `edit`/`write` in a healthy repository implementation session | Acquire missing canonical target worktrees without another prompt, then revalidate the write. |
| `/grant-file path-a path-b` | Resolve exact non-Git files, require interactive confirmation, then add their file leases. |
| `/plan` | Guard writes, cancel/drain acquisition, release every worktree and file lease, clear selection. |
| `/leases [paths...]` | Read-only worktree diagnostics, or explicit occupancy inspection. |
| `/grants [paths...]` | Read-only file-grant diagnostics, or canonical identity inspection. |

Explicit `/implement` paths must identify existing worktree roots or their symlink aliases. Subdirectories are rejected rather than silently broadening to an ancestor. Paths are quoted literals, with no shell execution, variable substitution or glob expansion. File URLs can represent unusual literal characters. The startup string flag `--lease-roots` accepts a JSON array.

`/grant-file` accepts only exact non-repository files after showing the complete bounded canonical set in a fresh TUI confirmation. It is TUI-only (RPC and headless calls are denied), unavailable while the guard is disabled, and expires after 60 seconds. Session identity plus idle/pending-message state are checked again after the dialog. Existing regular files must have exactly one filesystem link. A missing leaf is accepted only beneath an existing canonical directory; missing parents are rejected because native `write` would otherwise create unleased directories. Existing symlink aliases resolve to their targets and share one identity. Directories, hardlinks, dangling links, loops, special nodes, paths beneath `.git`, reserved Git marker names, filesystem-marker-detectable worktree files, and bare or malformed Git-administration shapes fail closed. Git command failure is never evidence that a target is safe non-repository state; independent filesystem marker checks must establish it. Marker-less or externally redirected worktrees cannot be discovered from an ordinary target path and remain outside the guarantee.

Worktrees and files each have an independent limit of 32. Each combined addition has a ten-second cancellation deadline; cleanup may require draining pending process termination before returning. Confirmation evidence is rebound during acquisition: changed canonical identities fail before any new scope is published.

`--plan` wins as a per-launch guarded override; use `/plan` to clear saved selection. Successful explicit startup roots and `--implement` selections are checkpointed for later restoration. Explicit startup roots replace restored selection; explicit `--implement` without roots selects cwd. The existing `pl` picker can select plan mode, followed by scoped `/implement` commands; it does not need to discover workspace topology.

`/new` starts an empty session rather than inheriting interactive `/plan` selection. Without an explicit startup override, it attempts the cwd lease. If another live session holds that worktree, the replacement stays guarded in `conflict`; the warning identifies the root without exposing holder metadata. Use `/leases` to inspect, `/plan` for read-only work, or `/implement <root>` for a disjoint worktree. A failed addition reports retained leases only when a healthy prior set remains.

Two plain workspace-root implementation sessions still contend. To work concurrently, choose disjoint member scopes. Workspace files require the workspace lease; tracking-only local Beads operations remain permitted without it. A Beads store identifies tracking ownership, not every source repository a task needs. Claims and `/next` selections have no runtime lease side effect; a subsequent concrete native write is the dynamic trigger.

## Kernel authority and transitions

The identity remains SHA-256 of the canonical Git top-level path. Git's answer must match the nearest filesystem `.git` marker. Ambient location overrides, redirected `core.worktree` configurations and marker-less setups that disagree are unavailable, not alternate ownership. Normal clones, linked worktrees and initialized submodules remain supported. Each root has a stable private-runtime `flock` file plus diagnostic-only holder metadata. The fixed holder process publishes a ready handshake only after metadata publication. No JSON file or tracker claim proves ownership.

Worktree lock filenames and the public observer remain unchanged. File locks use a separate `file-<sha256>` namespace keyed by the canonical exact path. Both kinds reuse the fixed holder process and metadata-publication handshake; metadata is diagnostic only.

The controller keeps one combined committed live set H and transaction-local acquisitions N. It validates, canonicalizes, deduplicates and sorts targets, then acquires missing worktrees and files sequentially and nonblockingly. Explicit mode commands temporarily guard writes; dynamic tool preflight does not change the active tool list or visible implement state. It publishes the union only after all handles and the scope checkpoint are valid. A failed addition drains N and retains healthy H. Per-handle release promises are separate from the aggregate drain barrier.

Different overlapping transitions are rejected; identical explicit requests share their operation. User scope commands require Pi to be idle with no pending messages. Dynamic acquisitions run inside native tool preflight and use its blocking result instead of waiting for idle; simultaneous dynamic requests fail busy rather than queuing. Superseded callbacks cannot publish scope, restore tools or persist success. Unexpected loss of any handle guards immediately, invalidates the operation, drains the entire set and reports `lost`.

There is no waiting/retry loop, stealing, preemption, idle expiry, completion-triggered release or individual release. Two sessions holding opposite roots may both fail to expand; one must voluntarily enter `/plan`. Sorting does not eliminate this human coordination stand-off. Shutdown, reload and session replacement drain all handles; children do not inherit authority. Release closes the holder pipe, then force-terminates that owned child after one second if necessary and still waits for close. A failed drain remains fail-closed rather than being treated as successful cleanup.

## Guarded states and native paths

Plan, conflict, lost and acquiring states hide and independently block native edit/write tools. They retain the existing bounded Bash mutation policy and verified read-only subagent policy. Missing/incompatible reviewer discovery stays fail-closed. Scope transitions and UI reporting do not weaken these guards.

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

This deliberately replaces released 0.2.1's explicit-only expansion policy. A healthy `implement` session with at least one held worktree may acquire additional canonical owners identified by native `edit`/`write` arguments. This includes implicit-cwd sessions, nested repositories, symlinked workspace members and siblings outside cwd. There is no topology-file or tracker authority. Consequently, an accidental write to another valid, uncontended repository can acquire that repository; leases are coordination, not a wrong-repository safety boundary.

Plan, conflict, acquiring, lost, unguarded and file-only sessions never auto-expand. Reads, Bash, arbitrary tools and subagent cwd requests are not triggers. Existing explicit `/implement` and `/grant-file` controls remain available. A candidate root containing any held exact-file grant is rejected for explicit reselection, so a newly initialized Git repository cannot silently convert a file grant into repository authority.

Preflight first validates every supported nested call and collects canonical missing owners. Malformed wrappers/native arguments, unknown nested tools, ungranted non-repository files, unavailable identity or an oversized combined set take no new leases. A complete wrapper's missing roots are acquired as one transaction, with the unchanged 32-root limit. Separate assistant sibling calls are independently preflighted by Pi before execution in parallel mode; a failed sibling does not roll back a different sibling's completed acquisition. Sequential calls use the same gate.

Generation, live-set revision, origin cwd and cancellation are checked before acquisition and again in the persistence callback. The tool's abort signal and a ten-second acquisition deadline cancel and drain pending additions. Active tools remain unchanged during this preflight. On commit, the full worktree set is saved as explicit roots with canonical origin cwd, retaining file selections via v3 when needed. Existing explicit origin must match rather than being silently replaced.

After acquisition, the original call is checked afresh against the committed set and revision. A retargeted path is blocked, not repeatedly auto-acquired. If the tool is aborted or fails after acquisition has committed, those roots remain held and selected until `/plan`; no individual release is implied. A loss or shutdown cannot be overridden by a late preflight completion. This remains the existing cooperative, non-atomic preflight-to-write boundary, not filesystem isolation.

## Failure and persistence

`/plan` saves its checkpoint immediately after guarding, before release and bounded advisory dirty checks. A checkpoint failure never prevents release; it is reported, and a restart should explicitly use `--plan` if saving failed.

Empty explicit requests that fail leave no authority and save a safe plan checkpoint. Contention shows `conflict`; invalid/unavailable explicit paths never silently fall back to cwd or unguarded operation. Failed additions with healthy prior roots preserve those roots and their selected scope. A partially written compatibility checkpoint may restore more conservatively to plan.

Legacy implicit-cwd infrastructure failures retain their prominent `unguarded` fail-open behavior. In particular, a non-Git coordination directory starts unguarded and bypasses native path checks; start with `--plan` or select explicit valid Git roots instead. Implicit cwd contention retains implementation intent for a future fresh acquisition. `PI_SESSION_GUARD=0` explicitly bypasses the guard and never claims successful scoped ownership.

V1 mode entries remain readable. V2 records distinguish plan, implicit cwd and explicit worktree roots with originating cwd. Worktree-only selections continue to write v2. A selection containing exact files writes a v3 combined record after a v1 plan checkpoint; v2 readers reject that newest unknown record into plan rather than restoring only its worktrees. Only canonical selection is persisted; handles and ownership are not. Unknown or malformed newest records do not fall through to older authority.

Changed originating cwd, missing roots, changed file identities, new Git ownership, changed link counts, or unavailable markers require guarded reselection. Restored identities are checked before acquisition, and each explicit acquisition checks its expected identity before taking a lock. Canonical saved paths are passed as file URLs rather than reinterpreted through user-input whitespace normalization. Restoration and reload reacquire; new sessions and forks never inherit locks. Explicit startup `--plan`, `--implement`, or `--lease-roots` selections do not implicitly restore file grants.

## Diagnostics and footer

The six exact guard labels remain `acquiring`, `implement`, `plan`, `conflict`, `lost`, and `unguarded`. `session-mode-leases` carries the committed worktree count and bounded names, e.g. `leases:2 api, web`; `session-mode-grants` appears only while exact files are held and reports `grants:N` with bounded basenames. The same bounded information appears in a widget above the editor, so custom footers need no modification. `/leases` and `/grants` expose the respective canonical identities, current requests and last failures. Paths are data; C0/C1 terminal control characters are escaped, confirmation payloads that cannot display every identity within the bound are rejected, and oversized diagnostics are explicitly marked truncated.

The companion footer drops names before counts in narrow layouts. Its `🔒cwd` observation explicitly concerns cwd, not the entire workspace. The public single-root observer export stays compatible; the batch observer inspects explicit roots using one `lslocks` scan and returns held/free/unavailable results per input. Missing lock files are free; missing commands, invalid output and timeouts are unavailable, never proof of freedom. Observers never acquire locks or trust holder metadata.

The statusline suppresses its own holder during plan release. Explicit `/leases` inspection includes self-held locks. Production Git/lock-scan deadlines remain two seconds; real-kernel semantics tests use an explicit ten-second budget, while separate scripted tests pin production deadlines and failures.

## Explicit limitations

- Bash, PowerShell, scripts, arbitrary wrapper tools and subprocess side effects are not covered by native path enforcement. Exact-file grants authorize only native `edit`/`write`; they do not confine Bash. File-only mode keeps the guarded Bash checker, but it remains intentionally bounded and allows unknown commands. Once a worktree is leased, the ordinary implementation shell boundary applies.
- Typed `!` / `!!`, `--no-extensions`, trusted extensions, other editors and machines can bypass the guard. Pi-subagents extension ceilings/lists may also omit this extension.
- Read-only guarded delegation retains its existing limits: no dynamic workflow fan-out, writer agents, alternative cwd, output authority or managed-worktree creation without implementation mode. Same-worktree writers contend rather than borrowing parent leases.
- Worktree-root locks do not lock shared Git administration across separate worktrees.
- Preflight/path checks are not atomic OS-level file isolation; hostile concurrent filesystem changes and custom tool overrides remain outside the guarantee.
- No runtime dependency on Beads, workspace.json or mgit is introduced.

## Runtime and distribution

Development pins Pi 0.85.1. Its reload path awaits session shutdown before resource reload/rebinding; the package drains acquisition and release there. Native tests, real temporary Git/flock fixtures and isolated RPC installation checks cover scope transitions, loss, reload and restoration. Interactive footer checks supplement—not replace—those contracts. The scripted local provider fixture runs actual Pi native tool preflight, sibling execution and wrapper dispatch, validates tool-call/result pairing through in-turn checkpoints, and checks cancellation and reload without external model requests. Recheck on upgrades; an open host peer range does not certify future Pi behavior.

The optional reviewer seam was checked with pi-subagents 0.65.1. It deep-imports `src/agents/agents.ts` under the active Pi agent directory and expects `discoverAgents(cwd, "both", provider)` to return `{ scope: "both", agents: [...] }`. This internal API is not a stability guarantee. Keep absence, malformed definitions and unsafe contracts fail-closed; do not vendor the resolver or turn discovery failures into approval.

Consumers use `@flurdy/pi-session-mode/lease-observer`; do not copy the implementation. Its new batch function supplements the existing single-root function. See the [README](../README.md) for installation, verification and downgrade boundaries.
