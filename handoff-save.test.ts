import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { acquireFileLease, acquireWorktreeLease } from "./lease.ts";
import { resolveGrantFile } from "./file-scope.ts";
import { createHandoffSaver, registerHandoffSave, type HandoffRequest } from "./handoff-save.ts";

const helper = process.env.HANDOFF_SAVE_HELPER ?? join(homedir(), ".agents/skills/wrap-up/scripts/save-handoff.py");
const integration = (name: string, fn: () => Promise<void>) => test(name, { skip: process.env.HANDOFF_SAVE_HELPER || existsSync(helper) ? false : "Install wrap-up or set HANDOFF_SAVE_HELPER for cross-repository coverage" }, fn);
function request(slug = "save-proof"): HandoffRequest {
	return { date: "2026-09-23", time: "09:42", slug, content: `# Resume: ${slug} — 2026-09-23 09:42\n\n**Where to pick up:** /project\n**Jira:** —\n**Beads:** —\n**Deliverable:** —\n**PRs:** —\n**Context:**\n- Literal $(not-executed) and \`code\`.\n**Decisions so far:**\n- Keep grants narrow.\n**Working-copy risks:**\n- None.\n**Open threads:**\n- Resume.\n**Suggested next step:**\n- Verify.\n` };
}
async function fixture(run: (f: { home: string; runtime: string; save: ReturnType<typeof createHandoffSaver>; target: (slug?: string) => string }) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "handoff-save-"));
	const home = join(root, "home");
	try {
		const directory = join(home, ".agents/skills/wrap-up/scripts");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "save-handoff.py"), await readFile(helper));
		const runtime = join(home, "runtime");
		const save = createHandoffSaver({ home, acquire: (file, options) => acquireFileLease(file, { ...options, runtimeDir: runtime }) });
		await run({ home, runtime, save, target: (slug = "save-proof") => join(home, ".claude/handoffs", `2026-09-23-${slug}.md`) });
	} finally { await rm(root, { recursive: true, force: true }); }
}
const context = (confirm = async (_message: string) => true) => ({ sessionId: "fixture", confirm });

integration("fixed helper saves verified private bytes without lasting scope grants", () => fixture(async ({ save, target, runtime }) => {
	const input = request();
	const result = await save(input, context());
	assert.equal(result.status, "saved"); assert.equal(result.mode, "new");
	assert.equal(result.path, target());
	assert.equal(result.sha256, createHash("sha256").update(input.content).digest("hex"));
	assert.equal(await readFile(target(), "utf8"), input.content);
	const lock = await acquireFileLease(target(), { runtimeDir: runtime });
	assert.equal(lock.kind, "held"); if (lock.kind === "held") await lock.release();
}));

integration("independent sessions and different names save concurrently; same names never clobber", () => fixture(async ({ save, target }) => {
	const results = await Promise.all([save(request("one"), context()), save(request("two"), context())]);
	assert.ok(results.every((result) => result.status === "saved"));
	assert.equal(await readFile(target("one"), "utf8"), request("one").content);
	const collision = await save(request("one"), context());
	assert.equal(collision.status, "collision"); assert.equal(collision.suggestedSlug, "one-2");
}));

integration("exact-file contention fails without stealing, and release allows save", () => fixture(async ({ home, runtime, save, target }) => {
	await mkdir(join(home, ".claude/handoffs"), { recursive: true });
	const holder = await acquireFileLease(target(), { runtimeDir: runtime });
	assert.equal(holder.kind, "held");
	try { await assert.rejects(save(request(), context()), /held by another/); await assert.rejects(access(target())); }
	finally { if (holder.kind === "held") await holder.release(); }
	assert.equal((await save(request(), context())).status, "saved");
}));

