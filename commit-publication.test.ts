import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
	executePublication,
	parsePushPorcelain,
	preparePublication,
	destinationMatches,
	publicationWrapperBlockReason,
	redactDiagnostics,
	redactUrl,
	registerCommitPublication,
	type PublicationDependencies,
} from "./commit-publication.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}

interface Fixture { base: string; remote: string; work: string; commit(message: string): string }

async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
	const base = await realpath(await mkdtemp(join(tmpdir(), "commit-publication-")));
	try {
		const remote = join(base, "remote.git");
		const work = join(base, "work");
		git(base, "init", "-q", "--bare", "-b", "main", remote);
		git(base, "init", "-q", "-b", "main", work);
		git(work, "config", "user.email", "fixture@example.invalid");
		git(work, "config", "user.name", "Fixture");
		git(work, "config", "core.hooksPath", join(work, ".git", "hooks"));
		git(work, "commit", "-q", "--allow-empty", "-m", "base");
		git(work, "remote", "add", "origin", remote);
		git(work, "push", "-q", "-u", "origin", "main");
		const commit = (message: string) => { git(work, "commit", "-q", "--allow-empty", "-m", message); return git(work, "rev-parse", "HEAD"); };
		await run({ base, remote, work, commit });
	} finally { await rm(base, { recursive: true, force: true }); }
}

const deps = (overrides: Partial<PublicationDependencies> = {}): PublicationDependencies => ({ pushTimeoutMs: 20_000, ...overrides });

test("publishes exactly the confirmed tip as a non-force single ref without tags", () => fixture(async ({ work, remote, commit }) => {
	const tip = commit("release candidate");
	git(work, "config", "push.followTags", "true");
	git(work, "tag", "-a", "-m", "tag", "v1.0.0");
	const prepared = await preparePublication({ root: work, commit: tip.slice(0, 7) }, deps());
	assert.deepEqual(
		{ ...prepared.identity, destination: undefined },
		{ root: work, branch: "main", commit: tip, remote: "origin", destination: undefined, ref: "refs/heads/main", trackingCommit: git(work, "rev-parse", "HEAD~1") },
	);
	assert.equal(prepared.identity.destination, remote);
	assert.equal(prepared.display.commitCount, 1);
	assert.deepEqual(prepared.display.commits, [{ commit: tip, subject: "release candidate" }]);
	assert.equal(prepared.display.prePushHook, false);
	const receipt = await executePublication({ root: work, commit: tip.slice(0, 7) }, prepared, deps());
	assert.equal(receipt.status, "ok");
	assert.equal(receipt.commit, tip);
	assert.equal(git(remote, "rev-parse", "refs/heads/main"), tip);
	assert.equal(git(remote, "tag", "--list"), "");
	assert.equal(git(work, "rev-parse", "refs/remotes/origin/main"), tip);
}));

test("already-published tips report uptodate without a new baseline", () => fixture(async ({ work }) => {
	const tip = git(work, "rev-parse", "HEAD");
	const prepared = await preparePublication({ root: work, commit: tip }, deps());
	assert.equal(prepared.display.commitCount, 0);
	assert.equal((await executePublication({ root: work, commit: tip }, prepared, deps())).status, "uptodate");
}));

test("a remote that moved since the last fetch rejects the push without force", () => fixture(async ({ base, remote, work, commit }) => {
	const other = join(base, "other");
	git(base, "clone", "-q", remote, other);
	git(other, "-c", "user.email=o@example.invalid", "-c", "user.name=O", "commit", "-q", "--allow-empty", "-m", "elsewhere");
	git(other, "push", "-q", "origin", "main");
	const remoteTip = git(remote, "rev-parse", "refs/heads/main");
	const tip = commit("local");
	const prepared = await preparePublication({ root: work, commit: tip }, deps());
	const receipt = await executePublication({ root: work, commit: tip }, prepared, deps());
	assert.equal(receipt.status, "rejected");
	assert.match(receipt.summary ?? "", /\[rejected\]/);
	assert.equal(git(remote, "rev-parse", "refs/heads/main"), remoteTip);
}));

