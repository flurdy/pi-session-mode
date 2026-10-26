# Attended folder grants and admin runs

Two separate capabilities let a running session do approved work outside Git worktrees without a restart, a global guard bypass, an unrelated repository lease or copy-paste handoffs back to the user:

- `/grant-folder` lets the native `edit`/`write` tools create and change files beneath confirmed non-Git folders.
- `run_admin` runs one exact bash script or argv command after a fresh native confirmation.

Neither changes the bounded Bash policy, and neither is a sandbox. `run_admin` is trusted execution of an approved command: its effects are not confined to the folders it declares.

## Folder scopes

Both capabilities take folder scopes. A scope is an existing canonical directory, or one missing leaf beneath an existing canonical directory. Rejected:

- `/`, the user's home directory and any of its ancestors;
- the private lease runtime directory, or any folder containing or inside it;
- anything inside a Git worktree or Git administration, and folders named `.git`;
- folders containing a `.git` entry, found by a scan that does not follow symlinks. Folders with more than 20,000 entries are refused as too large to verify; grant a narrower folder.

At most 16 folders are granted at once.

## `/grant-folder`

`/grant-folder <paths…>` resolves the folders, shows their canonical identities in a 60-second TUI confirmation and acquires their leases. Like `/grant-file` it is TUI-only, idle-only and unavailable while the guard is disabled. From plan it starts a grant-only implementation scope; in lazy or implement mode it keeps the current worktree intent.

A native write beneath a granted folder is checked by a folder-bounded resolver:

- Worktree ownership is checked first: files in a repository inside the folder follow repository rules, and a grant-only session cannot acquire that worktree.
- Missing parent directories may be created only inside the grant, or as the granted missing leaf itself.
- Symlink escapes, dangling links, hardlinked files, directory targets, Git administration names and bare-repository markers are rejected.
- Allowed targets are rewritten to their canonical path, as for exact-file grants.

`/revoke-grants [paths…]` releases the named exact-file and folder grants, or all of them, and keeps worktree leases. A grant-only session with nothing left returns to plan. `/plan` still releases everything.

Folder grants persist in a v5 selection record after a v1 plan checkpoint, and restore without another prompt on reload or resume. A changed canonical identity guards the session to plan. Releases that only understand v4 or older records read v5 as invalid and restore guarded plan. `/grants`, `/lease-holders` and the `grants:N` status show folders with a trailing `/`.

## `run_admin`

`run_admin` is an agent tool. It takes:

| Field | Meaning |
|---|---|
| `purpose` | One-line reason, 1–300 characters, shown in the dialog. |
| `cwd` | Absolute working directory. |
| `writes` | 1–16 non-Git folders the run is expected to change. Nested declarations collapse to the outermost folder. |
| `script` | A bash script, at most 200 lines and 16 KiB, run as `bash --noprofile --norc -c <bytes>`. |
| `argv` | A command and arguments, run without a shell. Exactly one of `script` or `argv` is required. |
| `timeoutSeconds` | Deadline from 1 to 900 seconds; default 120. |

It is available in lazy, grant-only and implement sessions. It is refused in plan, conflict, lost, acquiring and unguarded sessions, when the guard is disabled, from RPC, headless or child sessions, inside parallel wrappers, and while another write, scope transition, package activation, publication, release or admin run is active.

### Before the dialog

- The executable is resolved through `PATH` (bare names) or as an absolute path, and shown canonically. `argv[0]` is preserved for multi-call programs.
- A repository-backed `cwd` must be clean: committed `HEAD`, no tracked changes and no untracked non-ignored files. Run repository recipes through `argv` with `cwd` set to the recipe directory; `make -C`, `--directory`, `-f` and `--file` are refused so the bound recipe is the one that runs.
- Recognizable Git mutations, `gh`, publication (`make` push targets), workspace and Beads/Dolt remote synchronization, and privilege escalation (`sudo` and similar) are refused. Repository changes need `/implement`, publication uses `publish_commit`, and synchronization keeps its own confirmation. Commands are recognized by their words, including quoted subcommands and commands after shell keywords such as `then` or `do`. This is still bounded pattern recognition: effects hidden in scripts or recipes are not comprehensively detected.
- A declared folder that contains one of the session's exact-file or folder grants is refused; revoke the grant first. A declared folder inside a held folder grant reuses that grant.

