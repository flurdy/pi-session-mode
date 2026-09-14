import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { acquireFileLease, acquireWorktreeLease, lockIdentity } from "./lease.ts";
import { registerSessionMode } from "./session-mode.ts";

type Handler = (event: any, ctx: any) => any;
class Pi {
	tools = ["read", "bash", "edit", "write"];
	flags = new Map<string, unknown>();
	commands = new Map<string, { handler: Handler }>();
	handlers = new Map<string, Handler>();
	entries: any[] = [];
	registerFlag() {}
	getFlag(name: string) { return this.flags.get(name); }
	registerCommand(name: string, value: { handler: Handler }) { this.commands.set(name, value); }
	on(name: string, value: Handler) { this.handlers.set(name, value); }
	getActiveTools() { return [...this.tools]; }
	setActiveTools(tools: string[]) { this.tools = tools; }
	appendEntry(customType: string, data: unknown) { this.entries.push({ type: "custom", customType, data }); }
	async exec() { return { code: 0, stdout: "", stderr: "" }; }
}
async function fixture(run: (root: string, start: (flags?: Record<string, unknown>, entries?: any[]) => Promise<any>) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "session-scope-"));
	const sessions: any[] = [];
	try {
		for (const path of [root, join(root, "api"), join(root, "web")]) {
			await mkdir(path, { recursive: true });
			execFileSync("git", ["-C", path, "init", "-q", "-b", "main"]);
		}
		await run(root, async (flags = { plan: true }, entries = []) => {
			const pi = new Pi(); pi.flags = new Map(Object.entries(flags)); pi.entries = entries;
			const statuses = new Map<string, string>();
			const widgets = new Map<string, string[] | undefined>();
			const notices: string[] = [], acquired: string[] = [], acquiredFiles: string[] = [], confirmations: string[] = [];
			let confirmResult = true, confirmationHook: () => void | Promise<void> = () => {}, idle = true, pendingMessages = false;
			let fileResolution = (path: string) => path.startsWith("file://") ? fileURLToPath(path) : path;
			const sessionId = `session-${sessions.length}`;
			const ctx = { cwd: root, mode: "tui", hasUI: true, isIdle: () => idle, hasPendingMessages: () => pendingMessages, model: { provider: "test" },
				sessionManager: { getBranch: () => pi.entries, getSessionId: () => sessionId },
				ui: { theme: { fg: (_: string, value: string) => value }, setWidget: (key: string, value: string[] | undefined) => widgets.set(key, value), setStatus: (key: string, value: string) => statuses.set(key, value), notify: (text: string) => notices.push(text), confirm: async (_title: string, text: string) => { confirmations.push(text); await confirmationHook(); return confirmResult; } } };
			const controller = registerSessionMode(pi as never, {
				acquireLease: async (path, options) => { acquired.push(path); return acquireWorktreeLease(path, { ...options, runtimeDir: join(root, "runtime") }); },
				acquireFile: async (path, options) => { acquiredFiles.push(path); return acquireFileLease(path, { ...options, runtimeDir: join(root, "runtime"), resolveFile: async (file) => file }); },
				resolveFiles: async (paths) => [...new Set(paths.map(fileResolution))].sort(),
				isDisabled: () => false, readOnlySubagents: async () => new Set(),
			});
			const session = { pi, ctx, controller, statuses, widgets, notices, acquired, acquiredFiles, confirmations,
				setConfirm: (value: boolean) => { confirmResult = value; },
				setConfirmationHook: (hook: () => void | Promise<void>) => { confirmationHook = hook; },
				setFileResolution: (resolve: (path: string) => string) => { fileResolution = resolve; },
				setIdle: (value: boolean) => { idle = value; },
				setPendingMessages: (value: boolean) => { pendingMessages = value; },
				command: async (name: string, args = "") => { const command = pi.commands.get(name); assert.ok(command); await command.handler(args, { ...ctx }); },
				tool: (name: string, input: unknown) => pi.handlers.get("tool_call")?.({ toolName: name, input }, ctx),
			};
			sessions.push(session);
			await pi.handlers.get("session_start")?.({}, ctx);
			return session;
		});
	} finally {
		for (const session of sessions) await session.pi.handlers.get("session_shutdown")?.({}, session.ctx);
		await rm(root, { recursive: true, force: true });
	}
}