test("a moved tip or changed configuration after confirmation is stale and pushes nothing", () => fixture(async ({ work, remote, commit }) => {
	const before = git(remote, "rev-parse", "refs/heads/main");
	const tip = commit("confirmed");
	let prepared = await preparePublication({ root: work, commit: tip }, deps());
	commit("moved on");
	let receipt = await executePublication({ root: work, commit: tip }, prepared, deps());
	assert.equal(receipt.status, "stale");
	git(work, "reset", "-q", "--hard", tip);
	prepared = await preparePublication({ root: work, commit: tip }, deps());
	git(work, "config", "remote.origin.pushurl", remote);
	receipt = await executePublication({ root: work, commit: tip }, prepared, deps());
	assert.equal(receipt.status, "stale");
	assert.equal(git(remote, "rev-parse", "refs/heads/main"), before);
}));

test("preflight fails closed for unsupported identities and push configuration", () => fixture(async ({ base, work, remote, commit }) => {
	const tip = commit("candidate");
	const reject = async (pattern: RegExp, request = { root: work, commit: tip }) => assert.rejects(preparePublication(request, deps()), pattern);
	await reject(/commit/, { root: work, commit: "HEAD" });
	await reject(/commit/, { root: work, commit: tip.toUpperCase() });
	await reject(/does not match the checked-out tip/, { root: work, commit: git(work, "rev-parse", "HEAD~1") });
	await reject(/absolute/, { root: "work", commit: tip });
	await mkdir(join(work, "sub"));
	await reject(/top-level/, { root: join(work, "sub"), commit: tip });
	await symlink(work, join(base, "alias"));
	await reject(/canonical/, { root: join(base, "alias"), commit: tip });
	const configured = async (pattern: RegExp, key: string, value: string) => {
		git(work, "config", "--add", key, value);
		try { await reject(pattern); } finally { git(work, "config", "--unset-all", key); }
	};
	await configured(/push mapping/, "remote.origin.push", "refs/heads/main:refs/heads/other");
	await configured(/mirror/, "remote.origin.mirror", "true");
	await configured(/receivepack/, "remote.origin.receivepack", "git-receive-pack");
	await configured(/pushRemote/, "branch.main.pushRemote", "elsewhere");
	await configured(/pushDefault/, "remote.pushDefault", "elsewhere");
	git(work, "remote", "set-url", "--add", "--push", "origin", remote);
	git(work, "remote", "set-url", "--add", "--push", "origin", `${remote}-mirror`);
	await reject(/exactly one push URL/);
	git(work, "config", "--unset-all", "remote.origin.pushurl");
	git(work, "config", "branch.main.merge", "refs/heads/release");
	await reject(/same-name upstream/);
	git(work, "config", "branch.main.merge", "refs/heads/main");
	git(work, "update-ref", "-d", "refs/remotes/origin/main");
	await reject(/tracking ref/);
	git(work, "fetch", "-q", "origin");
	git(work, "checkout", "-q", "--detach");
	await reject(/branch/);
}));

test("a candidate that is not a fast-forward of the local tracking ref is refused before confirmation", () => fixture(async ({ work, commit }) => {
	commit("published");
	git(work, "push", "-q", "origin", "main");
	git(work, "reset", "-q", "--hard", "HEAD~1");
	const tip = commit("rewritten");
	await assert.rejects(preparePublication({ root: work, commit: tip }, deps()), /fast-forward/);
}));

