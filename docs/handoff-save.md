# Fixed-destination handoff saves

`save_handoff` is an operation-specific exception to the [guard](guard.md), not a directory
or native-file grant. It is available in plan, conflict, acquiring, lost, file-only,
implementation and unguarded sessions. Installing this reviewed extension makes the capability
available across sessions; no per-handoff `/grant-file` or repository lease is needed.
It changes no scope selection, checkpoint, active native tools or source-write authority.

## Contract

Arguments are `date` (`YYYY-MM-DD`), `time` (`HH:MM`), `slug` (lowercase kebab-case, at most
120 characters), and `content` (the exact rendered resume block, at most 64 KiB UTF-8).
Optional `overwriteSha256` requests replacement, not approval. No path, helper, command,
environment or directory argument is accepted, including through parallel wrappers.

The destination is the runtime user's canonical home plus
`.claude/handoffs/{date}-{slug}.md`. Only the two missing handoff directories may be created,
with mode `0700`; existing directory permissions are not changed. Symlinked directories,
symlink/non-regular/hardlinked targets and filesystem-detectable Git ownership are rejected.
The existing file-identity resolver remains authoritative for cooperative non-Git ownership.

The adapter reads the installed
`~/.agents/skills/wrap-up/scripts/save-handoff.py`, compares it to an exact reviewed SHA-256
in `handoff-save.ts`, then executes those checked bytes with Python's isolated mode, fixed argv
and content on stdin. It does not run a shell or execute a re-opened mutable helper path.
Python 3.10+ and the compatible installed wrap-up helper are required. Helper changes require
review and an adapter-digest update; neither the model nor project configuration can override it.
The helper in [agent-skills](https://github.com/flurdy/agent-skills/tree/main/skills/wrap-up)
remains the sole implementation of resume validation, atomic installation, rollback and
read-back verification; this package does not copy it.

Each mutation participates in Pi's per-file queue and takes a temporary exact-file kernel lease.
Distinct target filenames do not contend. The lease is released after each call, including
failure; it is never added to `/grants` or persisted as session authority. An existing writer
lease on the same target blocks the operation; the adapter never steals or borrows that lease.
A collision returns `status: "collision"`, `existingSha256` and `suggestedSlug`, without changing
existing bytes. Select a new slug or explicitly request overwrite; no automatic renaming.

Overwrite requires a fresh 60-second **native TUI confirmation** naming the canonical target,
old hash, replacement hash and replacement size. RPC/headless overwrite is unavailable. The
adapter checks the old bytes before the dialog and the helper checks the approved hash again
under the temporary lease. Cancellation, decline, timeout or a changed target never establishes
approval. Confirmation does not grant later replacements.

A success returns a bounded `wrap-up-save/v1` receipt with `status: "saved"`, canonical `path`,
`mode`, `sha256`, and `bytes`. The adapter verifies the helper exit status, schema, target,
mode, submitted digest/length and actual saved bytes before returning success. Failure throws
an unverified-save error; recovery-copy paths are retained when reported. Never retry a failure
blindly, infer absence, or fall back to shell/native writes. Sanitization of the submitted prose
remains the caller's responsibility; this is not a secret scanner or a semantic completeness check.

Cancellation is honoured through queueing, confirmation and preflight. Once the short atomic
helper process starts it drains on cancellation/reload/shutdown rather than being interrupted
between replacement and verification; it has a ten-second deadline and bounded output. A forced
termination or timeout can still leave an unverified file or recovery copy. All pending operations
are drained before the extension shuts down; obsolete sessions cannot start a new save.

## Verification and rollout

- `npm run check` covers tool registration, guard-state policy, lifecycle and the exact package
  allowlist. Filesystem/helper tests run when the helper is installed; otherwise they explicitly
  skip. Set `HANDOFF_SAVE_HELPER=/absolute/agent-skills/skills/wrap-up/scripts/save-handoff.py`
  to require that exact helper in a cross-repository run.
- With that variable set, `npm run verify:git-install` also exercises guarded saves via the real
  Pi tool dispatch in isolated homes using a local scripted provider, not an external model.
- For the current installed host rather than npm's pinned development binary, run
  `PI_VERIFY_HOST_VERSION=<exact-version> node scripts/verify-dynamic.mjs` outside `npm run`,
  with `HANDOFF_SAVE_HELPER` set. The script checks and reports that exact host version.
- Exercise the native overwrite confirmation in a current-Pi isolated TUI before activation;
  fake-dialog tests or RPC refusal alone do not prove the interactive user experience.
- Publish/activate a reviewed extension version and reload each running Pi session separately.
  A skill edit does not upgrade an already-loaded extension. Old sessions without the tool must
  report unsaved rather than use the shell helper as a Pi fallback.

This remains a cooperative same-user guard, not a filesystem sandbox. The pinned helper and
canonical checks reduce accidental misuse, but manual writers, hostile parent-directory swaps,
external content races, marker-less Git layouts, custom tool overrides and forced process death
remain outside transactional isolation. File leases coordinate only cooperating same-machine
writers. No promise is made that all saves succeed: permission errors, full disks, contention,
missing runtimes or changed helpers must remain visible failures.
