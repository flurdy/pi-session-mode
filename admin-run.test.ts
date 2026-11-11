import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adminRunDialog, executeAdminRun, prepareAdminRun, recheckAdminRun, type AdminRunRequest } from "./admin-run.ts";
import { adminRunRefusal, destructiveCommandLines } from "./policy.ts";
import { acquireWorktreeLease } from "./lease.ts";
import { probeCanonicalWorktreeLeaseOccupancies } from "./lease-observer.ts";

async function fixture() {
	const base = await realpath(await mkdtemp(join(tmpdir(), "pi-admin-run-")));
	const home = join(base, "home");
	await mkdir(join(home, ".claude", "handoffs", "archive"), { recursive: true });
	await mkdir(join(home, ".agents"), { recursive: true });
	await mkdir(join(home, ".local", "state"), { recursive: true });
	await writeFile(join(home, ".claude", "handoffs", "a.md"), "a\n");
	await writeFile(join(home, ".claude", "handoffs", "archive", "b.md"), "b\n");
	const repo = join(base, "repo");
	await mkdir(repo);
	execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
	execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "base"]);
	return { base, home, repo, cleanup: () => rm(base, { recursive: true, force: true }) };
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

test("bounded refusals cover Git mutation, publication, remote sync and privilege escalation only", () => {
	for (const command of [
		"git push origin main", "git -C repo commit -m x", "bash -c 'git reset --hard'", "make beads-sync", "make push", "bd dolt push", "gh pr create", "sudo ls",
		"git \"push\" origin main", "if true; then gh pr create; fi", "while true; do make push; done", "{ git commit -m x; }",
	]) {
		assert.ok(adminRunRefusal(command), command);
	}
	for (const command of ["cp -a a b", "mv -n -T a b", "chmod 700 d", "git status --porcelain", "echo 'git push is refused'", "make apply"]) {
		assert.equal(adminRunRefusal(command), undefined, command);
	}
});

test("destructive commands are flagged with their literal lines", () => {
	assert.deepEqual(
		destructiveCommandLines("rm -rf x\nmv a b\nmv -n a b\ncp -an a b\nchmod -R 700 d\necho hi > f\necho ok >/dev/null 2>&1\nmkdir -m 700 d"),
		["rm -rf x", "mv a b", "chmod -R 700 d", "echo hi > f"],
	);
});