integration("overwrite requires fresh confirmation bound to current bytes; stale approval is refused", () => fixture(async ({ save, target }) => {
	const first = await save(request(), context());
	const replacement = { ...request(), content: request().content.replace("- Verify.", "- Continue."), overwriteSha256: first.sha256! };
	let prompts = 0;
	assert.equal((await save(replacement, context(async (message) => { prompts++; assert.ok(message.includes(target())); return false; }))).status, "cancelled");
	assert.equal(await readFile(target(), "utf8"), request().content);
	await assert.rejects(save(replacement, { sessionId: "headless" }), /interactive/);
	await assert.rejects(save(replacement, context(async () => { await writeFile(target(), "changed externally"); return true; })), /overwrite-mismatch/);
	assert.equal(await readFile(target(), "utf8"), "changed externally");
	assert.equal(prompts, 1);
}));

integration("confirmed overwrite verifies replacement and cleans temporary files", () => fixture(async ({ home, save, target }) => {
	const first = await save(request(), context());
	const content = request().content.replace("- Verify.", "- Continue.");
	const result = await save({ ...request(), content, overwriteSha256: first.sha256! }, context());
	assert.equal(result.status, "saved"); assert.equal(result.mode, "overwrite");
	assert.equal(await readFile(target(), "utf8"), content);
	assert.deepEqual(await readdir(join(home, ".claude/handoffs")), ["2026-09-23-save-proof.md"]);
}));

integration("rejects path/command overrides, malformed content and changed helper before writing", () => fixture(async ({ home, save }) => {
	for (const input of [{ ...request(), path: "/tmp/escape" }, { ...request(), home: "/tmp" }, { ...request(), slug: "../escape" }, { ...request(), content: "incomplete" }, { ...request(), content: "x".repeat(65537) }]) {
		await assert.rejects(save(input, context()));
	}
	await assert.rejects(access(join(home, ".claude")));
	await writeFile(join(home, ".agents/skills/wrap-up/scripts/save-handoff.py"), "print('unreviewed')");
	await assert.rejects(save(request(), context()), /helper.*(reviewed|digest)/);
	await assert.rejects(access(join(home, ".claude")));
}));

for (const root of [".", ".claude"]) {
	integration(`fixed saves work inside a Git-owned ${root} without relaxing ordinary grants`, () => fixture(async ({ home, save, target }) => {
		const repo = join(home, root);
		await mkdir(repo, { recursive: true });
		execFileSync("git", ["init", "-q", repo]);
		const first = await save(request(), context());
		assert.equal(first.status, "saved");
		assert.equal(await readFile(target(), "utf8"), request().content);
		await assert.rejects(resolveGrantFile(target(), home), /Git/);
		assert.equal((await acquireFileLease(target())).kind, "unavailable");
		assert.equal((await save(request(), context())).status, "collision");
		const content = request().content.replace("- Verify.", "- Continue.");
		assert.equal((await save({ ...request(), content, overwriteSha256: first.sha256! }, context())).status, "saved");
		assert.equal(await readFile(target(), "utf8"), content);
	}));
}

integration("symlinked directories, symlink targets and nested Git destinations fail closed", () => fixture(async ({ home, save, target }) => {
	const outside = join(home, "outside"); await mkdir(outside);
	await symlink(outside, join(home, ".claude"));
	await assert.rejects(save(request(), context()), /directory/);
	assert.deepEqual(await readdir(outside), []);
	await rm(join(home, ".claude")); await mkdir(join(home, ".claude/handoffs"), { recursive: true });
	await writeFile(join(outside, "file"), "untouched"); await symlink(join(outside, "file"), target());
	await assert.rejects(save(request(), context()), /target/);
	assert.equal(await readFile(join(outside, "file"), "utf8"), "untouched");
	await rm(target()); await mkdir(join(home, ".claude/handoffs/.git"));
	await assert.rejects(save(request(), context()), /Git/);
}));