test("linked worktrees publish their own branch", () => fixture(async ({ base, work, remote, commit }) => {
	commit("main work");
	const linked = join(base, "linked");
	git(work, "worktree", "add", "-q", "-b", "feature", linked);
	git(linked, "push", "-q", "-u", "origin", "feature");
	git(linked, "commit", "-q", "--allow-empty", "-m", "feature tip");
	const tip = git(linked, "rev-parse", "HEAD");
	const prepared = await preparePublication({ root: linked, commit: tip }, deps());
	assert.equal(prepared.identity.ref, "refs/heads/feature");
	assert.equal((await executePublication({ root: linked, commit: tip }, prepared, deps())).status, "ok");
	assert.equal(git(remote, "rev-parse", "refs/heads/feature"), tip);
	assert.notEqual(git(remote, "rev-parse", "refs/heads/main"), git(work, "rev-parse", "HEAD"));
}));

test("hook failure and timeout without acknowledgement are unknown, never success", () => fixture(async ({ work, remote, commit }) => {
	const before = git(remote, "rev-parse", "refs/heads/main");
	const hooks = join(work, ".git", "hooks");
	await mkdir(hooks, { recursive: true });
	await writeFile(join(hooks, "pre-push"), "#!/bin/sh\necho declined-by-hook >&2\nexit 1\n");
	await chmod(join(hooks, "pre-push"), 0o755);
	const tip = commit("hooked");
	let prepared = await preparePublication({ root: work, commit: tip }, deps());
	assert.equal(prepared.display.prePushHook, true);
	let receipt = await executePublication({ root: work, commit: tip }, prepared, deps());
	assert.equal(receipt.status, "unknown");
	assert.match(receipt.diagnostics ?? "", /declined-by-hook/);
	await writeFile(join(hooks, "pre-push"), "#!/bin/sh\nexec sleep 10\n");
	prepared = await preparePublication({ root: work, commit: tip }, deps());
	const started = Date.now();
	receipt = await executePublication({ root: work, commit: tip }, prepared, deps({ pushTimeoutMs: 300 }));
	assert.equal(receipt.status, "unknown");
	assert.match(receipt.diagnostics ?? "", /deadline/);
	assert.ok(Date.now() - started < 8_000);
	assert.equal(git(remote, "rev-parse", "refs/heads/main"), before);
}));

test("inherited Git location overrides cannot redirect the publication", () => fixture(async ({ base, work, remote, commit }) => {
	const decoy = join(base, "decoy");
	git(base, "init", "-q", "-b", "main", decoy);
	const tip = commit("real");
	const saved = process.env.GIT_DIR;
	process.env.GIT_DIR = join(decoy, ".git");
	try {
		const prepared = await preparePublication({ root: work, commit: tip }, deps());
		assert.equal((await executePublication({ root: work, commit: tip }, prepared, deps())).status, "ok");
	} finally { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; }
	assert.equal(git(remote, "rev-parse", "refs/heads/main"), tip);
}));

test("credentials are redacted from destinations and diagnostics", () => {
	assert.equal(redactUrl("https://user:secret@example.com/org/repo.git"), "https://***@example.com/org/repo.git");
	assert.equal(redactUrl("https://TOKEN:x-oauth-basic@example.com/org/repo.git"), "https://***@example.com/org/repo.git");
	const text = redactDiagnostics("fatal: https://TOKEN:x@host/repo and https://host/repo?access_token=SECRET#frag failed");
	assert.doesNotMatch(text, /TOKEN|SECRET|frag/);
	assert.match(text, /https:\/\/\*\*\*@host\/repo and https:\/\/host\/repo\?…/);
	assert.equal(redactUrl("https://token@example.com/org/repo.git?x=secret"), "https://***@example.com/org/repo.git?…");
	assert.equal(redactUrl("git@github.com:org/repo.git"), "git@github.com:org/repo.git");
});