### Dialog

The 60-second native confirmation shows the purpose, the full script and its SHA-256 (or the resolved executable and arguments), the working directory and its repository binding, each declared folder (existing or missing), flagged lines that delete, overwrite or recursively change permissions, and the deadline. It states that effects are not confined to the declared folders. Approval authorizes exactly that command once; there is no session-wide allowance. Declining or letting the dialog time out runs nothing and takes no lease.

### Launch and execution

After approval the tool rechecks the session and takes transient `dir-` leases on the declared folders. It then rebinds every displayed fact: canonical cwd, declared folder identities and whether each exists, repository `HEAD` and cleanliness, and the executable. Contention or any change refuses or returns `stale`; nothing runs and nothing is retried.

The command runs in its own process group with stdin closed and `GIT_TERMINAL_PROMPT=0`. Cancellation, the deadline, loss of any declared lease, loss of the session's scopes, reload and shutdown send `SIGTERM` to the group, then `SIGKILL` after two seconds. Group members left after the main process exits are killed and reported as `lingering`; start long-lived services through their own managers. The receipt waits (bounded) until no group member remains and reports any survivor. Leases, including a reused folder grant after a scope loss, are released only after the process group has ended.

### Receipts

`admin-run/v1` receipts carry the purpose, cwd, declared folders, script digest or argv, and one status:

| Status | Meaning |
|---|---|
| `ok` | Exit status 0. |
| `failed` | Non-zero exit, or the command could not be started. |
| `declined` | Declined or timed out in the dialog; nothing ran. |
| `refused` | Refused before running: state, shape, recognizable refusal, contained grant or lease contention. |
| `stale` | The session, a lease or a displayed fact changed after approval; nothing ran. |
| `interrupted` | Terminated by cancellation, deadline, lease loss or shutdown; effects are partial or unknown. |

Receipts include the exit code, signal, duration and the last 16 KiB of combined output with control characters escaped. Never retry automatically; report the receipt.

## Leases and coordination

Folder grants and declared run folders use a `dir-<sha256>` lock namespace. A folder takes an exclusive lock on itself and shared intent locks on each grantable ancestor (root, home and home ancestors are skipped). Exact-file grants take the same ancestor intents, so a folder lease contends with every grant inside it, and with any grant on an ancestor folder, across sessions, without enumerating descendants. Within a session, intents are shared and reference-counted. Losing any holder loses the whole grant and revokes the session's authority at once. Surviving holders stay locked until any interrupted admin run has ended, and only then are they released.

Worktree leases and the public observer are unchanged. Two coordination gaps remain:

- A repository created inside a granted folder after the grant is not detected across sessions. The holding session itself refuses to acquire a worktree inside or containing its folders.
- Sessions running an older guard take no intent locks. Overlaps with their file grants go undetected until every session on the machine reloads the same version. Roll out and roll back by reloading all sessions together.

`save_handoff` and `activate_pi_package` take temporary exact-file leases. A folder grant covering their target blocks them, just as an exact-file grant on the target does.

## Trust boundary

Approved scripts and recipes run with the user's full permissions. Ignored files, `PATH` tools, user configuration, credential helpers and hooks remain trusted inputs that the repository binding does not cover. Folder grants confine only native edit/write. Other extensions, editors, users and machines are not confined, and hostile same-user filesystem races remain outside the guarantee. If real write confinement becomes necessary, a sandboxed variant (for example bubblewrap or Landlock) would be a separate decision.