integration("Git-owned handoffs retain exact-target leases and coexist with a dotfiles root lease", () => fixture(async ({ home, runtime, target }) => {
	const repo = join(home, ".claude"); await mkdir(repo);
	execFileSync("git", ["init", "-q", repo]);
	const rootLease = await acquireWorktreeLease(repo, { runtimeDir: runtime });
	assert.equal(rootLease.kind, "held");
	let bound: Parameters<typeof acquireFileLease>[1];
	const save = createHandoffSaver({ home, acquire: (file, options) => {
		bound = { ...options, runtimeDir: runtime };
		return acquireFileLease(file, bound);
	} });
	try {
		const first = await save(request(), context());
		assert.ok(bound?.resolveFile);
		await assert.rejects(bound.resolveFile(join(home, "escape.md")), /identity/);
		await assert.rejects(bound.resolveFile(target("other-valid-name")), /identity/);
		const holder = await acquireFileLease(target(), bound);
		assert.equal(holder.kind, "held");
		const replacement = { ...request(), content: request().content.replace("- Verify.", "- Continue."), overwriteSha256: first.sha256! };
		try {
			await assert.rejects(save(replacement, context()), /held by another/);
			assert.equal(await readFile(target(), "utf8"), request().content);
		} finally { if (holder.kind === "held") await holder.release(); }
		assert.equal((await save(replacement, context())).status, "saved");
		const results = await Promise.all([save(request("one"), context()), save(request("two"), context())]);
		assert.ok(results.every((result) => result.status === "saved"));
	} finally { if (rootLease.kind === "held") await rootLease.release(); }
}));

integration("dotfiles Git indirection does not redirect the handoff path", () => fixture(async ({ home, save, target }) => {
	const repo = join(home, ".claude"); await mkdir(repo);
	execFileSync("git", ["init", "-q", "--separate-git-dir", join(home, "git-storage"), repo]);
	assert.equal((await save(request(), context())).status, "saved");
	assert.equal(await readFile(target(), "utf8"), request().content);
}));

for (const location of [".", ".claude", ".claude/handoffs"]) {
	for (const marker of ["HEAD", "objects", "refs"]) {
		integration(`rejects Git administration marker ${location}/${marker}`, () => fixture(async ({ home, save, target }) => {
			await mkdir(join(home, location), { recursive: true });
			await writeFile(join(home, location, marker), "fixture");
			await assert.rejects(save(request(), context()), /Git administration/);
			await assert.rejects(access(target()));
		}));
	}
}

integration("bare dotfiles repos, nested gitfiles and Git ancestors outside home stay rejected", () => fixture(async ({ home, save, target }) => {
	const repo = join(home, ".claude");
	execFileSync("git", ["init", "--bare", "-q", repo]);
	await assert.rejects(save(request(), context()), /Git administration/);
	await assert.rejects(access(target()));
	await rm(repo, { recursive: true, force: true });
	await mkdir(join(repo, "handoffs"), { recursive: true });
	await writeFile(join(repo, "handoffs/.git"), "gitdir: /fixture/metadata\n");
	await assert.rejects(save(request(), context()), /Git/);
	await assert.rejects(access(target()));
	await rm(join(repo, "handoffs/.git"));
	await mkdir(join(dirname(home), ".git"));
	await assert.rejects(save(request(), context()), /Git/);
	await assert.rejects(access(target()));
}));

integration("Git-owned paths still reject symlinked handoff folders, hardlinks and special targets", () => fixture(async ({ home, save, target }) => {
	const repo = join(home, ".claude"); await mkdir(repo);
	execFileSync("git", ["init", "-q", repo]);
	const outside = join(home, "outside"); await mkdir(outside);
	await symlink(outside, join(repo, "handoffs"));
	await assert.rejects(save(request(), context()), /directory/);
	assert.deepEqual(await readdir(outside), []);
	await rm(join(repo, "handoffs")); await mkdir(join(repo, "handoffs"));
	await writeFile(join(outside, "original"), "untouched");
	await link(join(outside, "original"), target());
	await assert.rejects(save(request(), context()), /target/);
	assert.equal(await readFile(join(outside, "original"), "utf8"), "untouched");
	await rm(target()); await mkdir(target());
	await assert.rejects(save(request(), context()), /target/);
	await rm(target(), { recursive: true });
	execFileSync("mkfifo", [target()]);
	await assert.rejects(save(request(), context()), /target/);
}));

