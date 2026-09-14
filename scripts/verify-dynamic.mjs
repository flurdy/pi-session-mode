import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] ? resolve(process.argv[2]) : source;
const hostVersion = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
const expectedVersion = JSON.parse(await readFile(join(source, "package.json"), "utf8")).devDependencies["@earendil-works/pi-coding-agent"];
assert.equal(hostVersion, expectedVersion, "Verify against the repository-pinned Pi host");
console.log(`Dynamic RPC host: Pi ${hostVersion}, Node ${process.version}`);
await mkdir(join(source, ".artifacts"), { recursive: true });
const base = await mkdtemp(join(source, ".artifacts", "dynamic-rpc-"));
const work = join(base, "workspace"), runtime = join(base, "runtime"), bin = join(base, "bin");
const repos = Object.fromEntries(["api", "web", "other", "one", "two", "slow"].map((name) => [name, join(base, name)]));
for (const path of [work, ...Object.values(repos), runtime, bin]) await mkdir(path);
for (const path of [work, ...Object.values(repos)]) execFileSync("git", ["-C", path, "init", "-q", "-b", "main"]);
await mkdir(join(work, "repos"));
for (const [name, path] of Object.entries(repos)) await symlink(path, join(work, "repos", name));
const slowKey = createHash("sha256").update(repos.slow).digest("hex");
const started = join(base, "slow-started");
const flock = execFileSync("which", ["flock"], { encoding: "utf8" }).trim();
await writeFile(join(bin, "flock"), `#!/bin/sh\ncase "$5" in *${slowKey}.lock) printf ready > '${started}'; sleep 0.5;; esac\nexec '${flock}' "$@"\n`, { mode: 0o700 });