test("explicit child scopes escape root contention and reject unleased native writes", async () => fixture(async (root, start) => {
	const rootWriter = await start({});
	const child = await start();
	await child.command("implement", '"api"');
	assert.equal(child.controller.state, "implement");
	assert.deepEqual(child.acquired, [join(root, "api")]);
	assert.equal(await child.tool("write", { path: "api/new/file" }), undefined);
	assert.equal((await child.tool("edit", { path: "web/file" }))?.block, true);
	assert.equal((await rootWriter.tool("write", { path: "api/file" }))?.block, true);
	assert.match(child.statuses.get("session-mode-leases"), /^leases:1/);
}));

test("exact-file grants are confirmed, persisted, inspectable and compose with worktree leases", async () => fixture(async (root, start) => {
	const session = await start();
	const file = join(dirname(root), `${basename(root)}-agent-config.json`);
	await session.command("grant-file", JSON.stringify(file));
	assert.equal(session.confirmations.length, 1);
	assert.ok(session.confirmations[0].includes(file));
	assert.equal(session.controller.state, "implement");
	assert.deepEqual(session.controller.roots, []);
	assert.deepEqual(session.controller.files, [file]);
	assert.match(session.statuses.get("session-mode-grants"), /^grants:1/);
	assert.match(session.widgets.get("session-mode-grants")?.join(" ") ?? "", /grants:1.*\/grants/);
	assert.equal(session.pi.tools.includes("write"), true);
	assert.equal(session.pi.entries.at(-1).data.version, 3);
	const grantedInput = { path: file, content: "value" };
	assert.equal(await session.tool("write", grantedInput), undefined);
	assert.equal(grantedInput.path, file);
	assert.match((await session.tool("edit", { path: `${file}.other` }))?.reason ?? "", /\/grant-file/);
	assert.equal((await session.tool("bash", { command: "touch /tmp/outside" }))?.block, true);
	await session.command("grants");
	assert.deepEqual(JSON.parse(session.notices.at(-1)).held, [file]);
	await session.command("implement");
	assert.deepEqual(session.controller.roots, [root]);
	assert.deepEqual(session.controller.files, [file]);
	assert.equal(session.pi.entries.at(-1).data.version, 3);
	assert.equal(await session.tool("bash", { command: "touch /tmp/outside" }), undefined);
	const prompt = await session.pi.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, session.ctx);
	assert.match(prompt.systemPrompt, /Exact-file grants:/);
	assert.match(prompt.systemPrompt, /\/grant-file/);
	await session.command("plan");
	assert.deepEqual(session.controller.roots, []);
	assert.deepEqual(session.controller.files, []);
	assert.equal(session.statuses.get("session-mode-grants"), undefined);
	assert.equal(session.widgets.get("session-mode-grants"), undefined);
}));

test("declined and contended file grants remain guarded without exposing holder metadata", async () => fixture(async (root, start) => {
	const file = join(dirname(root), `${basename(root)}-agent-config.json`);
	const declined = await start(); declined.setConfirm(false);
	await declined.command("grant-file", JSON.stringify(file));
	assert.equal(declined.controller.state, "plan");
	assert.deepEqual(declined.acquiredFiles, []);
	const holder = await start(); await holder.command("grant-file", JSON.stringify(file));
	const contender = await start(); await contender.command("grant-file", JSON.stringify(file));
	assert.equal(contender.controller.state, "implement-blocked");
	assert.deepEqual(contender.controller.files, []);
	assert.match(contender.notices.at(-1), /another live session/);
	assert.doesNotMatch(contender.notices.at(-1), /sessionId|holderPid|parentPid/);
}));

