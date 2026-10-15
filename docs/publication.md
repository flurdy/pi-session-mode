# Attended commit publication

`publish_commit` publishes one exact, freshly confirmed commit to its same-name upstream branch without a source-writer lease. It exists so an attended release flow can push a READY service while other sessions keep coding in unrelated checkouts. Writer leases coordinate source edits; they are neither required nor acquired for publication.

It is not a general push tool. It never forces, publishes tags or extra refs, runs make recipes, retries, or decides whether a release is wise. Release readiness, ordering and state tracking stay with the calling skill.

## Two phases

**Confirm** takes a canonical absolute worktree `root`, the expected tip `commit` (lowercase hex, 7–64 characters) and optional `context` of at most 500 characters. Preflight then requires:

- the exact canonical worktree top-level, not a subdirectory or symlink alias;
- a checked-out branch whose tip matches `commit` uniquely;
- `branch.<name>.remote` naming a remote and `branch.<name>.merge` equal to the same branch;
- no conflicting `branch.<name>.pushRemote` or `remote.pushDefault`, no `remote.<name>.push` mapping, mirror or custom `receivepack`;
- exactly one resolved push URL (`git remote get-url --push --all`);
- an existing local tracking ref `refs/remotes/<remote>/<branch>` that is an ancestor of the tip.

Missing or unsupported configuration fails closed before any dialog. The native TUI confirmation shows the worktree, branch, full commit, redacted destination and ref, commits beyond the local tracking ref (first 20), pre-push hook presence, SSH mode, advisory writer-lease occupancy and the caller context labelled unverified. Occupancy is information for the human and the release skill, not authority. RPC and headless calls are denied; decline or the 60-second timeout authorizes nothing.

Approval returns a random single-use token, held only in this session's memory for two minutes. Session start, replacement, reload and shutdown discard every token. Tokens are never persisted, inherited or valid in another session.

**Execute** accepts only the token. It repeats the whole preflight and compares a digest of the identity, push URL, complete effective Git configuration, SSH environment and hook presence. Any drift, or cancellation before launch, returns `stale` without pushing; confirm again. Only one confirm or execute operation runs per session at a time, and the tool is refused inside parallel tool wrappers in every guard state, including when the guard is disabled.

The push uses fixed argv:

```text
git push --porcelain --no-follow-tags --recurse-submodules=no --no-signed <remote> <full-sha>^{commit}:refs/heads/<branch>
```

`^{commit}` forces object lookup; a bare hexadecimal source would prefer a branch or tag with that name.

Git rereads configuration when the push starts, and that read cannot be frozen. An acknowledgement only counts when Git's reported `To` destination equals the approved push URL (ignoring the userinfo Git anonymizes). After the push the tool also reads configuration, push URL and SSH environment again. A different destination or any change since the final preflight turns the receipt into `unknown`, because the actual destination is then unverified.

## Receipts

`commit-publication/v1` receipts carry the identity plus one status:

| Status | Meaning |
|---|---|
| `ok` | The remote acknowledged the expected ref update. A local tracking-ref update error becomes a `warning`. |
| `uptodate` | The remote already had this commit; there is no new rollout baseline. |
| `rejected` | The remote refused the update, for example non-fast-forward or fetch first. |
| `failed` | Git could not be started; nothing was pushed. |
| `stale` | Identity, tip or configuration changed, or the session ended before launch; nothing was pushed. |
| `unknown` | No acknowledgement for the expected ref (including pre-push hook failure, unreachable remote and deadline expiry), or configuration changed while the push ran. |

Treat `unknown` as possibly published: hold further publication for that service until a human reconciles it. Never retry automatically. Diagnostics are bounded and control characters escaped. URL userinfo, queries and fragments are redacted in destinations, summaries and diagnostics.

## Environment and trust boundary

Every Git call removes inherited location and configuration overrides (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG*`, `GIT_EXEC_PATH` and similar), askpass programs and terminal prompts, and allows only `file`, `git`, `http`, `https` and `ssh` transports. An explicit `GIT_SSH_COMMAND`, `GIT_SSH` or `core.sshCommand` is respected; otherwise SSH runs in batch mode with a ten-second connection timeout.

Pre-push hooks, credential helpers and configured SSH commands are trusted user code, not confined subprocesses. Once launched, a push drains to completion even if the tool call or session is cancelled; shutdown and reload wait for it. Only the deadline (two minutes) terminates its process group, and that outcome is `unknown`.

The guarded Bash checker also recognizes conventional `make`/`gmake` push targets as remote Git mutations and points to this tool. That check is bounded pattern recognition, not recipe confinement; renamed targets and arbitrary scripts remain outside the guard's guarantee and are never an authorization path.

Repository rules that require a Git wrapper are not waived by this tool. Callers must settle such rules with the repository owner before using it there.
