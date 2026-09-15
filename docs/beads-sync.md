# Trusted routine Beads synchronization

`sync_beads_store` permits explicit routine synchronization of a user-enrolled Beads store in plan or implement mode, without acquiring source worktree leases or changing mode. It is a cooperative accidental-change guard, not a sandbox.

## Enroll trust

Resolve the owning store through the shared Beads workflow. In an interactive TUI:

```text
/trust-beads-sync "/absolute/owning/store" origin
```

The confirmation shows the canonical store/database, exact remote URL, expanded Git transport URL, file-remote identity, branch, server endpoint, connection fingerprint and executable/schema versions. After fresh revalidation, it saves that binding to private `beads-sync.json` under Pi's runtime-provided agent directory. Enrollment does not synchronize the store or change its remote configuration.

The version-1 file must be a regular, single-link, user-owned `0600` file outside Git. Missing or changed authority fails closed. Re-enroll after a supported identity change; remove the binding to revoke it. Project files, a configured URL, model assertions, source leases, Git publication permission and earlier tool results do not enroll trust. Nothing is enrolled during installation.

## Supported state

The adapter is verified with **Beads 1.2.2 (53 migrations), Dolt 2.3.1 and Pi 0.85.1**. Unsupported versions need an implementation compatibility review, not merely re-enrollment. Supported storage is canonical `.beads/embeddeddolt` or `.beads/dolt`, with matching SQL/on-disk database and remote identities. Redirected storage and embedded URL credentials are refused.

All versioned working state must be clean, including the `config` table. The tool never commits pending work to make synchronization possible. Server-mode `bd dolt commit` can leave configuration changes pending; those require separate review, not automatic inclusion in a push.

Automatic backups, exports and Git-add settings must be disabled for this boundary; it does not change those settings. Its subprocesses suppress Beads/Git hooks and Beads auto-commit/auto-push. The explicit `no-push` setting remains authoritative. Authentication uses the installed CLI's existing configuration; there is no credential provisioning or authentication fallback.

## Routine operations

Call the tool directly with one `action` (`fetch`, `pull` or `push`), the resolver-proven `directory`, and enrolled `remote` name. Do not wrap it in a parallel call or imitate it with a shell script.

| Action | Execution and verification |
|---|---|
| `fetch` | Native `dolt fetch` from the bound database directory, with an explicit remote and branch refspec. Verify the remote-tracking hash and unchanged clean local HEAD. |
| `pull` | Fetch, pin both commit hashes, reject schema/migration drift and prospective conflicts, recheck the clean local branch, then run `bd vc merge <exact-hash>` without a resolution strategy. Beads owns derived-state recomputation. Verify clean state and ancestry from both original commits. |
| `push` | Fetch and prove the remote is an ancestor of the intended local commit; recheck identity/state and `no-push`, then run non-force `bd dolt push --remote <name>`. Fetch again and require the remote hash to equal the intended commit. |

The private configuration lock serializes cooperating calls. Trust, cancellation, session identity and lock liveness are checked before every subprocess. Store, endpoint, branch, configuration and executable identities are revalidated before transfers/mutations and during verification. Skipped operations are labelled `skipped`, not verified publication.

Beads 1.2.2 has no `bd dolt fetch`. Its `federation status` command fetches even with `--readonly`, and its server implementation requires a federation peer record. The adapter does not use it or create peer records. Read-only SQL inspections use the bound Dolt executable in embedded mode and `bd sql` in server mode.

## Failures and limits

No force, reset, conflict resolution, migration, bootstrap, remote repair, backup publication, source Git push or production operation is authorized. Raw remote/destructive commands retain their existing gates, including federation fetches. Routine permission never triggers synchronization during listing, resolution, local triage or another read-only workflow.

Failures report the execution phase without exposing raw CLI output that might contain credentials. There are no automatic retries or recovery commands. Cancellation/revocation prevents later steps; an already-started transfer or merge may have effects. A post-operation failure is not reported as an untouched store: inspect the state before retrying.

Other processes, machines, raw shells, trusted extensions and user-managed transport/DNS configuration remain outside this cooperative guard. External writers can race between checks and execution; the lock is not database isolation. SSH behavior and authentication remain owned by the existing user configuration. Tests use disposable local remotes, not live Git-hosted remotes.