test("combined selections restore exact-file grants without another prompt", async () => fixture(async (root, start) => {
	const file = join(dirname(root), `${basename(root)}-agent-config.json`);
	const first = await start(); await first.command("grant-file", JSON.stringify(file));
	const entries = JSON.parse(JSON.stringify(first.pi.entries));
	await first.pi.handlers.get("session_shutdown")?.({}, first.ctx);
	const restored = await start({}, entries);
	assert.equal(restored.confirmations.length, 0);
	assert.deepEqual(restored.controller.files, [file]);
	assert.equal(restored.controller.state, "implement");
}));

test("explicit startup flags replace restored exact-file grants", async () => fixture(async (root, start) => {
	const file = join(dirname(root), `${basename(root)}-restored-config.json`);
	const entries = [{ type: "custom", customType: "session-mode", data: { version: 3, mode: "implement", scope: { kind: "none" }, files: [file] } }];
	const cwd = await start({ implement: true }, structuredClone(entries));
	assert.deepEqual(cwd.controller.roots, [root]);
	assert.deepEqual(cwd.controller.files, []);
	assert.equal(cwd.pi.entries.at(-1).data.version, 2);
	await cwd.pi.handlers.get("session_shutdown")?.({}, cwd.ctx);
	const scoped = await start({ "lease-roots": '["web"]' }, structuredClone(entries));
	assert.deepEqual(scoped.controller.roots, [join(root, "web")]);
	assert.deepEqual(scoped.controller.files, []);
	assert.equal(scoped.pi.entries.at(-1).data.version, 2);
}));

test("headless, stale, busy and replaced confirmations cannot grant file authority", async () => fixture(async (root, start) => {
	const file = join(dirname(root), `${basename(root)}-headless-config.json`);
	const headless = await start(); headless.ctx.hasUI = false;
	await headless.command("grant-file", JSON.stringify(file));
	assert.deepEqual(headless.acquiredFiles, []);
	assert.equal(headless.controller.state, "plan");
	const rpc = await start(); rpc.ctx.mode = "rpc";
	await rpc.command("grant-file", JSON.stringify(file));
	assert.deepEqual(rpc.acquiredFiles, []);
	assert.deepEqual(rpc.confirmations, []);
	const stale = await start();
	stale.setConfirmationHook(() => stale.setFileResolution((path: string) => `${path}.changed`));
	await stale.command("grant-file", JSON.stringify(file));
	assert.deepEqual(stale.acquiredFiles, []);
	assert.equal(stale.controller.state, "plan");
	assert.match(stale.notices.at(-1), /identity|canonical files changed/i);
	const noLongerIdle = await start();
	noLongerIdle.setConfirmationHook(() => noLongerIdle.setIdle(false));
	await noLongerIdle.command("grant-file", JSON.stringify(file));
	assert.deepEqual(noLongerIdle.acquiredFiles, []);
	assert.equal(noLongerIdle.controller.state, "plan");
	assert.match(noLongerIdle.notices.at(-1), /busy/i);
	const replaced = await start();
	replaced.setConfirmationHook(async () => {
		await replaced.pi.handlers.get("session_shutdown")?.({}, replaced.ctx);
		await replaced.pi.handlers.get("session_start")?.({}, replaced.ctx);
	});
	await replaced.command("grant-file", JSON.stringify(file));
	assert.deepEqual(replaced.acquiredFiles, []);
	assert.equal(replaced.controller.state, "plan");
	assert.match(replaced.notices.at(-1), /session changed/i);
}));

test("confirmation quotes literal escapes distinctly from control characters", async () => fixture(async (_root, start) => {
	const session = await start(); session.setConfirm(false);
	const files = ["/tmp/config\n.json", "/tmp/config\\u000a.json"];
	await session.command("grant-file", files.map((file) => JSON.stringify(pathToFileURL(file).href)).join(" "));
	assert.equal(session.confirmations.length, 1);
	const display = session.confirmations[0];
	for (const file of files) assert.ok(display.includes(JSON.stringify(file)));
	assert.deepEqual(session.acquiredFiles, []);
}));