test("prepare binds canonical writes, script digest and a clean repository; recheck detects drift", async () => {
	const { base, home, repo, cleanup } = await fixture();
	try {
		const script = "set -eu\necho prepared\n";
		const writes = [join(home, ".claude", "handoffs"), join(home, ".claude", "handoffs", "archive"), join(home, ".agents", "handoffs")];
		const prepared = await prepareAdminRun({ purpose: "Bind evidence", cwd: repo, writes, script });
		assert.equal(prepared.command.kind, "script");
		if (prepared.command.kind === "script") assert.equal(prepared.command.sha256, createHash("sha256").update(script).digest("hex"));
		assert.deepEqual(prepared.writes, [
			{ path: join(home, ".agents", "handoffs"), nestedRepositories: [], exists: false },
			{ path: join(home, ".claude", "handoffs"), nestedRepositories: [], exists: true },
		], "nested declarations collapse to the outermost folder");
		assert.equal(prepared.repository?.root, repo);
		assert.equal(prepared.repository?.head, execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
		const dialog = adminRunDialog(prepared);
		assert.match(dialog, /Effects are not confined/);
		assert.match(dialog, /echo prepared/);
		assert.equal(await recheckAdminRun(prepared), undefined);
		await writeFile(join(repo, "untracked.txt"), "x\n");
		assert.match(await recheckAdminRun(prepared) ?? "", /repository/i);
		await rm(join(repo, "untracked.txt"));
		await mkdir(join(home, ".agents", "handoffs"));
		assert.match(await recheckAdminRun(prepared) ?? "", /appeared or disappeared/, "a destination shown as missing must still be missing");
		await rm(join(home, ".agents", "handoffs"), { recursive: true });
		await mkdir(join(base, "elsewhere"));
		await symlink(join(base, "elsewhere"), join(home, ".agents", "handoffs"));
		assert.match(await recheckAdminRun(prepared) ?? "", /declared/i);
	} finally { await cleanup(); }
});

test("prepare refuses unsupported shapes before any dialog", async () => {
	const { home, repo, cleanup } = await fixture();
	try {
		const writes = [join(home, ".agents")];
		const cases: [Partial<AdminRunRequest>, RegExp][] = [
			[{ script: undefined, argv: undefined }, /exactly one/i],
			[{ script: "true", argv: ["true"] }, /exactly one/i],
			[{ script: "echo x\n".repeat(201) }, /200 lines/],
			[{ script: "git push origin main" }, /Git/],
			[{ script: "bash -c \"git commit -m x\"" }, /Git/],
			[{ script: "make beads-sync" }, /remote|publication/i],
			[{ script: "gh release create v1" }, /remote|publication/i],
			[{ script: "sudo ls" }, /privilege/i],
			[{ argv: ["make", "-C", repo, "apply"] }, /cwd/],
			[{ argv: ["make", `--directory=${repo}`, "apply"] }, /cwd/],
			[{ argv: ["env", "HOME=/tmp/x", "make", "-C", repo, "apply"] }, /cwd/],
			[{ argv: ["env", "-u", "X", "gmake", "-f", "Other.mk"] }, /cwd/],
			[{ argv: ["./relative-tool"] }, /executable/i],
			[{ cwd: "relative" }, /absolute/i],
			[{ writes: [] }, /folder/i],
			[{ writes: [join(repo, "inner")] }, /Git/],
			[{ purpose: "" }, /purpose/i],
		];
		for (const [overrides, pattern] of cases) {
			const request = { purpose: "Refusal", cwd: home, writes, script: "true", ...overrides } as AdminRunRequest;
			if ("argv" in overrides && !("script" in overrides)) delete request.script;
			await assert.rejects(prepareAdminRun(request), pattern, JSON.stringify(overrides));
		}
		await writeFile(join(repo, "dirty.txt"), "x\n");
		await assert.rejects(prepareAdminRun({ purpose: "Dirty", cwd: repo, writes, argv: ["true"] }), /clean/);
	} finally { await cleanup(); }
});

test("backup continuation accepts copied Git directories and gitfiles as disclosed data", async () => {
	const { base, repo, cleanup } = await fixture();
	try {
		const backup = join(base, "backup");
		await mkdir(backup);
		const first = await prepareAdminRun({ purpose: "First backup", cwd: base, writes: [backup], argv: ["cp", "-a", repo, join(backup, "tree")] });
		assert.equal((await executeAdminRun(first)).status, "ok");
		await mkdir(join(backup, "linked"));
		await writeFile(join(backup, "linked", ".git"), "gitdir: /missing/backup-metadata\n");
		const next = await prepareAdminRun({ purpose: "Continue backup", cwd: base, writes: [backup], script: `printf continued > '${join(backup, "continued")}'` });
		const dialog = adminRunDialog(next);
		assert.match(dialog, /Nested Git repositories/);
		assert.ok(dialog.includes(join(backup, "tree")));
		assert.ok(dialog.includes(join(backup, "linked")));
		assert.equal(await recheckAdminRun(next), undefined);
		assert.equal((await executeAdminRun(next)).status, "ok");
		assert.equal(await readFile(join(backup, "continued"), "utf8"), "continued");
	} finally { await cleanup(); }
});

test("content relocation into a parent containing an unrelated Git backup preserves checksums", async () => {
	const { base, cleanup } = await fixture();
	try {
		const source = join(base, "content"), parent = join(base, "destination"), target = join(parent, "content");
		await mkdir(source);
		await mkdir(join(parent, "unrelated", ".git"), { recursive: true });
		const content = "harmless archived data\n";
		const digest = createHash("sha256").update(content).digest("hex");
		await writeFile(join(source, "archive.tar"), content);
		await writeFile(join(source, "SHA256SUMS"), `${digest}  archive.tar\n`);
		const script = `set -eu\n(cd '${source}' && sha256sum -c SHA256SUMS)\ntest ! -e '${target}'\nmv -n -T '${source}' '${target}'\ntest ! -e '${source}'\n(cd '${target}' && sha256sum -c SHA256SUMS)`;
		const prepared = await prepareAdminRun({ purpose: "Relocate content", cwd: base, writes: [source, parent], script });
		assert.equal(await recheckAdminRun(prepared), undefined);
		const receipt = await executeAdminRun(prepared);
		assert.equal(receipt.status, "ok", JSON.stringify(receipt));
		assert.equal((receipt.output?.match(/archive.tar: OK/g) ?? []).length, 2);
		assert.equal(createHash("sha256").update(await readFile(join(target, "archive.tar"))).digest("hex"), digest);
		await assert.rejects(stat(source));
		await assert.rejects(prepareAdminRun({ purpose: "No Git mutation", cwd: base, writes: [parent], script: `git -C '${join(parent, "unrelated")}' commit -m forbidden` }), /Git/);
	} finally { await cleanup(); }
});

test("nested worktree occupancy refuses foreign holders, allows self, and is rechecked before launch", async () => {
	const { base, repo, cleanup } = await fixture();
	const runtimeDir = join(base, "runtime");
	const request = { purpose: "Inspect backup data", cwd: tmpdir(), writes: [base], script: "true" };
	const options = { runtimeDir, timeoutMs: 10_000 };
	const dependencies = { probeOccupancies: (roots: readonly string[], signal?: AbortSignal) => probeCanonicalWorktreeLeaseOccupancies(roots, { ...options, selfPid: -1, signal }) };
	try {
		const prepared = await prepareAdminRun(request, dependencies);
		const lease = await acquireWorktreeLease(repo, options);
		assert.equal(lease.kind, "held");
		try {
			await assert.rejects(prepareAdminRun(request, dependencies), /Nested repository.*held by another live session/);
			assert.match(await recheckAdminRun(prepared, dependencies) ?? "", /held by another live session/);
			const own = await prepareAdminRun(request, { probeOccupancies: (roots, signal) => probeCanonicalWorktreeLeaseOccupancies(roots, { ...options, signal }) });
			assert.equal(own.writes[0]?.nestedRepositories[0]?.root, repo);
		} finally { if (lease.kind === "held") await lease.release(); }
		await assert.rejects(prepareAdminRun(request, {
			probeOccupancies: (roots, signal) => probeCanonicalWorktreeLeaseOccupancies(roots, { ...options, signal, lslocksCommand: "/missing/lslocks" }),
		}), /Cannot verify nested repository lease/);
	} finally { await cleanup(); }
});

test("a changed nested inventory, marker kind or folder identity makes confirmation stale", async () => {
	const { base, cleanup } = await fixture();
	try {
		const backup = join(base, "backup"), nested = join(backup, "copy");
		await mkdir(backup);
		const request = { purpose: "Recheck backup", cwd: base, writes: [backup], script: "true" };
		const empty = await prepareAdminRun(request);
		await mkdir(join(nested, ".git"), { recursive: true });
		assert.match(await recheckAdminRun(empty) ?? "", /inventory changed/);
		const directory = await prepareAdminRun(request);
		await rm(join(nested, ".git"), { recursive: true });
		await writeFile(join(nested, ".git"), "gitdir: /absent/metadata\n");
		assert.match(await recheckAdminRun(directory) ?? "", /inventory changed/);
		const file = await prepareAdminRun(request);
		await rm(join(nested, ".git"));
		assert.match(await recheckAdminRun(file) ?? "", /inventory changed/);
	} finally { await cleanup(); }
});

test("large nested inventories disclose a capped list and check every root", async () => {
	const { base, cleanup } = await fixture();
	try {
		const backup = join(base, "backup");
		await mkdir(backup);
		for (let i = 0; i < 35; i++) {
			await mkdir(join(backup, `tree-${i}`));
			await writeFile(join(backup, `tree-${i}`, ".git"), "gitdir: /absent\n");
		}
		let checked = 0;
		const prepared = await prepareAdminRun({ purpose: "Many copied repositories", cwd: base, writes: [backup], script: "true" }, {
			probeOccupancies: async (roots) => { checked = roots.length; return roots.map((root) => ({ kind: "free" as const, root })); },
		});
		assert.equal(checked, 35);
		assert.equal(prepared.writes[0]?.nestedRepositories.length, 35);
		assert.match(adminRunDialog(prepared), /Nested Git repositories \(35/);
		assert.match(adminRunDialog(prepared), /15 more; all included/);
	} finally { await cleanup(); }
});

test("executes the migration script once with closed stdin", async () => {
	const { home, cleanup } = await fixture();
	try {
		const src = join(home, ".claude", "handoffs"), dst = join(home, ".agents", "handoffs"), snap = join(home, ".local", "state", "handoff-migration");
		const script = [
			"set -euo pipefail",
			`src='${src}'; dst='${dst}'; snap='${snap}'`,
			"mkdir -m 700 \"$snap\"",
			"cp -a \"$src\" \"$snap/claude-handoffs\"",
			"diff -r \"$src\" \"$snap/claude-handoffs\"",
			"mv -n -T \"$src\" \"$dst\"",
			"[ ! -e \"$src\" ]",
			"chmod 700 \"$dst\" \"$dst/archive\"",
			"read -r line || echo stdin-closed",
		].join("\n");
		const prepared = await prepareAdminRun({ purpose: "Migrate handoffs", cwd: home, writes: [src, dst, snap], script });
		const receipt = await executeAdminRun(prepared);
		assert.equal(receipt.status, "ok", JSON.stringify(receipt));
		assert.equal(receipt.exitCode, 0);
		assert.match(receipt.output ?? "", /stdin-closed/);
		assert.deepEqual((await readdir(dst)).sort(), ["a.md", "archive"]);
		assert.equal(await readFile(join(dst, "archive", "b.md"), "utf8"), "b\n");
		assert.equal((await stat(dst)).mode & 0o777, 0o700);
		assert.deepEqual((await readdir(join(snap, "claude-handoffs"))).sort(), ["a.md", "archive"]);
		await assert.rejects(stat(src));
	} finally { await cleanup(); }
});

test("nonzero exits fail; deadline, cancellation and lingering children end the whole process group", async () => {
	const { home, cleanup } = await fixture();
	const writes = [join(home, ".agents")];
	try {
		const failed = await executeAdminRun(await prepareAdminRun({ purpose: "Fail", cwd: home, writes, script: "echo before-failure\nexit 3" }));
		assert.equal(failed.status, "failed");
		assert.equal(failed.exitCode, 3);
		assert.match(failed.output ?? "", /before-failure/);

		const pidFile = join(home, "deadline.pid");
		const started = Date.now();
		const deadline = await executeAdminRun(await prepareAdminRun({ purpose: "Deadline", cwd: home, writes, timeoutSeconds: 1, script: `sleep 30 & echo $! > '${pidFile}'\nwait` }));
		assert.equal(deadline.status, "interrupted");
		assert.match(deadline.reason ?? "", /deadline/);
		assert.ok(Date.now() - started < 8_000);
		assert.equal(alive(Number(await readFile(pidFile, "utf8"))), false);

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const cancelled = await executeAdminRun(await prepareAdminRun({ purpose: "Cancel", cwd: home, writes, script: "sleep 30" }), { signal: controller.signal });
		assert.equal(cancelled.status, "interrupted");
		assert.match(cancelled.reason ?? "", /cancel/);

		const lingerFile = join(home, "linger.pid");
		const lingering = await executeAdminRun(await prepareAdminRun({ purpose: "Linger", cwd: home, writes, script: `sleep 30 & echo $! > '${lingerFile}'\necho started` }));
		assert.equal(lingering.status, "ok");
		assert.equal(lingering.lingering, true);
		assert.equal(alive(Number(await readFile(lingerFile, "utf8"))), false);

		const detachedFile = join(home, "detached.pid");
		const detached = await executeAdminRun(await prepareAdminRun({ purpose: "Detached output", cwd: home, writes, script: `sleep 30 >/dev/null 2>&1 & echo $! > '${detachedFile}'` }));
		assert.equal(detached.lingering, true);
		assert.equal(alive(Number(await readFile(detachedFile, "utf8"))), false, "members without the output pipes are gone before the receipt resolves");
	} finally { await cleanup(); }
});