async function until(predicate, label) {
	for (let i = 0; i < 2000; i++) { if (await predicate()) return; await delay(10); }
	throw new Error(`Timed out: ${label}`);
}
async function absent(path) { await assert.rejects(access(path)); }
class Client {
	pending = new Map(); events = []; sequence = 0; buffer = ""; stderr = "";
	constructor(agent, flags) {
		this.child = spawn("pi", ["--mode", "rpc", "--offline", "--no-skills", "--no-context-files", "--no-approve", "--session", join(agent, "session.jsonl"), "--provider", "lease-fixture", "--model", "fixed", "-e", join(target, "index.ts"), "-e", join(source, "fixtures", "native-write-provider.ts"), ...flags], {
			cwd: work, env: { HOME: agent, PATH: `${bin}:${process.env.PATH}`, TERM: "xterm-256color", PI_CODING_AGENT_DIR: agent, XDG_RUNTIME_DIR: runtime, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }, stdio: ["pipe", "pipe", "pipe"],
		});
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
		const result = new Promise((done, fail) => {
			this.pending.set(id, done);
			timer = setTimeout(() => fail(new Error(`${type}: ${this.stderr}`)), 25000);
		});
		this.child.stdin.write(`${JSON.stringify({ id, type, ...args })}\n`);
		try { const response = await result; assert.equal(response.success, true, JSON.stringify(response)); return response.data; }
		finally { clearTimeout(timer); this.pending.delete(id); }
	}
	async turn(label, calls, abort = false) {
		const begin = this.events.length;
		await this.send("prompt", { message: `fixture:${JSON.stringify({ label, calls })}` });
		if (abort) { await until(() => access(started).then(() => true, () => false), "slow acquisition"); await this.send("abort"); }
		await until(() => this.events.slice(begin).some((event) => event.type === "agent_end"), `turn ${label}`);
		const events = this.events.slice(begin);
		assert.equal(events.some((event) => event.type === "extension_error"), false, JSON.stringify(events));
		return events.filter((event) => event.type === "tool_execution_end");
	}
	async notice(command, select) {
		const begin = this.events.length;
		await this.send("prompt", { message: command });
		const notice = this.events.slice(begin).find((event) => event.method === "notify" && select(event.message));
		assert.ok(notice, `Missing ${command}: ${this.stderr}`);
		return JSON.parse(notice.message);
	}
	async roots(expected) {
		const value = await this.notice("/leases", (message) => message.startsWith('{"state":'));
		assert.deepEqual(value.held, [...expected].sort());
	}
	async snapshot() { return this.notice("/fixture-snapshot", (message) => message.startsWith('{"fixtureSnapshot":')); }
	async stop() {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		this.child.kill("SIGTERM"); const force = setTimeout(() => this.child.kill("SIGKILL"), 5000);
		try { await this.closed; } finally { clearTimeout(force); }
	}
}
const clients = [];
async function launch(name, flags = []) {
	const agent = join(base, name); await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "never", enableInstallTelemetry: false }));
	const client = new Client(agent, flags); clients.push(client);
	const commands = (await client.send("get_commands")).commands;
	assert.ok(commands.some((command) => command.name === "fixture-snapshot"));
	return client;
}
const write = (path, content = "fixture") => ({ name: "write", arguments: { path, content } });
const parallel = (calls) => ({ name: "multi_tool_use.parallel", arguments: { tool_uses: calls.map((call) => ({ recipient_name: `functions.${call.name}`, parameters: call.arguments })) } });
try {
	const first = await launch("first"), peer = await launch("peer", ["--lease-roots", JSON.stringify([repos.web])]);
	await first.roots([work]); await peer.roots([repos.web]);
	const tools = (await first.snapshot()).tools;
	await first.turn("selection-only", []);
	await first.roots([work]);
	let results = await first.turn("native-write", [write("repos/api/new")]);
	assert.equal(results.length, 1); assert.equal(results[0].isError, false);
	assert.equal(await readFile(join(repos.api, "new"), "utf8"), "fixture");
	await first.roots([work, repos.api]);
	assert.deepEqual((await first.snapshot()).tools, tools);
	results = await first.turn("contention", [write("repos/web/blocked")]);
	assert.equal(results[0].isError, true); await absent(join(repos.web, "blocked"));
	await first.roots([work, repos.api]);
	results = await first.turn("atomic-conflict", [parallel([write("repos/other/no"), write("repos/web/no")])]);
	assert.equal(results[0].isError, true);
	await absent(join(repos.other, "no")); await absent(join(repos.web, "no"));
	await first.roots([work, repos.api]);
	await peer.send("prompt", { message: "/plan" });
	results = await first.turn("atomic-success", [parallel([write("repos/other/yes"), write("repos/web/yes")])]);
	assert.equal(results[0].isError, false);
	assert.equal(await readFile(join(repos.other, "yes"), "utf8"), "fixture");
	assert.equal(await readFile(join(repos.web, "yes"), "utf8"), "fixture");
	results = await first.turn("sibling-preflights", [write("repos/one/a"), write("repos/two/b")]);
	assert.equal(results.length, 2); assert.ok(results.every((result) => result.isError === false));
	const held = [work, repos.api, repos.web, repos.other, repos.one, repos.two];
	await first.roots(held);
	const saved = (await first.snapshot()).saved.data;
	assert.deepEqual(saved.scope.roots, [...held].sort());
	assert.equal(saved.scope.originCwd, work);
	await first.send("prompt", { message: "/fixture-reload" });
	await first.roots(held);
	results = await first.turn("native-edit", [{ name: "edit", arguments: { path: "repos/api/new", edits: [{ oldText: "fixture", newText: "edited" }] } }]);
	assert.equal(results[0].isError, false);
	assert.equal(await readFile(join(repos.api, "new"), "utf8"), "edited");
	await first.turn("cancel", [write("repos/slow/no")], true);
	await first.roots(held); await absent(join(repos.slow, "no"));
	const snapshot = await first.snapshot(); assert.deepEqual(snapshot.tools, tools);
	await first.send("prompt", { message: "/plan" });
	await first.roots([]);
	const guarded = await first.turn("guarded", [write("repos/slow/guarded")]);
	assert.equal(guarded.length, 1); assert.equal(guarded[0].isError, true);
	await first.roots([]); await absent(join(repos.slow, "guarded"));
	for (const client of clients) {
		assert.doesNotMatch(client.stderr, /Failed to load extension|Network is forbidden/);
		assert.equal(client.events.some((event) => event.type === "extension_error"), false);
		await client.stop();
	}
	const entries = (await readFile(join(base, "first", "session.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const calls = entries.flatMap((entry) => entry.type === "message" && entry.message.role === "assistant" ? entry.message.content.filter((part) => part.type === "toolCall") : []);
	const resultsInSession = entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
	assert.ok(calls.length >= 9);
	for (const call of calls) assert.equal(resultsInSession.filter((entry) => entry.message.toolCallId === call.id).length, 1, `Unpaired ${call.id}`);
	const locks = JSON.parse(execFileSync("lslocks", ["--json", "--output", "PATH"], { encoding: "utf8" }));
	assert.equal((locks.locks ?? []).some((row) => row.path?.startsWith(runtime)), false);
	console.log("Dynamic RPC PASS: real Pi native write/edit, atomic wrapper, sibling preflights, contention, cancellation, v2 in-turn persistence and reload, paired tool results, unchanged active tools, selection-only no-op, guarded rejection, clean shutdown. Scripted fixture only; no external model requests.");
} finally {
	for (const client of clients) await client.stop();
	await rm(base, { recursive: true, force: true });
}