test("oversized confirmation payloads fail closed before prompting", async () => fixture(async (_root, start) => {
	const session = await start();
	const paths = Array.from({ length: 4 }, (_, index) => `/${String(index).repeat(3000)}`);
	await session.command("grant-file", paths.map((path) => JSON.stringify(path)).join(" "));
	assert.deepEqual(session.confirmations, []);
	assert.deepEqual(session.acquiredFiles, []);
	assert.equal(session.controller.state, "plan");
	assert.match(session.notices.at(-1), /confirmation scope is too large/i);
}));

test("plan supersedes an explicit worktree addition while origin resolution is pending", async () => fixture(async (_root, start) => {
	const session = await start();
	const adding = session.command("implement", "api");
	await session.command("plan");
	await adding;
	assert.equal(session.controller.state, "plan");
	assert.deepEqual(session.controller.roots, []);
	assert.equal(session.pi.entries.at(-1).data.mode, "plan");
}));

test("initial contention remains guarded with absent or malformed holder metadata", async () => fixture(async (root, start) => {
	const holder = await start({});
	const metadataPath = join(root, "runtime", `${lockIdentity(root)}.json`);
	for (const metadata of [undefined, "not json", JSON.stringify({ pid: -1, sessionId: "untrusted-holder", root: "wrong-root" })]) {
		if (metadata === undefined) await rm(metadataPath, { force: true });
		else await writeFile(metadataPath, metadata);
		const contender = await start({});
		assert.equal(contender.controller.state, "implement-blocked");
		assert.deepEqual(contender.controller.roots, []);
		assert.equal(contender.pi.tools.includes("write"), false);
		assert.match(contender.notices.at(-1), /another live session/);
		assert.doesNotMatch(contender.notices.at(-1), /retained|untrusted-holder|wrong-root|pid/);
		assert.ok(contender.notices.at(-1).includes(root));
		assert.equal(holder.controller.state, "implement");
		assert.deepEqual(holder.controller.roots, [root]);
	}
}));

test("additions preserve existing leases on conflict and /plan clears all selections", async () => fixture(async (root, start) => {
	const a = await start(), b = await start();
	await a.command("implement", "api");
	await b.command("implement", "web");
	await a.command("implement", "web");
	assert.equal(a.controller.state, "implement");
	assert.deepEqual(a.controller.roots, [join(root, "api")]);
	assert.match(a.notices.at(-1), /web/);
	assert.match(a.notices.at(-1), /another live session/);
	assert.match(a.notices.at(-1), /Existing valid leases are retained/);
	assert.doesNotMatch(a.notices.at(-1), /writes remain guarded|"holder"|"sessionId"/);
	await b.command("plan");
	await a.command("implement", "web");
	assert.deepEqual(a.controller.roots, [join(root, "api"), join(root, "web")]);
	const count = a.acquired.length;
	await a.command("implement");
	assert.equal(a.acquired.length, count);
	await a.command("leases");
	assert.match(a.notices.at(-1), /api/);
	await a.command("plan");
	assert.deepEqual(a.controller.roots, []);
	assert.deepEqual(a.pi.entries.at(-1).data, { version: 2, mode: "plan" });
}));

