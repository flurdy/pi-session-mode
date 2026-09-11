import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [agentDir, workDir, installed] = process.argv.slice(2).map((value) => resolve(value));
const { acquireWorktreeLease, lockIdentity } = await import(pathToFileURL(join(installed, "lease.ts")).href);
const runtimeDir = join(agentDir, "runtime");
const settingsPath = join(agentDir, "settings.json");
const settings = JSON.parse(await readFile(settingsPath, "utf8"));
await writeFile(settingsPath, JSON.stringify({ ...settings, defaultProjectTrust: "never" }));
await mkdir(runtimeDir);
await mkdir(join(agentDir, "extensions"), { recursive: true });
await writeFile(join(agentDir, "extensions", "smoke.ts"), `export default function(pi) {
 pi.registerCommand("smoke-tools", {handler: async (_,ctx) => ctx.ui.notify(JSON.stringify({activeTools:pi.getActiveTools()}),"info")});
 pi.registerCommand("smoke-reload", {handler: async (_,ctx) => {await ctx.reload();}});
}
`);
execFileSync("git", ["-C", workDir, "init", "-q", "-b", "main"]);

class Client {
	pending = new Map();
	events = [];
	sequence = 0;
	stderr = "";
	buffer = "";

	constructor(flags = [], extraEnv = {}) {
		this.child = spawn("pi", ["--mode", "rpc", "--no-session", ...flags], {
			cwd: workDir,
			env: { PATH: process.env.PATH, HOME: agentDir, TERM: "xterm-256color", PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", XDG_RUNTIME_DIR: runtimeDir, ...extraEnv },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.closed = new Promise((done) => this.child.once("close", done));
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => {
			this.buffer += chunk;
			let newline;
			while ((newline = this.buffer.indexOf("\n")) >= 0) {
				const line = this.buffer.slice(0, newline).replace(/\r$/, "");
				this.buffer = this.buffer.slice(newline + 1);
				if (!line) continue;
				const event = JSON.parse(line);
				this.events.push(event);
				if (event.type === "response") this.pending.get(event.id)?.(event);
			}
		});
		this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-8000); });
		this.child.stdin.on("error", () => {});
	}

	async send(type, args = {}) {
		const id = `request-${++this.sequence}`;
		let timer;
		const response = new Promise((resolveResponse, reject) => {
			this.pending.set(id, resolveResponse);
			timer = setTimeout(() => reject(new Error(`${type} timed out: ${this.stderr}`)), 20_000);
		});
		this.child.stdin.write(`${JSON.stringify({ id, type, ...args })}\n`);
		try {
			const result = await response;
			assert.equal(result.success, true, JSON.stringify(result));
			return result.data;
		} finally {
			clearTimeout(timer);
			this.pending.delete(id);
		}
	}

	async state(expected, writes) {
		const start = this.events.length;
		await this.send("prompt", { message: "/smoke-tools" });
		const notice = this.events.slice(start).find((event) => event.method === "notify" && event.message.startsWith('{"activeTools":'));
		assert.ok(notice, "active-tool diagnostic missing");
		const active = JSON.parse(notice.message).activeTools;
		assert.equal(active.includes("edit"), writes);
		assert.equal(active.includes("write"), writes);
		const status = this.events.findLast((event) => event.method === "setStatus" && event.statusKey === "session-mode");
		assert.equal(status?.statusText?.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""), expected);
	}

	async stop() {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		this.child.kill("SIGTERM");
		const timeout = setTimeout(() => this.child.kill("SIGKILL"), 5000);
		try { await this.closed; } finally { clearTimeout(timeout); }
	}
}