test("porcelain parsing requires the expected ref acknowledgement from the approved destination", () => {
	const ref = "refs/heads/main";
	const line = (flag: string, summary: string) => `To remote\n${flag}\tabc:${ref}\t${summary}\nDone\n`;
	assert.deepEqual(parsePushPorcelain(line(" ", "a..b"), ref, 0), { status: "ok", summary: "a..b", destination: "remote" });
	assert.deepEqual(parsePushPorcelain(line("*", "[new branch]"), ref, 0), { status: "ok", summary: "[new branch]", destination: "remote" });
	assert.deepEqual(parsePushPorcelain(line(" ", "a..b"), ref, 1), { status: "ok", summary: "a..b", destination: "remote", warning: "Git exited 1 after the remote acknowledged the update; local tracking state may be stale" });
	assert.ok(destinationMatches("file://localhost/srv/repo.git", "file://user@localhost/srv/repo.git"));
	assert.ok(destinationMatches("https://host/org/repo.git", "https://TOKEN:x@host/org/repo.git"));
	assert.ok(destinationMatches("../remote.git", "../remote.git"));
	assert.ok(!destinationMatches("https://evil.example/org/repo.git", "https://host/org/repo.git"));
	assert.ok(!destinationMatches(undefined, "https://host/org/repo.git"));
	assert.equal(parsePushPorcelain(line("=", "[up to date]"), ref, 0).status, "uptodate");
	assert.equal(parsePushPorcelain(line("!", "[rejected] (fetch first)"), ref, 1).status, "rejected");
	assert.equal(parsePushPorcelain(line("+", "a...b (forced update)"), ref, 0).status, "unknown");
	assert.equal(parsePushPorcelain(line(" ", "a..b").replace(ref, "refs/heads/other"), ref, 0).status, "unknown");
	assert.equal(parsePushPorcelain("", ref, 128).status, "unknown");
});

class FakePi {
	readonly handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	readonly tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
	on(name: string, handler: (event: unknown, ctx: unknown) => unknown): void { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); }
	registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }): void { this.tools.set(tool.name, tool); }
	async emit(name: string, ctx: unknown): Promise<void> { for (const handler of this.handlers.get(name) ?? []) await handler({}, ctx); }
}

type Dialog = (title: string, options: string[], opts?: { timeout?: number; signal?: AbortSignal }) => Promise<string | undefined>;

function uiContext(select: Dialog, mode = "tui", session = "session-1") {
	return { mode, hasUI: mode === "tui", sessionManager: { getSessionId: () => session }, ui: { select } };
}

async function registered(options: { now?: () => number; occupancy?: string } = {}) {
	const pi = new FakePi();
	registerCommitPublication(pi as any, {
		pushTimeoutMs: 20_000,
		...(options.now ? { now: options.now } : {}),
		observe: async (root) => [options.occupancy === "held" ? { kind: "held", root } : { kind: "free", root }],
	});
	return { pi, tool: pi.tools.get("publish_commit")! };
}

test("publish_commit asks one native push/defer/cancel question, returns a single-use token for push and executes once", () => fixture(async ({ work, remote, commit }) => {
	const tip = commit("tool candidate");
	let clock = 1_000;
	const { pi, tool } = await registered({ occupancy: "held", now: () => clock });
	const prompts: Array<{ title: string; options: string[]; opts?: { timeout?: number; signal?: AbortSignal } }> = [];
	const ctx = uiContext(async (title, options, opts) => { prompts.push({ title, options, opts }); return "push"; });
	await pi.emit("session_start", ctx);
	const confirmed = await tool.execute("c1", { action: "confirm", root: work, commit: tip.slice(0, 8), context: "release-manager: READY\u0007" }, undefined, undefined, ctx);
	assert.equal(confirmed.details.status, "confirmed");
	assert.match(confirmed.details.token, /^[0-9a-f]{32}$/);
	assert.equal(prompts.length, 1);
	const [dialog] = prompts;
	assert.deepEqual(dialog!.options, ["defer", "push", "cancel", "why?"], "defer leads so an accidental Enter publishes nothing");
	assert.equal(dialog!.opts?.timeout, undefined, "the dialog waits for an answer instead of timing out");
	assert.ok(dialog!.opts?.signal instanceof AbortSignal, "cancellation still closes the dialog");
	assert.ok(dialog!.title.startsWith(`Publish ${basename(work)} main \u2192 origin?\n`), dialog!.title);
	for (const fragment of [tip, "refs/heads/main", remote, "Caller context (unverified)", "\\u0007", "held by another local Pi session", "does not take", "defer, cancel and why? publish nothing"]) {
		assert.ok(dialog!.title.includes(fragment), `dialog lacks ${fragment}`);
	}
	clock += 170_000;
	const published = await tool.execute("e1", { action: "execute", token: confirmed.details.token }, undefined, undefined, ctx);
	assert.equal(published.details.status, "ok");
	assert.equal(git(remote, "rev-parse", "refs/heads/main"), tip);
	await assert.rejects(tool.execute("e2", { action: "execute", token: confirmed.details.token }, undefined, undefined, ctx), /unknown, used or expired/);
}));

