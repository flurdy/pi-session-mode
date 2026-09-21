import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetArgument = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const target = targetArgument ? resolve(targetArgument) : source;
const serverMode = process.argv.includes("--server");
const expectedPi = JSON.parse(await readFile(join(source, "package.json"), "utf8")).devDependencies["@earendil-works/pi-coding-agent"];
assert.equal(execFileSync("pi", ["--version"], { encoding: "utf8" }).trim(), expectedPi, "Verify against the repository-pinned Pi host");
await mkdir(join(source, ".artifacts"), { recursive: true });
const base = await mkdtemp(join(source, ".artifacts", "beads-sync-"));
const privateBase = await mkdtemp(join(tmpdir(), "pi-beads-sync-"));
const home = join(privateBase, "home"), agent = join(privateBase, "agent"), runtime = join(privateBase, "runtime");
const store = join(base, "store"), peer = join(base, "peer"), remote = join(base, "remote"), work = join(base, "workspace");
for (const path of [home, agent, runtime, store, peer, remote, work]) await mkdir(path);
const env = {
	PATH: process.env.PATH,
	HOME: home,
	XDG_CONFIG_HOME: join(home, "config"),
	XDG_RUNTIME_DIR: runtime,
	DOLT_ROOT_PATH: home,
	DOLT_DISABLE_UPDATE_CHECK: "1",
	BD_NON_INTERACTIVE: "1",
	BEADS_NO_DAEMON: "1",
	BEADS_NO_TELEMETRY: "1",
	CI: "true",
	GIT_CONFIG_NOSYSTEM: "1",
	PI_SKIP_VERSION_CHECK: "1",
	PI_TELEMETRY: "0",
	TERM: "xterm-256color",
};
function run(command, args, options = {}) {
	return execFileSync(command, args, { cwd: options.cwd ?? base, env: { ...env, ...(options.env ?? {}) }, encoding: "utf8", stdio: options.stdio ?? ["ignore", "pipe", "pipe"], timeout: 60_000 });
}
async function seed(path, mode = "embedded") {
	const beads = join(path, ".beads");
	await mkdir(beads, { mode: 0o700 });
	await writeFile(join(beads, "metadata.json"), JSON.stringify({ backend: "dolt", dolt_mode: mode, dolt_database: "fixture", database: "dolt" }));
}
function bd(path, ...args) { return run("bd", ["-C", path, ...args], { cwd: path, env: { BEADS_DIR: join(path, ".beads") } }); }
function json(text) { return JSON.parse(text); }
function initGit(path) {
	run("git", ["init", "-q", "-b", "main", path]);
	run("git", ["-C", path, "config", "user.name", "Sync fixture"]);
	run("git", ["-C", path, "config", "user.email", "fixture@example.invalid"]);
}
function commitFixture(path) {
	bd(path, "dolt", "commit");
	if (serverMode && path === store) {
		const rows = json(bd(path, "sql", "SELECT COUNT(*) AS dirty FROM dolt_status", "--json", "--readonly"));
		if (rows[0].dirty > 0) bd(path, "sql", "CALL DOLT_COMMIT('-Am', 'Commit synthetic fixture configuration')");
	}
}
function create(path, title) {
	const id = json(bd(path, "create", title, "--type", "task", "--json")).id;
	commitFixture(path);
	return id;
}
function title(path, id) { return json(bd(path, "show", id, "--json", "--readonly"))[0].title; }
function head(path) { return json(bd(path, "vc", "status", "--json", "--readonly")).commit; }
async function until(predicate, label) {
	for (let index = 0; index < 2000; index++) { if (await predicate()) return; await new Promise((done) => setTimeout(done, 10)); }
	throw new Error(`Timed out: ${label}`);
}
class Client {
	pending = new Map(); events = []; sequence = 0; buffer = ""; stderr = "";
	constructor() {
		this.child = spawn("pi", ["--mode", "rpc", "--offline", "--no-skills", "--no-context-files", "--no-approve", "--plan", "--session", join(agent, "session.jsonl"), "--provider", "lease-fixture", "--model", "fixed", "-e", join(target, "index.ts"), "-e", join(source, "fixtures", "native-write-provider.ts")], { cwd: work, env: { ...env, PI_CODING_AGENT_DIR: agent }, stdio: ["pipe", "pipe", "pipe"] });
		this.closed = new Promise((done) => this.child.once("close", done));
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => {
			this.buffer += chunk;
			let newline;
			while ((newline = this.buffer.indexOf("\n")) >= 0) {
				const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
				if (!line) continue;
				const event = JSON.parse(line); this.events.push(event);
				if (event.type === "response") this.pending.get(event.id)?.(event);
			}
		});
		this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-8000); });
		this.child.stdin.on("error", () => {});
	}
	async send(type, args = {}) {
		const id = `request-${++this.sequence}`;
		let timer;
		const response = new Promise((done, fail) => {
			this.pending.set(id, done);
			timer = setTimeout(() => fail(new Error(`${type}: ${this.stderr}`)), 30_000);
		});
		this.child.stdin.write(`${JSON.stringify({ id, type, ...args })}\n`);
		try { const result = await response; assert.equal(result.success, true, JSON.stringify(result)); return result.data; }
		finally { clearTimeout(timer); this.pending.delete(id); }
	}
	async turn(label, action, overrides = {}) {
		const sourceState = [work, store].map((path) => run("git", ["-C", path, "status", "--porcelain=v1", "--untracked-files=all"]));
		const begin = this.events.length;
		await this.send("prompt", { message: `fixture:${JSON.stringify({ label, calls: [{ name: "sync_beads_store", arguments: { action, directory: store, remote: "origin", ...overrides } }] })}` });
		await until(() => this.events.slice(begin).some((event) => event.type === "agent_end"), label);
		const events = this.events.slice(begin);
		assert.equal(events.some((event) => event.type === "extension_error"), false, JSON.stringify(events));
		assert.deepEqual([work, store].map((path) => run("git", ["-C", path, "status", "--porcelain=v1", "--untracked-files=all"])), sourceState, "Typed sync must leave both source worktrees unchanged");
		return events.find((event) => event.type === "tool_execution_end" && event.toolName === "sync_beads_store");
	}
	async leases() {
		const begin = this.events.length;
		await this.send("prompt", { message: "/leases" });
		const notice = this.events.slice(begin).find((event) => event.method === "notify" && event.message.startsWith('{"state":'));
		assert.ok(notice, this.stderr);
		return json(notice.message);
	}
	async stop() {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		this.child.kill("SIGTERM"); const force = setTimeout(() => this.child.kill("SIGKILL"), 5000);
		try { await this.closed; } finally { clearTimeout(force); }
	}
}
let client;
try {
	run("dolt", ["config", "--global", "--add", "versioncheck.disabled", "true"]);
	run("dolt", ["config", "--global", "--add", "user.name", "Sync fixture"]);
	run("dolt", ["config", "--global", "--add", "user.email", "fixture@example.invalid"]);
	initGit(work); initGit(store); await seed(store, serverMode ? "server" : "embedded");
	bd(store, "init", "--prefix", "fixture", "--skip-hooks", "--skip-agents", "--non-interactive", ...(serverMode ? ["--server"] : []));
	const common = create(store, "Common fixture");
	bd(store, "dolt", "remote", "add", "origin", new URL(`file://${remote}`).href);
	bd(store, "dolt", "push", "--remote", "origin");
	initGit(peer); await seed(peer);
	bd(peer, "init", "--remote", new URL(`file://${remote}`).href, "--prefix", "fixture", "--skip-hooks", "--skip-agents", "--non-interactive");
	const { tsImport } = await import("tsx/esm/api");
	const sync = await tsImport(join(target, "beads-sync.ts"), import.meta.url);
	const dependencies = sync.defaultBeadsSyncDependencies();
	dependencies.agentDir = agent;
	dependencies.env = env;
	const acquire = dependencies.acquireConfigLease;
	dependencies.acquireConfigLease = (file, options) => acquire(file, { ...options, runtimeDir: join(runtime, "enrollment") });
	const prepared = await sync.inspectBeadsSyncTrust({ directory: store, remote: "origin" }, dependencies);
	await sync.persistBeadsSyncTrust(prepared, dependencies, { sessionId: "offline-enrollment-fixture" });
	await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "never", enableInstallTelemetry: false }), { mode: 0o600 });
	const cleanBefore = run("git", ["-C", store, "status", "--porcelain=v1", "--untracked-files=all"]);
	client = new Client();
	const tools = (await client.send("get_commands")).commands;
	assert.ok(tools.some((command) => command.name === "fixture-snapshot"));
	assert.deepEqual(await client.leases(), { state: "plan", held: [] });
	const localOnly = create(store, "Pushed by typed tool");
	let event = await client.turn("routine-push", "push");
	assert.equal(event?.isError, false, JSON.stringify(event));
	bd(peer, "dolt", "pull", "--remote", "origin");
	assert.equal(title(peer, localOnly), "Pushed by typed tool");
	const remoteOnly = create(peer, "Pulled by typed tool");
	bd(peer, "dolt", "push", "--remote", "origin");
	event = await client.turn("routine-pull", "pull");
	assert.equal(event?.isError, false, JSON.stringify(event));
	assert.equal(title(store, remoteOnly), "Pulled by typed tool");
	bd(store, "update", common, "--title", "Local conflict");
	commitFixture(store);
	bd(peer, "update", common, "--title", "Remote conflict");
	commitFixture(peer);
	bd(peer, "dolt", "push", "--remote", "origin");
	const beforeConflict = head(store);
	event = await client.turn("conflict-refusal", "pull");
	assert.equal(event?.isError, true, JSON.stringify(event));
	assert.match(event.result.content[0].text, /prospective merge conflicts/);
	assert.equal(head(store), beforeConflict);
	assert.equal(title(store, common), "Local conflict");
	assert.deepEqual(await client.leases(), { state: "plan", held: [] });
	assert.equal(run("git", ["-C", store, "status", "--porcelain=v1", "--untracked-files=all"]), cleanBefore);
	event = await client.turn("untrusted-store", "fetch", { directory: peer });
	assert.equal(event?.isError, true, JSON.stringify(event));
	bd(store, "config", "set", "no-push", "true");
	event = await client.turn("no-push", "push");
	assert.equal(event?.isError, false, JSON.stringify(event));
	assert.equal(json(event.result.content[0].text).status, "skipped");
	const changedRemote = join(base, "changed-remote");
	await mkdir(changedRemote);
	bd(store, "dolt", "remote", "add", "origin", new URL(`file://${changedRemote}`).href);
	event = await client.turn("changed-destination", "fetch");
	assert.equal(event?.isError, true, JSON.stringify(event));
	assert.equal(client.events.some((item) => item.type === "ui_prompt_start" || item.method === "confirm"), false);
	assert.doesNotMatch(client.stderr, /Failed to load extension|Network is forbidden/);
	console.log(`Beads sync RPC PASS (${serverMode ? "server" : "embedded"}; ${prepared.display.bdVersion}; ${prepared.display.doltVersion}): current Pi plan mode from another repository, private trust, typed non-force push, exact-commit pull, conflict/unknown-store/changed-destination refusal, no-push respected, no source lease, no prompt, unchanged source worktrees. Disposable file remotes only.`);
} finally {
	await client?.stop();
	if (serverMode) { try { bd(store, "dolt", "stop"); } catch { /* Fixture setup may have failed before the server started. */ } }
	await rm(base, { recursive: true, force: true });
	await rm(privateBase, { recursive: true, force: true });
}
