# Confirmed package activation

`activate_pi_package` is a narrow convenience wrapper around Pi's documented `install` command. It updates one already-installed user-level Git package after checking an exact user-owned allowlist, binding the requested version tag to an expected commit, and obtaining a fresh TUI confirmation.

It does not publish source or tags, install new packages, update npm or project packages, remove duplicate sources, reload Pi, or provide a general write grant.

## Configure the allowlist

Create `~/.pi/agent/package-activation.json` yourself. Project files, prompts, model arguments, environment claims, and the tool caller cannot select a different policy file.

```json
{
  "version": 1,
  "packages": [
    {
      "key": "session-mode",
      "repository": "github.com/flurdy/pi-session-mode",
      "manifestName": "\u0040flurdy/pi-session-mode",
      "mutableExtensionPaths": ["extensions/flurdy-session-mode"]
    },
    {
      "key": "skill-model-router",
      "repository": "github.com/flurdy/pi-skill-model-router",
      "manifestName": "\u0040flurdy/pi-skill-model-router",
      "mutableExtensionPaths": []
    },
    {
      "key": "watch-loop",
      "repository": "github.com/flurdy/pi-watch-loop",
      "manifestName": "\u0040flurdy/pi-watch-loop",
      "mutableExtensionPaths": []
    }
  ]
}
```

Set the file to user-only write access (`chmod 600 ~/.pi/agent/package-activation.json`). The adapter rejects symlinks, hardlinks, another owner, and group/world-writable policy files.

Each key and repository must be unique. Version 1 accepts only GitHub `owner/repository` identities, strict package names, and optional exact `extensions/<name>` paths whose presence blocks activation. The existing settings source must combine canonical `git:github.com/owner/repository` shorthand with a literal at-sign followed by a strict `vX.Y.Z` suffix; alternate Git URL forms are recognized for duplicate rejection, not silently converted. JSON inputs are capped at 1 MiB. The file grants authority to update those package identities, so review every change. It is read only when the tool is called and is never created or modified by the extension.

## Activation contract

The tool accepts:

- `package`: an exact allowlist key;
- `version`: a strict `vX.Y.Z` tag;
- `expectedCommit`: a lowercase full 40-character commit SHA.

Before confirmation it requires:

- interactive TUI mode;
- live session-mode `implement` state with at least one held worktree lease;
- no guard bypass, scope transition, shutdown, or other adapter activation;
- exactly one matching user package source, already pinned to a strict version tag;
- a canonical, clean managed checkout with the allowlisted origin and matching manifest;
- no configured mutable duplicate extension path;
- the remote tag's peeled commit matching `expectedCommit`.

The confirmation displays the current and requested sources and commits, user settings path, and managed checkout path. Decline or timeout starts no installer. After confirmation the extension reacquires the evidence, obtains a temporary exact-file lease for user settings, and invokes the current Pi distribution through its Node and CLI paths with fixed argv. An existing exact-file grant for settings therefore blocks activation until that grant is released. Terminal Git/SSH prompts are disabled; configured credential helpers may still provide credentials. Once Pi starts, cancellation does not terminate it halfway through an update. Normal shutdown/reload waits for the installer; a forced process termination can still leave a partial update.

After Pi exits successfully, the wrapper verifies the configured source, checkout commit, origin, manifest name/version, duplicate path absence, and that unrelated pre-existing settings entries still match its snapshot. Verification failure is reported without automatic cleanup or broad settings restoration. Run `/reload` separately after inspecting the result.

## Residual trust boundary

This wrapper deliberately reuses Pi's package manager instead of maintaining a second installer. It therefore inherits Pi 0.85.1 behavior and these limitations:

- Pi's settings update is not transactional with every concurrent settings writer.
- A tag can move between the wrapper's final remote check and Pi's internal fetch. Post-verification detects the resulting checkout mismatch but cannot undo code already executed.
- Manual `pi install` and `pi update`, editors, other extensions, and hostile same-user processes do not honor the adapter's lease. Agent directories inside a Git worktree are conservatively unsupported because their settings cannot receive an exact-file lease.
- Global or checkout Git configuration can rewrite transport URLs. `getPackageDir()` also honors Pi's startup-time `PI_PACKAGE_DIR`; the wrapper trusts the package directory selected by the running host.
- Dependency installation may execute scripts from the reviewed package and its resolved dependencies. Pi cleans ignored files such as `node_modules` in its managed checkout; do not store personal data there.
- Updating a package changes files beneath any running process using that checkout; activation never implies runtime reload.
- Installed Pi extensions execute with full user permissions. Neither the allowlist nor session-mode is an operating-system sandbox.

If stronger atomic tag binding, cross-writer settings transactions, staged checkout promotion, or crash recovery becomes required, wait for a supported upstream transactional package API rather than expanding this wrapper into another package manager.