test("publish_commit authorizes nothing for defer, cancel, why? or Esc, denies headless use and invalidates tokens on expiry or session change", () => fixture(async ({ work, remote, commit }) => {
	const before = git(remote, "rev-parse", "refs/heads/main");
	const tip = commit("guarded");
	let clock = 1_000;
	const { pi, tool } = await registered({ now: () => clock });
	let choice: string | undefined;
	const ctx = uiContext(async () => choice);
	await pi.emit("session_start", ctx);
	for (const [answer, status] of [["defer", "deferred"], ["cancel", "cancelled"], ["why?", "why"], [undefined, "dismissed"], ["Yes", "dismissed"]] as const) {
		choice = answer;
		const unauthorized = await tool.execute("c", { action: "confirm", root: work, commit: tip }, undefined, undefined, ctx);
		assert.equal(unauthorized.details.status, status, String(answer));
		assert.equal(unauthorized.details.token, undefined, String(answer));
	}
	await assert.rejects(tool.execute("r", { action: "confirm", root: work, commit: tip }, undefined, undefined, uiContext(async () => "push", "rpc")), /interactive TUI/);
	await assert.rejects(tool.execute("m", { action: "execute", root: work, token: "0".repeat(32) }, undefined, undefined, ctx), /only a token/);
	const approve = uiContext(async () => "push");
	const expired = await tool.execute("c2", { action: "confirm", root: work, commit: tip }, undefined, undefined, approve);
	clock += 301_000;
	await assert.rejects(tool.execute("x", { action: "execute", token: expired.details.token }, undefined, undefined, approve), /unknown, used or expired/);
	const replaced = await tool.execute("c3", { action: "confirm", root: work, commit: tip }, undefined, undefined, approve);
	await pi.emit("session_start", approve);
	await assert.rejects(tool.execute("y", { action: "execute", token: replaced.details.token }, undefined, undefined, approve), /unknown, used or expired/);
	const other = await tool.execute("c4", { action: "confirm", root: work, commit: tip }, undefined, undefined, approve);
	await assert.rejects(tool.execute("z", { action: "execute", token: other.details.token }, undefined, undefined, uiContext(async () => "push", "tui", "session-2")), /session/);
	assert.equal(git(remote, "rev-parse", "refs/heads/main"), before);
}));