integration("cancellation before launch or during confirmation never writes", () => fixture(async ({ save, target }) => {
	await assert.rejects(save(request(), { ...context(), signal: AbortSignal.abort() }));
	await assert.rejects(access(target()));
	const first = await save(request(), context());
	const abort = new AbortController();
	await assert.rejects(save({ ...request(), overwriteSha256: first.sha256! }, { ...context(async () => { abort.abort(); return true; }), signal: abort.signal }));
	assert.equal(await readFile(target(), "utf8"), request().content);
}));

integration("malformed or failed helper receipts never claim success and release the target lease", () => fixture(async ({ home, runtime, target }) => {
	for (const response of [
		{ code: 0, stdout: "not json" },
		{ code: 0, stdout: JSON.stringify({ schemaVersion: "wrap-up-save/v1", path: target(), status: "saved", mode: "new", sha256: "0".repeat(64), bytes: 1 }) },
		{ code: 1, stdout: JSON.stringify({ schemaVersion: "wrap-up-save/v1", path: target(), status: "failure", reason: "recovery-required", backupPath: join(home, ".claude/handoffs/.wrap-up-backup-0123456789abcdef.tmp") }) },
	]) {
		const save = createHandoffSaver({ home, acquire: (file, options) => acquireFileLease(file, { ...options, runtimeDir: runtime }), run: async () => response });
		await assert.rejects(save(request(), context()), response.code === 1 ? /recovery copy:.*wrap-up-backup/ : /unverified/);
		const lease = await acquireFileLease(target(), { runtimeDir: runtime });
		assert.equal(lease.kind, "held"); if (lease.kind === "held") await lease.release();
	}
}));

integration("cancellation after process launch retains the real lease until verification and release", () => fixture(async ({ home, runtime, target }) => {
	const abort = new AbortController();
	const save = createHandoffSaver({
		home, acquire: (file, options) => acquireFileLease(file, { ...options, runtimeDir: runtime }),
		run: async (_source, _home, input) => {
			abort.abort();
			assert.equal((await acquireFileLease(target(), { runtimeDir: runtime })).kind, "contended");
			await writeFile(target(), input.content, { mode: 0o600 });
			return { code: 0, stdout: JSON.stringify({ schemaVersion: "wrap-up-save/v1", path: target(), status: "saved", mode: "new", sha256: createHash("sha256").update(input.content).digest("hex"), bytes: Buffer.byteLength(input.content) }) };
		},
	});
	assert.equal((await save(request(), { ...context(), signal: abort.signal })).status, "saved");
	const free = await acquireFileLease(target(), { runtimeDir: runtime });
	assert.equal(free.kind, "held"); if (free.kind === "held") await free.release();
}));

test("tool is usable without repository authority and drains in-flight work on shutdown", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	let tool: any; let finish!: () => void;
	const inFlight = new Promise<void>((done) => { finish = done; });
	let launched = false;
	registerHandoffSave({ registerTool: (value: any) => { tool = value; }, on: (name: string, handler: any) => { handlers.set(name, handler); } } as never, async () => { launched = true; await inFlight; return { schemaVersion: "wrap-up-save/v1", status: "saved", path: "/test" }; });
	const ctx = { sessionManager: { getSessionId: () => "one" }, mode: "print", hasUI: false };
	handlers.get("session_start")!({}, ctx);
	const saving = tool.execute("call", request(), undefined, undefined, ctx);
	assert.equal(launched, true);
	let drained = false;
	const stopping = handlers.get("session_shutdown")!().then(() => { drained = true; });
	await Promise.resolve(); assert.equal(drained, false);
	finish(); await saving; await stopping;
	await assert.rejects(tool.execute("stale", request(), undefined, undefined, ctx), /session/);
});
