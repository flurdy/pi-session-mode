import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { MAX_FOLDER_GRANTS, resolveExplicitFolders, resolveGrantFolder } from "./file-scope.ts";

async function fixture() {
	const base = await realpath(await mkdtemp(join(tmpdir(), "pi-folder-scope-")));
	const root = join(base, "tree"), runtimeDir = join(base, "runtime");
	await mkdir(join(root, "store", "archive"), { recursive: true });
	await mkdir(runtimeDir);
	await writeFile(join(root, "store", "note.md"), "note\n");
	return { base, root, runtimeDir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("folder scopes resolve canonical directories and one missing leaf", async () => {
	const { root, runtimeDir, cleanup } = await fixture();
	try {
		await symlink(join(root, "store"), join(root, "alias"));
		assert.equal(await resolveGrantFolder("alias", root, { runtimeDir }), join(root, "store"));
		assert.equal(await resolveGrantFolder(join(root, "new"), root, { runtimeDir }), join(root, "new"));
		assert.deepEqual(await resolveExplicitFolders(["store", "alias", "new"], root, { runtimeDir }), [join(root, "new"), join(root, "store")]);
		await assert.rejects(resolveGrantFolder(join(root, "missing", "leaf"), root, { runtimeDir }));
		await assert.rejects(resolveGrantFolder(join(root, "store", "note.md"), root, { runtimeDir }), /directory/i);
		await assert.rejects(resolveExplicitFolders([], root, { runtimeDir }));
		await assert.rejects(resolveExplicitFolders(Array.from({ length: MAX_FOLDER_GRANTS + 1 }, (_, index) => `f${index}`), root, { runtimeDir }));
	} finally { await cleanup(); }
});

test("folder scopes never cover root, home, home ancestors or the lease runtime", async () => {
	const { base, root, runtimeDir, cleanup } = await fixture();
	try {
		const home = await realpath(homedir());
		for (const path of ["/", home, dirname(home)]) await assert.rejects(resolveGrantFolder(path, root, { runtimeDir }), /broad|home|root/i);
		await assert.rejects(resolveGrantFolder(runtimeDir, root, { runtimeDir }), /runtime/i);
		await assert.rejects(resolveGrantFolder(base, root, { runtimeDir }), /runtime/i);
		await assert.rejects(resolveGrantFolder(join(runtimeDir, "inner"), root, { runtimeDir }), /runtime/i);
	} finally { await cleanup(); }
});

test("folder scopes reject Git ownership above, at and below the folder", async () => {
	const { root, runtimeDir, cleanup } = await fixture();
	try {
		const repo = join(root, "repo");
		await mkdir(join(repo, "inner"), { recursive: true });
		execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
		await assert.rejects(resolveGrantFolder(repo, root, { runtimeDir }), /Git/);
		await assert.rejects(resolveGrantFolder(join(repo, "inner"), root, { runtimeDir }), /Git/);
		await assert.rejects(resolveGrantFolder(join(repo, "missing"), root, { runtimeDir }), /Git/);
		await assert.rejects(resolveGrantFolder(root, root, { runtimeDir }), /Git/);
		await assert.rejects(resolveGrantFolder(join(root, "store", ".git"), root, { runtimeDir }), /Git/);
		const bare = join(root, "bare");
		await mkdir(join(bare, "objects"), { recursive: true });
		await assert.rejects(resolveGrantFolder(bare, root, { runtimeDir }), /Git/);
	} finally { await cleanup(); }
});

test("descendant scans do not follow symlinks and stop at their entry bound", async () => {
	const { root, runtimeDir, cleanup } = await fixture();
	try {
		const repo = join(root, "elsewhere");
		await mkdir(repo);
		execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
		await symlink(repo, join(root, "store", "linked-repo"));
		assert.equal(await resolveGrantFolder(join(root, "store"), root, { runtimeDir }), join(root, "store"));
		for (let index = 0; index < 5; index++) await writeFile(join(root, "store", "archive", `${index}.md`), "x\n");
		await assert.rejects(resolveGrantFolder(join(root, "store"), root, { runtimeDir, maxEntries: 4 }), /narrower|too large/i);
	} finally { await cleanup(); }
});