test("publish_commit allows one operation at a time and drains an in-flight push on shutdown", () => fixture(async ({ work, remote, commit }) => {
	await mkdir(join(work, ".git", "hooks"), { recursive: true });
	await writeFile(join(work, ".git", "hooks", "pre-push"), "#!/bin/sh\nsleep 1\n");
	await chmod(join(work, ".git", "hooks", "pre-push"), 0o755);
	const tip = commit("serial");
	const { pi, tool } = await registered();
	let release!: (value: string) => void;
	let opened!: () => void;
	const dialog = new Promise<void>((done) => { opened = done; });
	const ctx = uiContext(() => new Promise<string>((done) => { release = done; opened(); }));
	await pi.emit("session_start", ctx);
	const first = tool.execute("c1", { action: "confirm", root: work, commit: tip }, undefined, undefined, ctx);
	await dialog;
	await assert.rejects(tool.execute("c2", { action: "confirm", root: work, commit: tip }, undefined, undefined, ctx), /already running/);
	release("push");
	const token = (await first).details.token;
	const running = tool.execute("e", { action: "execute", token }, undefined, undefined, ctx);
	await new Promise((done) => setTimeout(done, 600));
	await pi.emit("session_shutdown", ctx);
	assert.equal(git(remote, "rev-parse", "refs/heads/main"), tip, "shutdown waits for the launched push");
	assert.equal((await running).details.status, "ok");
	assert.equal(git(remote, "rev-parse", "refs/heads/main"), tip);
}));

test("a branch named like the confirmed SHA cannot supply a different object", () => fixture(async ({ work, remote, commit }) => {
	const tip = commit("real");
	git(work, "checkout", "-q", "-b", "decoy-base");
	const decoy = commit("decoy");
	git(work, "checkout", "-q", "main");
	git(work, "branch", tip, decoy);
	const prepared = await preparePublication({ root: work, commit: tip }, deps());
	assert.equal((await executePublication({ root: work, commit: tip }, prepared, deps())).status, "ok");
	assert.equal(git(remote, "rev-parse", "refs/heads/main"), tip);
}));

test("configuration that changes while the push runs makes the outcome unknown", () => fixture(async ({ work, remote, commit }) => {
	const hooks = join(work, ".git", "hooks");
	await mkdir(hooks, { recursive: true });
	await writeFile(join(hooks, "pre-push"), `#!/bin/sh\ngit config remote.origin.pushurl ${JSON.stringify(remote)}\n`);
	await chmod(join(hooks, "pre-push"), 0o755);
	const tip = commit("drift");
	const prepared = await preparePublication({ root: work, commit: tip }, deps());
	const receipt = await executePublication({ root: work, commit: tip }, prepared, deps());
	assert.equal(receipt.status, "unknown");
	assert.match(receipt.diagnostics ?? "", /changed while the push ran/);
}));

test("transport environment changes after confirmation are stale; cancellation before launch pushes nothing", () => fixture(async ({ work, remote, commit }) => {
	const before = git(remote, "rev-parse", "refs/heads/main");
	const tip = commit("transport");
	const prepared = await preparePublication({ root: work, commit: tip }, deps());
	const saved = process.env.GIT_SSH_COMMAND;
	process.env.GIT_SSH_COMMAND = "ssh -o HostName=elsewhere.invalid";
	try { assert.equal((await executePublication({ root: work, commit: tip }, prepared, deps())).status, "stale"); }
	finally { if (saved === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = saved; }
	const aborted = new AbortController(); aborted.abort();
	assert.equal((await executePublication({ root: work, commit: tip }, prepared, deps(), { signal: aborted.signal })).status, "stale");
	assert.equal(git(remote, "rev-parse", "refs/heads/main"), before);
}));

test("publication is refused inside parallel wrappers at any depth", () => {
	const call = { recipient_name: "functions.publish_commit", parameters: { action: "execute", token: "0".repeat(32) } };
	assert.match(publicationWrapperBlockReason("multi_tool_use.parallel", { tool_uses: [call] }) ?? "", /parallel/);
	assert.match(publicationWrapperBlockReason("multi_tool_use.parallel", { tool_uses: [{ recipient_name: "multi_tool_use.parallel", parameters: { tool_uses: [call] } }] }) ?? "", /parallel/);
	assert.equal(publicationWrapperBlockReason("multi_tool_use.parallel", { tool_uses: [{ recipient_name: "functions.read", parameters: {} }] }), undefined);
	assert.equal(publicationWrapperBlockReason("publish_commit", {}), undefined);
});
