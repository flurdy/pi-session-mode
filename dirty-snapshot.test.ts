import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureDirtySnapshot, compareDirtySnapshots, type DirtySnapshot, type DirtySnapshotLimits } from "./dirty-snapshot.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}

async function repo(run: (root: string) => Promise<void>): Promise<void> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "dirty-snapshot-")));
	try {
		git(root, "init", "-q", "-b", "main");
		git(root, "config", "user.email", "fixture@example.invalid");
		git(root, "config", "user.name", "Fixture");
		await writeFile(join(root, "tracked.txt"), "base\n");
		await writeFile(join(root, "other.txt"), "other\n");
		git(root, "add", "tracked.txt", "other.txt");
		git(root, "commit", "-q", "-m", "base");
		await run(root);
	} finally { await rm(root, { recursive: true, force: true }); }
}

async function snapshot(root: string, limits?: Partial<DirtySnapshotLimits>): Promise<DirtySnapshot> {
	const result = await captureDirtySnapshot(root, limits ? { limits } : {});
	assert.equal(result.kind, "snapshot", result.kind === "unavailable" ? result.reason : "");
	return (result as { snapshot: DirtySnapshot }).snapshot;
}

test("unrelated pre-existing changes compare unchanged after the session commits its own work", async () => {
	await repo(async (root) => {
		await writeFile(join(root, "tracked.txt"), "user wip\n");
		await mkdir(join(root, "notes"));
		await writeFile(join(root, "notes", "draft.md"), "draft\n");
		const before = await snapshot(root);
		assert.equal(before.entries.length, 4);
		await writeFile(join(root, "session.txt"), "session\n");
		git(root, "add", "session.txt");
		git(root, "commit", "-q", "-m", "session work");
		assert.deepEqual(compareDirtySnapshots(before, await snapshot(root)), { kind: "unchanged", entries: 4 });
	});
});

test("owned, mixed-file, staged, untracked and reverted changes are detected", async () => {
	await repo(async (root) => {
		await writeFile(join(root, "tracked.txt"), "user wip\n");
		const before = await snapshot(root);
		const changed = async (mutate: () => Promise<void> | void, undo: () => Promise<void> | void) => {
			await mutate();
			assert.equal(compareDirtySnapshots(before, await snapshot(root)).kind, "changed");
			await undo();
		};
		await changed(() => writeFile(join(root, "other.txt"), "session edit\n"), () => { git(root, "checkout", "--", "other.txt"); });
		await changed(() => writeFile(join(root, "tracked.txt"), "user wip\nsession line\n"), () => writeFile(join(root, "tracked.txt"), "user wip\n"));
		await changed(() => { git(root, "add", "tracked.txt"); }, () => { git(root, "reset", "-q", "--", "tracked.txt"); });
		await changed(() => writeFile(join(root, "new.txt"), "session\n"), () => rm(join(root, "new.txt")));
		await changed(() => chmod(join(root, "tracked.txt"), 0o755), () => chmod(join(root, "tracked.txt"), 0o644));
		await changed(() => rm(join(root, "tracked.txt")), () => writeFile(join(root, "tracked.txt"), "user wip\n"));
		assert.equal(compareDirtySnapshots(before, await snapshot(root)).kind, "unchanged");
	});
});

test("a clean startup snapshot protects every later change", async () => {
	await repo(async (root) => {
		const before = await snapshot(root);
		assert.deepEqual(before.entries, []);
		await writeFile(join(root, "tracked.txt"), "later\n");
		assert.equal(compareDirtySnapshots(before, await snapshot(root)).kind, "changed");
	});
});

test("renames are recorded with their origin", async () => {
	await repo(async (root) => {
		git(root, "mv", "other.txt", "renamed.txt");
		const before = await snapshot(root);
		assert.ok(before.entries.some((entry) => entry.startsWith("2 ") && entry.endsWith("\0other.txt")));
		assert.equal(compareDirtySnapshots(before, await snapshot(root)).kind, "unchanged");
	});
});

test("ambiguous or oversized state is unavailable rather than snapshotted", async () => {
	await repo(async (root) => {
		await symlink("tracked.txt", join(root, "link"));
		assert.deepEqual(await captureDirtySnapshot(root), { kind: "unavailable", reason: "symlinks or special files are changed" });
		await rm(join(root, "link"));
		await writeFile(join(root, "a.txt"), "a\n");
		await writeFile(join(root, "b.txt"), "b\n");
		assert.deepEqual(await captureDirtySnapshot(root, { limits: { maxEntries: 1 } }), { kind: "unavailable", reason: "more than 1 changed paths" });
		assert.deepEqual(await captureDirtySnapshot(root, { limits: { maxBytes: 3 } }), { kind: "unavailable", reason: "changed files exceed 3 bytes" });
	});
});

test("unmerged paths, submodules, failed probes and malformed records are unavailable", async () => {
	const fake = (stdout: string, code = 0) => async () => ({ code, stdout });
	const cases: [string, number, string][] = [
		["u UU N... 100644 100644 100644 100644 a b c file\0", 0, "unmerged paths are present"],
		["1 .M SC.. 160000 160000 160000 a a sub\0", 0, "submodule changes are present"],
		["1 .M N... 100644 100644 120000 a a link\0", 0, "symlinks or special files are changed"],
		["# branch.oid x\0", 0, "unexpected status record \"# \""],
		["2 R. N... 100644 100644 100644 a a R100 new\0", 0, "truncated rename record"],
		["", 128, "git status exited 128"],
	];
	for (const [stdout, code, reason] of cases) assert.deepEqual(await captureDirtySnapshot("/nonexistent", { exec: fake(stdout, code) }), { kind: "unavailable", reason });
	assert.deepEqual(await captureDirtySnapshot("/nonexistent", { exec: async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); } }), { kind: "unavailable", reason: "cannot read uncommitted state (ETIMEDOUT)" });
	const aborted = new AbortController(); aborted.abort();
	await assert.rejects(captureDirtySnapshot("/nonexistent", { signal: aborted.signal, exec: async () => { throw new Error("aborted"); } }));
});
