import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { parseRootArguments, parseRootFlag, resolveExplicitRoots, resolveWriteRoot, normalizeToolPath, scopeStatus } from "./scope.ts";

test("root arguments are quoted literals, not shell syntax", () => {
	assert.deepEqual(parseRootArguments('"repo one" \'repo two\' repo\\ three "$HOME"'), ["repo one", "repo two", "repo three", "$HOME"]);
	assert.deepEqual(parseRootArguments(""), []);
	for (const text of ['"unfinished', "unfinished\\", '""']) assert.throws(() => parseRootArguments(text));
	assert.deepEqual(parseRootFlag('["repo one","repo two"]'), ["repo one", "repo two"]);
	for (const text of ["[]", "{}", '["",null]', "bad", JSON.stringify(Array(33).fill("repo"))]) assert.throws(() => parseRootFlag(text));
});

test("scope status cannot carry terminal control bytes", () => {
	assert.doesNotMatch(scopeStatus(["/repo\u009b31m"]), /[\u0000-\u001f\u007f-\u009f]/);
});

test("normalization matches supported Pi path forms", () => {
	assert.equal(normalizeToolPath("@a\u202fb", "/tmp"), "/tmp/a b");
	assert.equal(normalizeToolPath("~/a", "/tmp"), join(homedir(), "a"));
	assert.equal(normalizeToolPath(pathToFileURL("/tmp/a b").href, "/"), "/tmp/a b");
	for (const value of [undefined, "", "bad\0path"]) assert.throws(() => normalizeToolPath(value, "/tmp"));
});

test("explicit scopes deduplicate aliases and refuse ancestor widening", async () => {
	const root = await mkdtemp(join(tmpdir(), "lease-scope-"));
	try {
		const repo = join(root, "repo");
		await mkdir(join(repo, "src"), { recursive: true });
		execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
		await symlink(repo, join(root, "alias"));
		assert.deepEqual(await resolveExplicitRoots(["repo", "alias"], root), [repo]);
		await assert.rejects(resolveExplicitRoots(["repo/src"], root), /worktree root/);
		await assert.rejects(resolveExplicitRoots(["missing"], root));
		await assert.rejects(resolveExplicitRoots([], root));
		for (const suffix of [" ", "\r", "\n"]) {
			const spaced = `${repo}${suffix}`;
			await mkdir(spaced);
			execFileSync("git", ["-C", spaced, "init", "-q", "-b", "main"]);
			assert.deepEqual(await resolveExplicitRoots([spaced], root), [spaced]);
			assert.equal(await resolveWriteRoot("new-file", spaced), spaced);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("native ownership cannot be redirected by ambient Git location overrides", async () => {
	const root = await mkdtemp(join(tmpdir(), "lease-git-context-"));
	const nested = join(root, "nested");
	const previous = new Map(["GIT_DIR", "GIT_WORK_TREE"].map((name) => [name, process.env[name]]));
	try {
		await mkdir(nested);
		for (const repo of [root, nested]) execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
		process.env.GIT_DIR = join(root, ".git");
		process.env.GIT_WORK_TREE = root;
		await assert.rejects(resolveWriteRoot("nested/new-file", root));
		delete process.env.GIT_WORK_TREE;
		await mkdir(join(root, "ordinary"));
		await assert.rejects(resolveExplicitRoots([join(root, "ordinary")], root));
		delete process.env.GIT_DIR;
		execFileSync("git", ["-C", root, "config", "core.worktree", nested]);
		await assert.rejects(resolveWriteRoot("new-file", root));
	} finally {
		for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
		await rm(root, { recursive: true, force: true });
	}
});

test("write ownership follows actual symlinks, new parents and nested Git roots", async () => {
	const root = await mkdtemp(join(tmpdir(), "lease-write-root-"));
	try {
		const parent = join(root, "parent"), nested = join(parent, "nested"), other = join(root, "other");
		for (const repo of [parent, nested, other]) {
			await mkdir(repo, { recursive: true });
			execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
		}
		await writeFile(join(other, "file"), "data");
		await symlink(join(other, "file"), join(parent, "outside"));
		await symlink(join(other, "absent"), join(parent, "dangling"));
		assert.equal(await resolveWriteRoot("new/dir/file", parent), parent);
		assert.equal(await resolveWriteRoot("nested/file", parent), nested);
		assert.equal(await resolveWriteRoot("outside", parent), other);
		await assert.rejects(resolveWriteRoot("dangling", parent));
		await assert.rejects(resolveWriteRoot("dangling/child", parent));
		await assert.rejects(resolveWriteRoot(join(root, "non-git"), parent));
	} finally { await rm(root, { recursive: true, force: true }); }
});