const clients = [];
function launch(flags, env) {
	const client = new Client(flags, env);
	clients.push(client);
	return client;
}
async function proveFree(target = workDir) {
	const result = await acquireWorktreeLease(target, { runtimeDir: join(runtimeDir, `pi-session-guard-${process.getuid()}`) });
	try { assert.equal(result.kind, "held", "kernel lease was not released"); }
	finally { if (result.kind === "held") await result.release(); }
}
try {
	const first = launch();
	const commands = (await first.send("get_commands")).commands;
	for (const name of ["plan", "implement"]) {
		assert.equal(commands.filter((command) => command.name === name && command.source === "extension").length, 1);
		assert.equal(commands.filter((command) => command.name.startsWith(`${name}:`)).length, 0);
	}
	await first.state("implement", true);
	const second = launch();
	await second.send("get_commands");
	await second.state("conflict", false);
	await first.send("prompt", { message: "/plan" });
	await first.state("plan", false);
	assert.ok(first.events.some((event) => event.method === "notify" && /Read-only subagent verification failed/.test(event.message)), "missing resolver did not warn");
	await second.send("prompt", { message: "/implement" });
	await second.state("implement", true);
	await second.send("prompt", { message: "/plan" });
	await first.send("prompt", { message: "/implement" });
	await first.state("implement", true);
	const metadata = JSON.parse(await readFile(join(runtimeDir, `pi-session-guard-${process.getuid()}`, `${lockIdentity(workDir)}.json`), "utf8"));
	assert.equal(metadata.parentPid, first.child.pid, "holder is not owned by this test process");
	process.kill(metadata.pid, "SIGTERM");
	const lossDeadline = Date.now() + 5000;
	while (!first.events.some((event) => event.method === "setStatus" && /lost/.test(event.statusText ?? "")) && Date.now() < lossDeadline) await delay(20);
	await first.state("lost", false);
	await first.send("prompt", { message: "/implement" });
	await first.state("implement", true);
	await first.send("prompt", { message: "/smoke-reload" });
	await first.state("implement", true);

	const consumer = join(agentDir, "consumer");
	await mkdir(join(consumer, "node_modules", "@flurdy"), { recursive: true });
	await symlink(installed, join(consumer, "node_modules", "@flurdy", "pi-session-mode"));
	await writeFile(join(consumer, "probe.mjs"), `import assert from "node:assert/strict";
import {probeWorktreeLeaseOccupancy} from "@flurdy/pi-session-mode/lease-observer";
const result=await probeWorktreeLeaseOccupancy(${JSON.stringify(workDir)},{runtimeDir:${JSON.stringify(join(runtimeDir, `pi-session-guard-${process.getuid()}`))},timeoutMs:10000});
assert.equal(result.kind,"held");
`);
	execFileSync(process.execPath, [join(consumer, "probe.mjs")], { timeout: 15_000 });
	await first.stop();
	await second.stop();
	await proveFree();

	const plan = launch(["--plan", "--implement"]);
	await plan.send("get_commands");
	await plan.state("plan", false);
	await proveFree();
	await plan.stop();
	const disabled = launch(["--plan"], { PI_SESSION_GUARD: "0" });
	await disabled.send("get_commands");
	await disabled.state("unguarded", true);
	await proveFree();
	await disabled.stop();
	for (const name of ["api", "web"]) {
		await mkdir(join(workDir, name));
		execFileSync("git", ["-C", join(workDir, name), "init", "-q", "-b", "main"]);
	}
	const scoped = launch();
	await scoped.send("get_commands");
	await scoped.send("prompt", { message: "/plan" });
	await scoped.send("prompt", { message: "/implement api" });
	await scoped.state("implement", true);
	const peer = launch(["--lease-roots", '["web"]']);
	await peer.send("get_commands");
	await peer.state("implement", true);
	await proveFree();
	const overlap = launch(["--lease-roots", '["api"]']);
	await overlap.send("get_commands");
	await overlap.state("conflict", false);
	await scoped.send("prompt", { message: "/implement web" });
	await scoped.state("implement", true);
	assert.match(scoped.events.findLast((event) => event.statusKey === "session-mode-leases").statusText, /^leases:1/);
	await peer.send("prompt", { message: "/plan" });
	await scoped.send("prompt", { message: "/implement web" });
	await scoped.send("prompt", { message: "/smoke-reload" });
	await scoped.state("implement", true);
	assert.match(scoped.events.findLast((event) => event.statusKey === "session-mode-leases").statusText, /^leases:2/);
	const webMetadata = JSON.parse(await readFile(join(runtimeDir, `pi-session-guard-${process.getuid()}`, `${lockIdentity(join(workDir, "web"))}.json`), "utf8"));
	assert.equal(webMetadata.parentPid, scoped.child.pid);
	process.kill(webMetadata.pid, "SIGTERM");
	const scopeLossDeadline = Date.now() + 5000;
	while (!scoped.events.some((event) => event.statusKey === "session-mode" && /lost/.test(event.statusText ?? "")) && Date.now() < scopeLossDeadline) await delay(20);
	await scoped.state("lost", false);
	await scoped.send("prompt", { message: "/plan" });
	await proveFree(join(workDir, "api"));
	await proveFree(join(workDir, "web"));
	await overlap.send("prompt", { message: "/implement web" });
	await overlap.state("implement", true);
	await overlap.send("prompt", { message: "/leases" });
	assert.ok(overlap.events.some((event) => event.method === "notify" && event.message.includes('"held":') && event.message.includes("web")));
	await scoped.stop(); await peer.stop(); await overlap.stop();
	await proveFree(join(workDir, "web"));
	console.log("Scoped RPC: disjoint roots, no implicit cwd lease, overlap, retained prior scope, additive acquisition, v2 reload, whole-set loss and read-only diagnostics: PASS");
	for (const client of clients) {
		assert.equal(client.events.some((event) => event.type === "agent_start" || event.type === "extension_error"), false, "unexpected model turn or extension error");
		assert.doesNotMatch(client.stderr, /Failed to load extension/);
	}
	console.log("RPC: single load, plan/implement, contention, holder loss, reload, shutdown, flag precedence, missing resolver, bypass and exported observer: PASS; no model turns");
} finally {
	for (const client of clients) await client.stop();
}
