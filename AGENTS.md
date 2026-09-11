# Agent Instructions

## Development

- Use the Node.js version in `.nvmrc`.
- Use the root npm scripts for tests, typechecking, package checks, and immutable Git-install verification.
- Keep `package.json#files` and the public observer export as exact allowlists. Do not package tests, scripts, local configuration, runtime locks, or evidence.
- Preserve canonical-worktree lease identity, guarded policy, v1 mode entries, and explicit fail-open boundaries unless separately authorized.
- Treat the pi-subagents internal discovery import as an explicit compatibility seam; incompatible contracts must fail closed.
- Keep task-scoped tracking in the Coding Agent Workbench workspace Beads store; do not initialize a competing store here.

## Delivery

- Trunk-based local-main delivery; no pull requests for workspace work.
- Run `npm run check` and, after committing, `npm run verify:git-install`.
- Distribution/lifecycle changes also need a current-Pi interactive smoke in an isolated agent directory.
- Stage explicit paths and commit locally. Never push, tag, publish, or change a live installed extension link without explicit approval immediately beforehand.
- Keep generated output under ignored `.artifacts/`.