test("explicit lease inspection reports self-held locks without acquiring", async () => fixture(async (root, start) => {
	const session = await start();
	await session.command("implement", "api");
	const before = session.acquired.length;
	const runtime = join(root, "observer-runtime"), bin = join(root, "bin");
	await mkdir(runtime); await mkdir(bin);
	await symlink(join(root, "runtime"), join(runtime, `pi-session-guard-${process.getuid!()}`));
	const key = lockIdentity(join(root, "api"));
	const metadata = JSON.parse(await readFile(join(root, "runtime", `${key}.json`), "utf8"));
	const locks = { locks: [{ path: join(root, "runtime", `${key}.lock`), type: "FLOCK", mode: "WRITE", pid: metadata.pid }] };
	await writeFile(join(bin, "lslocks"), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(locks))});\n`, { mode: 0o700 });
	const oldPath = process.env.PATH, oldRuntime = process.env.XDG_RUNTIME_DIR;
	try {
		process.env.PATH = `${bin}:${oldPath}`;
		process.env.XDG_RUNTIME_DIR = runtime;
		await session.command("leases", "api");
		const result = JSON.parse(session.notices.at(-1));
		assert.deepEqual(result.requested, [join(root, "api")]);
		assert.deepEqual(result.observations, [{ kind: "held", root: join(root, "api") }]);
		assert.equal(session.acquired.length, before);
	} finally {
		if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
		if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = oldRuntime;
	}
}));

test("an unavailable safe checkpoint stays guarded without recursive save retries", async () => fixture(async (_root, start) => {
	const session = await start();
	let saves = 0;
	session.pi.appendEntry = () => { saves++; throw new Error("checkpoint unavailable"); };
	await session.command("implement", "missing-root");
	assert.equal(session.controller.state, "plan");
	assert.equal(saves, 1);
	assert.ok(session.notices.some((message: string) => message.includes("could not be saved")));
	assert.doesNotMatch(session.notices.at(-1), /retained|another live session/);
	assert.match(session.notices.at(-1), /"kind":"invalid"/);
	assert.match(session.notices.at(-1), /writes remain guarded/);
}));

test("lease diagnostics escape terminal control characters", async () => fixture(async (_root, start) => {
	const session = await start();
	for (const control of ["\x1b", "\u009b"]) {
		await session.command("leases", `"missing${control}[31m"`);
		assert.doesNotMatch(session.notices.at(-1), /[\u0000-\u001f\u007f-\u009f]/);
	}
}));

test("restored canonical paths are not reinterpreted as user input", async () => fixture(async (root, start) => {
	const unusual = join(root, "api\u00a0");
	await mkdir(unusual);
	execFileSync("git", ["-C", unusual, "init", "-q", "-b", "main"]);
	const first = await start();
	await first.command("implement", JSON.stringify(pathToFileURL(unusual).href));
	assert.equal(first.controller.state, "implement");
	const entries = JSON.parse(JSON.stringify(first.pi.entries));
	await first.command("plan");
	const restored = await start({}, entries);
	assert.equal(restored.controller.state, "implement");
	assert.deepEqual(restored.controller.roots, [unusual]);
}));

test("scoped startup and restoration remain guarded on invalid input or changed origin", async () => fixture(async (root, start) => {
	const invalid = await start({ "lease-roots": "[]" });
	assert.equal(invalid.controller.state, "plan");
	assert.deepEqual(invalid.acquired, []);
	assert.match(invalid.notices.at(-1), /nonempty literal worktree paths/);
	assert.doesNotMatch(invalid.notices.at(-1), /retained|another live session/);
	const moved = await start({}, [{ type: "custom", customType: "session-mode", data: { version: 2, mode: "implement", scope: { kind: "roots", roots: [join(root, "api")], originCwd: "/elsewhere" } } }]);
	assert.equal(moved.controller.state, "plan");
	assert.deepEqual(moved.acquired, []);
	assert.match(moved.notices.at(-1), /origin cwd changed/);
	assert.doesNotMatch(moved.notices.at(-1), /retained|another live session/);
	const scoped = await start({ "lease-roots": '["web"]' });
	assert.equal(scoped.controller.state, "implement");
	assert.deepEqual(scoped.controller.roots, [join(root, "web")]);
	assert.equal(scoped.pi.entries.at(-2).data.mode, "plan");
	assert.equal(scoped.pi.entries.at(-1).data.version, 2);
}));
