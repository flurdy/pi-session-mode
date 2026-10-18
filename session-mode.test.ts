import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { FileLeaseResult, HeldWorktreeLease, WorktreeLeaseResult } from "./lease.ts";
import type { PackageActivationEvidence, PackageActivationRequest, PreparedPackageActivation } from "./package-activation.ts";
import { registerSessionMode, type SessionModeDependencies } from "./session-mode.ts";

type Handler = (event: any, context: any) => unknown;

class FakePi {
	readonly handlers = new Map<string, Handler[]>();
	readonly commands = new Map<string, { handler: Handler }>();
	readonly tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
	readonly appended: Array<{ type: string; data: unknown }> = [];
	readonly activeToolHistory: string[][] = [];
	readonly execCalls: string[][] = [];
	activeTools = ["read", "bash", "edit", "write", "questionnaire", "subagent"];
	planFlag = false;
	implementFlag = false;
	lazyFlag = false;
	leaseRootsFlag: string | undefined;

	registerFlag(): void {}
	getFlag(name: string): boolean | string | undefined {
		return name === "plan" ? this.planFlag : name === "implement" ? this.implementFlag : name === "lazy" ? this.lazyFlag : this.leaseRootsFlag;
	}
	on(name: string, handler: Handler): void { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); }
	registerCommand(name: string, command: { handler: Handler }): void { this.commands.set(name, command); }
	registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }): void { this.tools.set(tool.name, tool); }
	getActiveTools(): string[] { return [...this.activeTools]; }
	setActiveTools(names: string[]): void { this.activeTools = [...names]; this.activeToolHistory.push([...names]); }
	appendEntry(type: string, data: unknown): void { this.appended.push({ type, data }); }
	async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		this.execCalls.push([command, ...args]);
		return { code: 0, stdout: "", stderr: "" };
	}
	async emit(name: string, ctx: ReturnType<typeof context>, event: any = {}): Promise<unknown[]> {
		const results = [];
		for (const handler of this.handlers.get(name) ?? []) results.push(await handler(event, ctx));
		return results;
	}
}

// Most tests exercise a restored implicit-cwd selection, the pre-lazy fresh default. Fresh lazy sessions use context([]).
const implicitCwd = () => [{ type: "custom", customType: "session-mode", data: { version: 2, mode: "implement", scope: { kind: "cwd" } } }];
function context(branch: any[] = implicitCwd(), provider = "provider-a") {
	const statuses: Array<string | undefined> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx = {
		cwd: "/repo",
		mode: "tui",
		hasUI: true,
		model: { provider },
		idle: true,
		pendingMessages: false,
		isIdle: () => ctx.idle,
		hasPendingMessages: () => ctx.pendingMessages,
		sessionManager: { getBranch: () => branch, getSessionId: () => "session-1" },
		ui: {
			theme: { fg: (_tone: string, text: string) => text },
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			notify: (message: string, level?: string) => notifications.push({ message, level }),
			confirm: async (_title: string, _message: string, _options?: unknown) => true,
		},
	};
	return Object.assign(ctx, { statuses, notifications });
}

function held(releaseLog: string[] = []): HeldWorktreeLease {
	return {
		kind: "held",
		root: "/repo",
		holderPid: 123,
		lost: new Promise(() => undefined),
		async release() { releaseLog.push("release"); },
	};
}

function harness(results: WorktreeLeaseResult[] = [held()], options: Partial<SessionModeDependencies> = {}) {
	const pi = new FakePi();
	const acquisitions: string[] = [];
	const dependencies: SessionModeDependencies = {
		acquireLease: async () => {
			acquisitions.push("acquire");
			const result = results.shift();
			assert.ok(result);
			return result;
		},
		isDisabled: () => false,
		readOnlySubagents: async () => new Set(),
		...options,
	};
	const controller = registerSessionMode(pi as never, dependencies);
	return { pi, acquisitions, controller };
}

test("registers scope controls, fixed handoff saving, commit publication and confirmed package activation", () => {
	const { pi } = harness();
	assert.deepEqual([...pi.commands.keys()].sort(), ["grant-file", "grants", "implement", "lazy", "lease-holders", "leases", "plan"]);
	assert.deepEqual([...pi.tools.keys()], ["save_handoff", "publish_commit", "activate_pi_package", "release_scopes"]);
});

test("lease-holders reports the kernel inventory without acquiring and trims oversized payloads", async () => {
	const session = (parentPid: number, self: boolean, roots: string[]) => ({
		parentPid, self, sessionIds: self ? ["session-1"] : [], files: [],
		worktrees: roots.map((root) => ({ kind: "worktree" as const, identity: "a".repeat(64), holderPid: parentPid + 1, parent: "live" as const, parentPid, self, binding: "bound" as const, path: root })),
	});
	const inventories = [
		{ kind: "inventory" as const, runtimeDir: "/run/pi", truncated: false, sessions: [session(500, true, ["/repo"]), session(600, false, ["/other\u001b[31m"])] },
		{ kind: "inventory" as const, runtimeDir: "/run/pi", truncated: false, sessions: Array.from({ length: 40 }, (_, index) => session(1000 + index, false, [`/repo-${index}/${"x".repeat(500)}`])) },
		{ kind: "unavailable" as const, runtimeDir: "/run/pi", reason: "lslocks timed out after 2000ms" },
	];
	const requested: unknown[] = [];
	const { pi, acquisitions } = harness([], { inventory: async (options) => { requested.push(options); return structuredClone(inventories.shift()!); } });
	const ctx = context();
	await pi.commands.get("lease-holders")?.handler("", ctx);
	let payload = JSON.parse(ctx.notifications.at(-1)!.message);
	assert.deepEqual(payload.held, { worktrees: [], files: [] });
	assert.equal(payload.inventory.sessions.length, 2);
	assert.equal(payload.inventory.sessions[0].self, true);
	assert.doesNotMatch(ctx.notifications.at(-1)!.message, /[\u0000-\u001f\u007f-\u009f]/);
	assert.equal(payload.omittedSessions, 0);
	await pi.commands.get("lease-holders")?.handler("", ctx);
	assert.ok(ctx.notifications.at(-1)!.message.length <= 10_000);
	payload = JSON.parse(ctx.notifications.at(-1)!.message);
	assert.ok(payload.omittedSessions > 0 && payload.inventory.sessions.length + payload.omittedSessions === 40);
	await pi.commands.get("lease-holders")?.handler("", ctx);
	assert.equal(JSON.parse(ctx.notifications.at(-1)!.message).inventory.kind, "unavailable");
	assert.deepEqual(acquisitions, []);
	assert.deepEqual(pi.appended, []);
	assert.equal(requested.length, 3);
});

test("commit publication follows the session-mode lifecycle", async () => {
	const { pi } = harness();
	const ctx = context();
	pi.planFlag = true;
	const execute = () => pi.tools.get("publish_commit")!.execute("call", { action: "execute", token: "0".repeat(32) }, undefined, undefined, ctx);
	await assert.rejects(execute(), /no longer active/);
	await pi.emit("session_start", ctx);
	await assert.rejects(execute(), /unknown, used or expired/);
	await pi.emit("session_shutdown", ctx);
	await assert.rejects(execute(), /no longer active/);
});

test("handoff operation stays allowed in plan, conflict, acquiring, lost, implement and unguarded states", async () => {
	for (const scenario of ["plan", "conflict", "acquiring", "lost", "implement", "unguarded"]) {
		let lose!: () => void;
		const lease = held();
		lease.lost = new Promise<void>((done) => { lose = done; });
		const { pi } = harness(scenario === "conflict" ? [{ kind: "contended", root: "/repo" }] : [lease], { isDisabled: () => scenario === "unguarded" });
		const ctx = context(); pi.planFlag = scenario === "plan";
		if (scenario !== "acquiring") await pi.emit("session_start", ctx);
		if (scenario === "lost") { lose(); await new Promise((done) => setImmediate(done)); }
		for (const event of [
			{ toolName: "save_handoff", input: {} },
			{ toolName: "multi_tool_use.parallel", input: { tool_uses: [{ recipient_name: "functions.save_handoff", parameters: {} }] } },
			{ toolName: "publish_commit", input: { action: "confirm", root: "/repo", commit: "abcdef1" } },
		]) assert.deepEqual(await pi.emit("tool_call", ctx, event), [undefined], scenario);
		const nested = { tool_uses: [{ recipient_name: "functions.publish_commit", parameters: { action: "execute", token: "0".repeat(32) } }] };
		const [blocked] = await pi.emit("tool_call", ctx, { toolName: "multi_tool_use.parallel", input: nested });
		assert.equal((blocked as any)?.block, true, `${scenario}: confirmed publication never runs inside parallel wrappers`);
		if (scenario !== "unguarded") {
			const [prompt] = await pi.emit("before_agent_start", ctx, { systemPrompt: "base" });
			assert.match((prompt as any).systemPrompt, /save_handoff.*every guard state/);
			assert.match((prompt as any).systemPrompt, /publish_commit.*every guard state.*never ask for \/implement/);
		}
		await pi.emit("session_shutdown", ctx);
	}
});

test("a restored implicit-cwd selection acquires before reporting write authority", async () => {
	const { pi, acquisitions, controller } = harness();
	const ctx = context();
	await pi.emit("session_start", ctx);
	assert.deepEqual(acquisitions, ["acquire"]);
	assert.equal(controller.state, "implement");
	assert.equal(ctx.statuses.at(-1), "implement");
	assert.deepEqual(pi.activeTools, ["read", "bash", "edit", "write", "questionnaire", "subagent"]);
});

test("implicit-cwd contention explains the held root without exposing holder metadata", async (t) => {
	for (const holder of [undefined, { root: "/canonical/repo", pid: 987654, parentPid: 987653, sessionId: "private-holder-session", startedAt: "private-start-time" }]) {
		await t.test(holder ? "with holder metadata" : "without holder metadata", async () => {
			const { pi, controller } = harness([{ kind: "contended", root: "/canonical/repo", holder }]);
			const ctx = context();
			await pi.emit("session_start", ctx);
			assert.equal(controller.state, "implement-blocked");
			assert.equal(controller.mode, "implement");
			assert.deepEqual(controller.roots, []);
			assert.deepEqual(pi.appended, []);
			assert.equal(pi.activeTools.includes("write"), false);
			assert.equal(pi.activeTools.includes("edit"), false);
			const notice = ctx.notifications.at(-1)!;
			assert.equal(notice.level, "warning");
			assert.match(notice.message, /Worktree "\/canonical\/repo" is held by another live session/);
			assert.match(notice.message, /writes remain guarded/);
			for (const action of ["/leases", "/plan", "/implement"]) assert.ok(notice.message.includes(action));
			assert.doesNotMatch(notice.message, /retained|Scope acquisition failed|private-holder-session|private-start-time|98765|"holder"/);
			await pi.commands.get("leases")?.handler("", ctx);
			const diagnostics = JSON.parse(ctx.notifications.at(-1)!.message);
			assert.equal(diagnostics.lastFailure.result.kind, "contended");
			assert.equal(diagnostics.lastFailure.result.holder?.sessionId, holder?.sessionId);
		});
	}
});

test("contention roots are terminal-safe and bounded without hiding recovery guidance", async (t) => {
	for (const root of ["/repo\u001b[31m\u009b\n", `/repo\u001b${"x".repeat(20_000)}`]) {
		await t.test(root.length > 1000 ? "oversized root" : "control characters", async () => {
			const { pi } = harness([{ kind: "contended", root }]);
			const ctx = context();
			await pi.emit("session_start", ctx);
			const message = ctx.notifications.at(-1)!.message;
			assert.doesNotMatch(message, /[\u0000-\u001f\u007f-\u009f]/);
			assert.ok(message.includes("\\u001b"));
			assert.ok(message.length < 2000);
			if (root.length > 1000) assert.match(message, /truncated/);
			assert.match(message, /writes remain guarded/);
			for (const action of ["/leases", "/plan", "/implement"]) assert.ok(message.includes(action));
		});
	}
});

test("non-contention acquisition failures stay errors without claiming retained leases", async () => {
	const { pi, controller } = harness([], { acquireLease: async () => { throw new Error("identity lookup failed"); } });
	const ctx = context();
	await pi.emit("session_start", ctx);
	assert.equal(controller.state, "plan");
	assert.equal(pi.activeTools.includes("write"), false);
	const notice = ctx.notifications.at(-1)!;
	assert.equal(notice.level, "error");
	assert.match(notice.message, /"kind":"invalid"/);
	assert.match(notice.message, /identity lookup failed/);
	assert.match(notice.message, /writes remain guarded/);
	assert.doesNotMatch(notice.message, /retained|another live session/);
});

test("unavailable explicit scopes stay guarded while legacy implicit failures remain unguarded", async (t) => {
	for (const reason of ["git-unavailable", "flock-unavailable", "lease-error"] as const) {
		await t.test(reason, async () => {
			const explicit = harness([{ kind: "unguarded", reason, detail: "diagnostic detail" }]);
			const ctx = context();
			ctx.cwd = process.cwd();
			explicit.pi.leaseRootsFlag = JSON.stringify([ctx.cwd]);
			await explicit.pi.emit("session_start", ctx);
			assert.equal(explicit.controller.state, "plan");
			assert.equal(explicit.pi.activeTools.includes("write"), false);
			assert.deepEqual(explicit.controller.roots, []);
			const notice = ctx.notifications.at(-1)!;
			assert.equal(notice.level, "error");
			assert.ok(notice.message.includes(reason));
			assert.match(notice.message, /diagnostic detail/);
			assert.match(notice.message, /writes remain guarded/);
			assert.doesNotMatch(notice.message, /retained|another live session/);
			const implicit = harness([{ kind: "unguarded", reason }]);
			const implicitContext = context();
			await implicit.pi.emit("session_start", implicitContext);
			assert.equal(implicit.controller.state, "unguarded");
			assert.equal(implicit.pi.activeTools.includes("write"), true);
			assert.equal(implicitContext.notifications.at(-1)!.message, `Session guard unavailable (${reason}). This session is unguarded.`);
		});
	}
});

test("fresh replacement does not inherit outgoing interactive plan selection", async () => {
	const outgoing = harness([]);
	const planBranch = [{ type: "custom", customType: "session-mode", data: { version: 2, mode: "plan" } }];
	const oldContext = context(planBranch);
	await outgoing.pi.emit("session_start", oldContext);
	assert.equal(outgoing.controller.state, "plan");
	await outgoing.pi.emit("session_shutdown", oldContext);
	assert.deepEqual(outgoing.acquisitions, []);
	const replacement = harness([]);
	const newContext = context([]);
	newContext.cwd = process.cwd();
	await replacement.pi.emit("session_start", newContext);
	assert.deepEqual(replacement.acquisitions, []);
	assert.equal(replacement.controller.state, "lazy");
	assert.deepEqual(replacement.pi.appended, []);
});

test("implicit cwd contention retains implementation intent for a later restore", async () => {
	const { pi, controller } = harness([{ kind: "contended", root: "/repo" }]);
	pi.planFlag = true;
	const ctx = context();
	await pi.emit("session_start", ctx);
	await pi.commands.get("implement")?.handler("", ctx);
	assert.equal(controller.state, "implement-blocked");
	assert.equal(controller.mode, "implement");
	assert.deepEqual(pi.appended.at(-1), { type: "session-mode", data: { version: 2, mode: "implement", scope: { kind: "cwd" } } });
});

test("explicit --plan wins over restored implement state and takes no lease", async () => {
	const branch = [{ type: "custom", customType: "session-mode", data: { version: 1, mode: "implement" } }];
	const { pi, acquisitions, controller } = harness([]);
	pi.planFlag = true;
	const ctx = context(branch);
	await pi.emit("session_start", ctx);
	assert.deepEqual(acquisitions, []);
	assert.equal(controller.state, "plan");
	assert.deepEqual(pi.activeTools, ["read", "bash", "questionnaire", "subagent"]);
});

test("restores plan only from the active branch", async () => {
	const activeBranch = [{ type: "custom", customType: "session-mode", data: { version: 1, mode: "plan" } }];
	const { pi, acquisitions, controller } = harness([]);
	await pi.emit("session_start", context(activeBranch));
	assert.equal(controller.state, "plan");
	assert.deepEqual(acquisitions, []);
});

test("explicit launcher implement mode wins over restored plan state", async () => {
	const activeBranch = [{ type: "custom", customType: "session-mode", data: { version: 1, mode: "plan" } }];
	const { pi, acquisitions, controller } = harness();
	pi.implementFlag = true;
	await pi.emit("session_start", context(activeBranch));
	assert.equal(controller.state, "implement");
	assert.deepEqual(acquisitions, ["acquire"]);
	assert.deepEqual(pi.appended.at(-1), { type: "session-mode", data: { version: 2, mode: "implement", scope: { kind: "cwd" } } });
});

test("rejects both mode changes while Pi is busy", async () => {
	const implement = harness();
	const implementContext = context();
	await implement.pi.emit("session_start", implementContext);
	implementContext.idle = false;
	await implement.pi.commands.get("plan")?.handler("", implementContext);
	assert.equal(implement.controller.state, "implement");
	assert.equal(implement.pi.appended.length, 0);
	assert.match(implementContext.notifications.at(-1)?.message ?? "", /busy/i);

	const plan = harness([]);
	plan.pi.planFlag = true;
	const planContext = context();
	await plan.pi.emit("session_start", planContext);
	planContext.idle = false;
	await plan.pi.commands.get("implement")?.handler("", planContext);
	assert.equal(plan.controller.state, "plan");
	assert.deepEqual(plan.acquisitions, []);
	assert.equal(plan.pi.appended.length, 0);
});

test("rejects both mode changes while messages are pending", async () => {
	const implement = harness();
	const implementContext = context();
	await implement.pi.emit("session_start", implementContext);
	implementContext.pendingMessages = true;
	await implement.pi.commands.get("plan")?.handler("", implementContext);
	assert.equal(implement.controller.state, "implement");
	assert.equal(implement.pi.appended.length, 0);
	assert.match(implementContext.notifications.at(-1)?.message ?? "", /busy/i);

	const plan = harness([]);
	plan.pi.planFlag = true;
	const planContext = context();
	await plan.pi.emit("session_start", planContext);
	planContext.pendingMessages = true;
	await plan.pi.commands.get("implement")?.handler("", planContext);
	assert.equal(plan.controller.state, "plan");
	assert.deepEqual(plan.acquisitions, []);
	assert.equal(plan.pi.appended.length, 0);
});

test("plan disables writes before releasing, warns when dirty, and persists", async () => {
	const order: string[] = [];
	const lease = held(order);
	const { pi, controller } = harness([lease]);
	pi.setActiveTools = (names: string[]) => { order.push("guard"); pi.activeTools = [...names]; };
	pi.exec = async () => ({ code: 0, stdout: " M file.ts\n", stderr: "" });
	const ctx = context();
	await pi.emit("session_start", ctx);
	order.length = 0;
	await pi.commands.get("plan")?.handler("", ctx);
	assert.deepEqual(order, ["guard", "release"]);
	assert.equal(controller.state, "plan");
	assert.match(ctx.notifications.map((n) => n.message).join("\n"), /dirty/i);
	assert.deepEqual(pi.appended.at(-1), { type: "session-mode", data: { version: 2, mode: "plan" } });
});

test("plan intent is saved before advisory checks can be interrupted by shutdown", async () => {
	const { pi } = harness();
	const ctx = context();
	await pi.emit("session_start", ctx);
	let started!: () => void;
	let finish!: () => void;
	const checking = new Promise<void>((resolve) => { started = resolve; });
	const gate = new Promise<void>((resolve) => { finish = resolve; });
	pi.exec = async () => { started(); await gate; return { code: 0, stdout: "", stderr: "" }; };
	const planning = pi.commands.get("plan")?.handler("", ctx);
	await checking;
	await pi.emit("session_shutdown", ctx);
	finish();
	await planning;
	assert.deepEqual(pi.appended.at(-1), { type: "session-mode", data: { version: 2, mode: "plan" } });
});

test("a failed plan checkpoint never prevents lease release", async () => {
	const releases: string[] = [];
	const { pi, controller } = harness([held(releases)]);
	const ctx = context();
	await pi.emit("session_start", ctx);
	pi.appendEntry = () => { throw new Error("checkpoint unavailable"); };
	await assert.rejects(async () => pi.commands.get("plan")?.handler("", ctx), /checkpoint unavailable/);
	assert.deepEqual(releases, ["release"]);
	assert.deepEqual(controller.roots, []);
	assert.equal(pi.activeTools.includes("write"), false);
});

test("clean /plan transition does not emit a dirty-worktree warning", async () => {
	const { pi } = harness();
	const ctx = context();
	await pi.emit("session_start", ctx);
	await pi.commands.get("plan")?.handler("", ctx);
	assert.doesNotMatch(ctx.notifications.map((n) => n.message).join("\n"), /dirty/i);
});

test("guarded state independently blocks hidden tools, mutating Bash, and writer subagents", async () => {
	const { pi } = harness([]);
	const ctx = context();
	pi.planFlag = true;
	await pi.emit("session_start", ctx);
	for (const [toolName, input] of [
		["write", { path: "x", content: "x" }],
		["powershell", { command: "Set-Content x nope" }],
		["bash", { command: "git commit -m nope" }],
		["subagent", { agent: "worker" }],
	] as const) {
		const [result] = await pi.emit("tool_call", ctx, { toolName, input });
		assert.equal((result as { block?: boolean })?.block, true, toolName);
	}
	const [readResult] = await pi.emit("tool_call", ctx, { toolName: "read", input: { path: "x" } });
	assert.equal(readResult, undefined);
});

test("plan guidance allows resolver-proven local Beads writes beyond cwd without source authority", async () => {
	const { pi, controller, acquisitions } = harness([]);
	const ctx = context();
	pi.planFlag = true;
	await pi.emit("session_start", ctx);
	const [prompt] = await pi.emit("before_agent_start", ctx, { systemPrompt: "base prompt" });
	const text = (prompt as { systemPrompt: string }).systemPrompt;
	assert.match(text, /base prompt/);
	assert.match(text, /local mutation in any resolver-proven owning store, not only cwd/);
	assert.match(text, /bd -C <proven directory>/);
	assert.match(text, /without \/implement or a worktree lease/);
	assert.match(text, /ambiguous, unavailable or not-found.*write nothing/);
	assert.match(text, /repository-specific tracker rules still win/);
	assert.match(text, /Beads writes do not acquire source leases/);
	assert.match(text, /export, backup and synchronization side effects/);
	assert.match(text, /\/implement alone does not authorize remote or destructive actions/);
	assert.match(text, /make beads-sync after fresh explicit confirmation/i);
	assert.match(text, /never.*list.*resolver.*triage/i);
	for (const command of [
		"bd -C /abs/other-store comments add fixture-1 'git push; rm file > out'",
		"bd -C /abs/other-store create 'delete cleanup' --type task",
		"bd -C /abs/other-store update fixture-1 --append-notes 'npm install'",
		"bd -C /abs/other-store close fixture-1 --reason 'done'",
	]) {
		assert.deepEqual(await pi.emit("tool_call", ctx, { toolName: "bash", input: { command } }), [undefined]);
	}
	assert.equal(controller.state, "plan");
	assert.deepEqual(controller.roots, []);
	assert.deepEqual(acquisitions, []);
	assert.deepEqual(pi.execCalls, []);
	assert.deepEqual(pi.appended, []);
	assert.equal(pi.activeTools.includes("write"), false);
});

test("guarded mode permits verified read-only delegation and inspected composites", async () => {
	const { pi } = harness([], { readOnlySubagents: async () => new Set(["reviewer"]) });
	const ctx = context();
	pi.planFlag = true;
	await pi.emit("session_start", ctx);

	for (const [toolName, input] of [
		["subagent", { action: "status", id: "run-1" }],
		["subagent", { agent: "reviewer", task: "Review" }],
		["multi_tool_use.parallel", { tool_uses: [
			{ recipient_name: "functions.read", parameters: { path: "README.md" } },
			{ recipient_name: "functions.web_search", parameters: { query: "Pi" } },
		] }],
	] as const) {
		const [result] = await pi.emit("tool_call", ctx, { toolName, input });
		assert.equal(result, undefined, toolName);
	}

	const [worker] = await pi.emit("tool_call", ctx, { toolName: "subagent", input: { agent: "worker", task: "Review" } });
	assert.equal((worker as { block?: boolean })?.block, true);
});

test("model changes clear stale read-only agent approval before refreshing", async () => {
	let resolveInitial: ((agents: ReadonlySet<string>) => void) | undefined;
	const initial = new Promise<ReadonlySet<string>>((resolve) => (resolveInitial = resolve));
	const { pi } = harness([], {
		readOnlySubagents: async (_cwd, provider) => provider === "provider-a" ? initial : new Set(),
	});
	pi.planFlag = true;
	const ctx = context();
	const start = pi.emit("session_start", ctx);
	await Promise.resolve();
	await pi.emit("model_select", ctx, { model: { provider: "provider-b" } });
	resolveInitial?.(new Set(["reviewer"]));
	await start;

	const [reviewer] = await pi.emit("tool_call", ctx, { toolName: "subagent", input: { agent: "reviewer", task: "Review" } });
	assert.equal((reviewer as { block?: boolean })?.block, true);
});

test("guarded mode fails closed and warns once per episode when read-only agent verification fails", async () => {
	const { pi } = harness([held()], { readOnlySubagents: async () => { throw new Error("unavailable"); } });
	const ctx = context();
	pi.planFlag = true;
	await pi.emit("session_start", ctx);
	const [reviewer] = await pi.emit("tool_call", ctx, { toolName: "subagent", input: { agent: "reviewer", task: "Review" } });
	assert.equal((reviewer as { block?: boolean })?.block, true);
	assert.equal(ctx.notifications.filter((notification) => /read-only subagent verification failed/i.test(notification.message)).length, 1);

	await pi.emit("model_select", ctx, { model: { provider: "provider-b" } });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(ctx.notifications.filter((notification) => /read-only subagent verification failed/i.test(notification.message)).length, 1);

	await pi.commands.get("implement")?.handler("", ctx);
	await pi.commands.get("plan")?.handler("", ctx);
	assert.equal(ctx.notifications.filter((notification) => /read-only subagent verification failed/i.test(notification.message)).length, 2);
});

test("guarded mode does not warn when discovery succeeds without approved agents", async () => {
	const { pi } = harness([], { readOnlySubagents: async () => new Set() });
	const ctx = context();
	pi.planFlag = true;
	await pi.emit("session_start", ctx);

	const [reviewer] = await pi.emit("tool_call", ctx, { toolName: "subagent", input: { agent: "reviewer", task: "Review" } });
	assert.equal((reviewer as { block?: boolean })?.block, true);
	assert.doesNotMatch(ctx.notifications.map((notification) => notification.message).join("\n"), /verification failed/i);
});

test("keeps writes guarded until /implement finishes acquiring", async () => {
	let resolveLease: ((result: WorktreeLeaseResult) => void) | undefined;
	const pending = new Promise<WorktreeLeaseResult>((resolve) => (resolveLease = resolve));
	const { pi, controller } = harness([], { acquireLease: async () => pending });
	pi.planFlag = true;
	const ctx = context();
	await pi.emit("session_start", ctx);
	const transition = pi.commands.get("implement")?.handler("", ctx);
	await Promise.resolve();
	assert.equal(controller.state, "acquiring");
	assert.equal(pi.activeTools.includes("write"), false);
	resolveLease?.(held());
	await transition;
	assert.equal(controller.state, "implement");
	assert.equal(pi.activeTools.includes("write"), true);
});

test("plan cancels and drains a pending implement acquisition", async () => {
	let resolveLease: ((result: WorktreeLeaseResult) => void) | undefined;
	let started!: () => void;
	const acquiring = new Promise<void>((resolve) => { started = resolve; });
	const pending = new Promise<WorktreeLeaseResult>((resolve) => (resolveLease = resolve));
	const releases: string[] = [];
	const { pi, controller } = harness([], { acquireLease: async () => { started(); return pending; } });
	const ctx = context();

	const startup = pi.emit("session_start", ctx);
	await acquiring;
	assert.equal(controller.state, "acquiring");

	const planning = pi.commands.get("plan")?.handler("", ctx);
	assert.equal(controller.mode, "plan");
	assert.equal(controller.state, "plan");
	resolveLease?.(held(releases));
	await Promise.all([startup, planning]);

	assert.deepEqual(releases, ["release"]);
	assert.equal(controller.mode, "plan");
	assert.equal(controller.state, "plan");
	assert.equal(pi.activeTools.includes("write"), false);
});

test("a superseded /implement command does not persist after /plan", async () => {
	let resolveLease: ((result: WorktreeLeaseResult) => void) | undefined;
	let started!: () => void;
	const acquiring = new Promise<void>((resolve) => { started = resolve; });
	const pending = new Promise<WorktreeLeaseResult>((resolve) => (resolveLease = resolve));
	const { pi } = harness([], { acquireLease: async () => { started(); return pending; } });
	pi.planFlag = true;
	const ctx = context();
	await pi.emit("session_start", ctx);

	const implement = pi.commands.get("implement")?.handler("", ctx);
	await acquiring;
	const planning = pi.commands.get("plan")?.handler("", ctx);
	resolveLease?.(held());
	await Promise.all([implement, planning]);

	assert.deepEqual(pi.appended, [
		{ type: "session-mode", data: { version: 1, mode: "plan" } },
		{ type: "session-mode", data: { version: 2, mode: "plan" } },
	]);
});

test("a completed /plan transition supersedes pending contention diagnostics", async () => {
	let refreshResolve: (() => void) | undefined;
	const refresh = new Promise<void>((resolve) => (refreshResolve = resolve));
	const { pi, controller } = harness([{ kind: "contended", root: "/repo" }], {
		readOnlySubagents: async () => {
			await refresh;
			return new Set();
		},
	});
	const ctx = context();

	const startup = pi.emit("session_start", ctx);
	await Promise.resolve();
	await Promise.resolve();
	const plan = pi.commands.get("plan")?.handler("", ctx);
	refreshResolve?.();
	await Promise.all([startup, plan]);

	assert.equal(controller.mode, "plan");
	assert.equal(controller.state, "plan");
	assert.equal(pi.activeTools.includes("write"), false);
});

test("implement waits for an in-progress plan release before reacquiring", async () => {
	let releaseResolve: (() => void) | undefined;
	const releaseGate = new Promise<void>((resolve) => (releaseResolve = resolve));
	let releaseFinished = false;
	let acquisitionCount = 0;
	const firstLease: HeldWorktreeLease = {
		kind: "held",
		root: "/repo",
		holderPid: 123,
		lost: new Promise(() => undefined),
		async release() {
			await releaseGate;
			releaseFinished = true;
		},
	};
	const { pi, controller } = harness([], {
		acquireLease: async () => {
			acquisitionCount += 1;
			if (acquisitionCount === 1) return firstLease;
			return releaseFinished ? held() : { kind: "contended", root: "/repo" };
		},
	});
	const ctx = context();
	await pi.emit("session_start", ctx);

	const plan = pi.commands.get("plan")?.handler("", ctx);
	await Promise.resolve();
	const implement = pi.commands.get("implement")?.handler("", ctx);
	await Promise.resolve();
	releaseResolve?.();
	await Promise.all([plan, implement]);

	assert.equal(acquisitionCount, 2);
	assert.equal(controller.mode, "implement");
	assert.equal(controller.state, "implement");
});

test("concurrent implement transitions share one lease acquisition", async () => {
	let acquired!: () => void;
	const entered = new Promise<void>((done) => { acquired = done; });
	let resolveLease: ((result: WorktreeLeaseResult) => void) | undefined;
	const pending = new Promise<WorktreeLeaseResult>((resolve) => (resolveLease = resolve));
	let acquisitionCount = 0;
	const { pi, controller } = harness([], {
		acquireLease: async () => {
			acquisitionCount += 1;
			acquired();
			return pending;
		},
	});
	const ctx = context();

	const startup = pi.emit("session_start", ctx);
	await entered;
	const command = pi.commands.get("implement")?.handler("", ctx);
	await Promise.resolve();
	assert.equal(acquisitionCount, 1);

	resolveLease?.(held());
	await Promise.all([startup, command]);
	assert.equal(controller.state, "implement");
	assert.equal(pi.activeTools.includes("write"), true);
});

test("contention and holder loss use the same guarded tool path", async () => {
	const contended = harness([{ kind: "contended", root: "/repo", holder: { root: "/repo", pid: 9, parentPid: 8, sessionId: "other", startedAt: "now" } }]);
	const contendedContext = context();
	await contended.pi.emit("session_start", contendedContext);
	assert.equal(contended.controller.state, "implement-blocked");
	assert.equal(contended.pi.activeTools.includes("write"), false);
	assert.match(contendedContext.notifications.at(-1)?.message ?? "", /another live session/);
	assert.doesNotMatch(contendedContext.notifications.at(-1)?.message ?? "", /"sessionId"/);

	let lose: (() => void) | undefined;
	const lostLease: HeldWorktreeLease = {
		kind: "held",
		root: "/repo",
		holderPid: 10,
		lost: new Promise<void>((resolve) => (lose = resolve)),
		async release() {},
	};
	const lost = harness([lostLease]);
	const lostContext = context();
	await lost.pi.emit("session_start", lostContext);
	lose?.();
	await Promise.resolve();
	assert.equal(lost.controller.state, "lost");
	assert.equal(lost.pi.activeTools.includes("write"), false);
});

test("lost-lease UI failures stay contained with write tools guarded", async () => {
	let lose: (() => void) | undefined;
	const lostLease: HeldWorktreeLease = {
		kind: "held",
		root: "/repo",
		holderPid: 10,
		lost: new Promise<void>((resolve) => (lose = resolve)),
		async release() {},
	};
	const { pi, controller } = harness([lostLease]);
	const ctx = context();
	await pi.emit("session_start", ctx);
	ctx.ui.setStatus = () => { throw new Error("UI unavailable"); };

	lose?.();
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(controller.state, "lost");
	assert.equal(pi.activeTools.includes("write"), false);
});

test("malformed scope arguments remain visible after lease loss", async () => {
	let lose!: () => void;
	const lease = held();
	lease.lost = new Promise<void>((resolve) => { lose = resolve; });
	const { pi, controller } = harness([lease]);
	const ctx = context();
	await pi.emit("session_start", ctx);
	lose();
	await new Promise((resolve) => setImmediate(resolve));
	const count = ctx.notifications.length;
	await pi.commands.get("implement")?.handler('"unfinished', ctx);
	assert.equal(controller.state, "lost");
	assert.ok(ctx.notifications.length > count);
	assert.match(ctx.notifications.at(-1)?.message ?? "", /Unterminated/);
});

test("headless plan mode guards without prompting", async () => {
	const { pi, controller } = harness([]);
	pi.planFlag = true;
	const ctx = context();
	ctx.mode = "print";
	ctx.hasUI = false;
	await pi.emit("session_start", ctx);
	assert.equal(controller.state, "plan");
	assert.deepEqual(ctx.notifications, []);
	const [result] = await pi.emit("tool_call", ctx, { toolName: "write", input: { path: "x" } });
	assert.equal((result as { block?: boolean })?.block, true);
});

test("kill switch fails open with a prominent unguarded status", async () => {
	const { pi, acquisitions, controller } = harness([], { isDisabled: () => true });
	pi.planFlag = true;
	const ctx = context();
	await pi.emit("session_start", ctx);
	assert.deepEqual(acquisitions, []);
	assert.equal(controller.state, "unguarded");
	assert.equal(pi.activeTools.includes("write"), true);
	assert.equal(ctx.statuses.at(-1), "unguarded");
	const [workflow] = await pi.emit("tool_call", ctx, { toolName: "subagent", input: { workflowScript: "return runs.run('writer', { agent: 'worker' })" } });
	assert.equal(workflow, undefined);
});

test("an already implementing session does not contend with its own lease", async () => {
	const { pi, acquisitions, controller } = harness();
	const ctx = context();
	await pi.emit("session_start", ctx);
	await pi.commands.get("implement")?.handler("", ctx);
	assert.deepEqual(acquisitions, ["acquire"]);
	assert.equal(controller.state, "implement");
});

test("reload lifecycle releases before reacquiring and exposes a lost race as conflict", async () => {
	const releases: string[] = [];
	const { pi, acquisitions, controller } = harness([
		held(releases),
		{ kind: "contended", root: "/repo" },
	]);
	const ctx = context();
	await pi.emit("session_start", ctx);
	await pi.emit("session_shutdown", ctx, { reason: "reload" });
	await pi.emit("session_start", ctx, { reason: "reload" });
	assert.deepEqual(releases, ["release"]);
	assert.deepEqual(acquisitions, ["acquire", "acquire"]);
	assert.equal(controller.state, "implement-blocked");
	assert.equal(ctx.statuses.at(-1), "conflict");
});

test("shutdown waits for a pending acquisition and releases its result", async () => {
	let resolveLease: ((result: WorktreeLeaseResult) => void) | undefined;
	let started!: () => void;
	const acquiring = new Promise<void>((resolve) => { started = resolve; });
	const pending = new Promise<WorktreeLeaseResult>((resolve) => (resolveLease = resolve));
	const releases: string[] = [];
	const { pi } = harness([], { acquireLease: async () => { started(); return pending; } });
	pi.planFlag = true;
	const ctx = context();
	await pi.emit("session_start", ctx);

	const transition = pi.commands.get("implement")?.handler("", ctx);
	await acquiring;
	let shutdownFinished = false;
	const shutdown = pi.emit("session_shutdown", ctx).then(() => { shutdownFinished = true; });
	await new Promise<void>((resolve) => setImmediate(resolve));
	const finishedBeforeAcquisition = shutdownFinished;
	resolveLease?.(held(releases));
	await Promise.all([transition, shutdown]);

	assert.equal(finishedBeforeAcquisition, false);
	assert.deepEqual(releases, ["release"]);
	assert.deepEqual(pi.appended, []);
});

test("shutdown releases the held lease, restores tools, and clears status", async () => {
	const releases: string[] = [];
	const { pi } = harness([held(releases)]);
	const ctx = context();
	await pi.emit("session_start", ctx);
	await pi.commands.get("plan")?.handler("", ctx);
	await pi.emit("session_shutdown", ctx);
	assert.deepEqual(releases, ["release"]);
	assert.equal(pi.activeTools.includes("write"), true);
	assert.equal(ctx.statuses.at(-1), undefined);
});

const activationSource = (version: string) => `git:github.com/flurdy/pi-session-mode${String.fromCharCode(64)}${version}`;

function preparedActivation(): PreparedPackageActivation {
	return {
		revision: "a".repeat(64),
		display: {
			package: "session-mode",
			currentSource: activationSource("v0.3.0"),
			requestedSource: activationSource("v0.4.0"),
			currentCommit: "1".repeat(40),
			expectedCommit: "2".repeat(40),
			settingsPath: "/agent/settings.json",
			checkoutPath: "/agent/git/github.com/flurdy/pi-session-mode",
		},
		snapshot: {} as never,
	};
}

function activationOptions(overrides: Partial<NonNullable<SessionModeDependencies["packageActivation"]>> = {}) {
	const calls: string[] = [];
	const prepared = preparedActivation();
	const evidence: PackageActivationEvidence = {
		package: "session-mode",
		source: prepared.display.requestedSource,
		commit: prepared.display.expectedCommit,
		version: "0.4.0",
		verified: true,
	};
	const packageActivation: NonNullable<SessionModeDependencies["packageActivation"]> = {
		prepare: async () => { calls.push("prepare"); return prepared; },
		activate: async (_request, _prepared, options) => { calls.push("activate"); options?.beforeLaunch?.(); return evidence; },
		acquireSettingsLease: async () => ({
			kind: "held", file: prepared.display.settingsPath, holderPid: 321,
			lost: new Promise(() => undefined), alive: true,
			async release() { calls.push("release"); },
		}),
		...overrides,
	};
	return { calls, evidence, packageActivation };
}

const activationRequest: PackageActivationRequest = {
	package: "session-mode",
	version: "v0.4.0",
	expectedCommit: "2".repeat(40),
};

test("confirmed TUI activation uses live implementation authority and a serialized settings lease", async () => {
	const activation = activationOptions();
	const { pi } = harness([held()], { packageActivation: activation.packageActivation });
	const ctx = context();
	let confirmation = "";
	ctx.ui.confirm = async (_title: string, message: string) => { confirmation = message; return true; };
	await pi.emit("session_start", ctx);
	const tool = pi.tools.get("activate_pi_package");
	assert.ok(tool);
	const result = await tool.execute("call-1", activationRequest, new AbortController().signal, undefined, ctx);
	assert.deepEqual(activation.calls, ["prepare", "activate", "release"]);
	assert.deepEqual(result.details, activation.evidence);
	assert.match(confirmation, /v0\.3\.0/);
	assert.match(confirmation, /v0\.4\.0/);
	assert.match(confirmation, /2222222222222222222222222222222222222222/);
	assert.match(confirmation, /\/agent\/settings\.json/);
	assert.match(confirmation, /\/agent\/git\/github\.com\/flurdy\/pi-session-mode/);
});

test("package activation refuses guarded, headless, declined, stale and contended requests", async (t) => {
	await t.test("plan mode", async () => {
		const activation = activationOptions();
		const { pi } = harness([], { packageActivation: activation.packageActivation });
		pi.planFlag = true;
		const ctx = context();
		await pi.emit("session_start", ctx);
		await assert.rejects(pi.tools.get("activate_pi_package")!.execute("call", activationRequest, undefined, undefined, ctx), /live implement mode/);
		assert.deepEqual(activation.calls, []);
	});
	await t.test("RPC and headless modes", async () => {
		for (const mode of ["rpc", "print", "json"]) {
			const activation = activationOptions();
			const { pi } = harness([held()], { packageActivation: activation.packageActivation });
			const ctx = context();
			ctx.mode = mode;
			await pi.emit("session_start", ctx);
			await assert.rejects(pi.tools.get("activate_pi_package")!.execute("call", activationRequest, undefined, undefined, ctx), /interactive TUI/);
			assert.deepEqual(activation.calls, []);
		}
	});
	await t.test("conflict and guard bypass", async () => {
		for (const disabled of [false, true]) {
			const activation = activationOptions();
			const { pi } = harness([{ kind: "contended", root: "/repo" }], { packageActivation: activation.packageActivation, isDisabled: () => disabled });
			const ctx = context();
			await pi.emit("session_start", ctx);
			await assert.rejects(pi.tools.get("activate_pi_package")!.execute("call", activationRequest, undefined, undefined, ctx), /live implement mode/);
			assert.deepEqual(activation.calls, []);
		}
	});
	await t.test("file-only implement", async () => {
		const activation = activationOptions();
		const { pi, controller } = harness([], {
			packageActivation: activation.packageActivation,
			resolveFiles: async () => ["/config"],
			acquireFile: async () => ({ kind: "held", file: "/config", holderPid: 123, alive: true, lost: new Promise(() => {}), release: async () => {} }),
		});
		pi.planFlag = true;
		const ctx = context();
		await pi.emit("session_start", ctx);
		await pi.commands.get("grant-file")!.handler("/config", ctx);
		assert.equal(controller.state, "implement");
		assert.deepEqual(controller.roots, []);
		await assert.rejects(pi.tools.get("activate_pi_package")!.execute("call", activationRequest, undefined, undefined, ctx), /live implement mode/);
		assert.deepEqual(activation.calls, []);
	});
	await t.test("declined confirmation", async () => {
		const activation = activationOptions();
		const { pi } = harness([held()], { packageActivation: activation.packageActivation });
		const ctx = context();
		ctx.ui.confirm = async () => false;
		await pi.emit("session_start", ctx);
		const result = await pi.tools.get("activate_pi_package")?.execute("call", activationRequest, undefined, undefined, ctx);
		assert.deepEqual(activation.calls, ["prepare"]);
		assert.match(result.content[0].text, /cancelled/);
	});
	await t.test("authorization changes during confirmation", async () => {
		const activation = activationOptions();
		const { pi } = harness([held()], { packageActivation: activation.packageActivation });
		const ctx = context();
		ctx.ui.confirm = async () => { ctx.mode = "rpc"; return true; };
		await pi.emit("session_start", ctx);
		await assert.rejects(pi.tools.get("activate_pi_package")!.execute("call", activationRequest, undefined, undefined, ctx), /authorization context changed/);
		assert.deepEqual(activation.calls, ["prepare"]);
	});
	await t.test("authorization changes during final preflight", async () => {
		const activation = activationOptions();
		const { pi } = harness([held()], { packageActivation: activation.packageActivation });
		const ctx = context();
		activation.packageActivation.activate = async (_request, _prepared, options) => {
			activation.calls.push("activate");
			ctx.mode = "rpc";
			options?.beforeLaunch?.();
			return activation.evidence;
		};
		await pi.emit("session_start", ctx);
		await assert.rejects(pi.tools.get("activate_pi_package")!.execute("call", activationRequest, undefined, undefined, ctx), /during final preflight/);
		assert.deepEqual(activation.calls, ["prepare", "activate", "release"]);
	});
	await t.test("settings lease contention", async () => {
		const activation = activationOptions({
			acquireSettingsLease: async (): Promise<FileLeaseResult> => ({ kind: "contended", file: "/agent/settings.json" }),
		});
		const { pi } = harness([held()], { packageActivation: activation.packageActivation });
		const ctx = context();
		await pi.emit("session_start", ctx);
		await assert.rejects(pi.tools.get("activate_pi_package")!.execute("call", activationRequest, undefined, undefined, ctx), /already running/);
		assert.deepEqual(activation.calls, ["prepare"]);
	});
});

test("shutdown drains an installer already launched before releasing session leases", async () => {
	let started!: () => void, finish!: () => void;
	const launching = new Promise<void>((resolve) => { started = resolve; });
	const pending = new Promise<void>((resolve) => { finish = resolve; });
	const releases: string[] = [];
	const activation = activationOptions();
	activation.packageActivation.activate = async (_request, _prepared, options) => {
		options?.beforeLaunch?.();
		started();
		await pending;
		return activation.evidence;
	};
	const { pi } = harness([held(releases)], { packageActivation: activation.packageActivation });
	const ctx = context();
	await pi.emit("session_start", ctx);
	const running = pi.tools.get("activate_pi_package")!.execute("call", activationRequest, undefined, undefined, ctx);
	await launching;
	let stopped = false;
	const stopping = pi.emit("session_shutdown", ctx).then(() => { stopped = true; });
	await new Promise<void>((resolve) => setImmediate(resolve));
	const premature = stopped || releases.length > 0;
	finish();
	await Promise.all([running, stopping]);
	assert.equal(premature, false);
	assert.deepEqual(releases, ["release"]);
	assert.deepEqual(activation.calls, ["prepare", "release"]);
});

test("concurrent activation calls are rejected before duplicate confirmation", async () => {
	let confirmFirst!: (value: boolean) => void;
	const waiting = new Promise<boolean>((resolve) => (confirmFirst = resolve));
	const activation = activationOptions();
	const { pi } = harness([held()], { packageActivation: activation.packageActivation });
	const ctx = context();
	ctx.ui.confirm = async () => waiting;
	await pi.emit("session_start", ctx);
	const tool = pi.tools.get("activate_pi_package")!;
	const first = tool.execute("first", activationRequest, undefined, undefined, ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await assert.rejects(tool.execute("second", activationRequest, undefined, undefined, ctx), /already running/);
	confirmFirst(false);
	await first;
	assert.deepEqual(activation.calls, ["prepare"]);
});

const lazyEntry = (originCwd: string, files?: string[]) => ({ type: "custom", customType: "session-mode", data: { version: 4, mode: "implement", scope: { kind: "lazy", originCwd }, ...(files ? { files } : {}) } });
function fileLease(file: string, releases: string[] = []): FileLeaseResult {
	return { kind: "held", file, holderPid: 321, lost: new Promise(() => undefined), async release() { releases.push(file); } };
}
function fileOptions(acquire: (file: string) => FileLeaseResult): Partial<SessionModeDependencies> {
	return {
		acquireFile: async (file) => acquire(file),
		resolveFiles: async (paths) => paths.map((path) => path.startsWith("file://") ? fileURLToPath(path) : path).sort(),
	};
}
function realContext(branch?: any[]) {
	const ctx = context(branch);
	ctx.cwd = process.cwd();
	return ctx;
}
const releaseTool = (pi: FakePi, ctx: ReturnType<typeof context>, params: Record<string, unknown> = {}) =>
	pi.tools.get("release_scopes")!.execute("call", params, undefined, undefined, ctx);
const dirtyExec = (pi: FakePi) => async (command: string, args: string[]) => {
	pi.execCalls.push([command, ...args]);
	return { code: 0, stdout: " M file.ts\n", stderr: "" };
};

test("fresh sessions start lazy without a lease or checkpoint; --lazy persists and overrides restored scopes", async () => {
	const here = await realpath(process.cwd());
	const fresh = harness([]);
	const ctx = realContext([]);
	await fresh.pi.emit("session_start", ctx);
	assert.equal(fresh.controller.state, "lazy");
	assert.equal(fresh.controller.mode, "implement");
	assert.deepEqual(fresh.acquisitions, []);
	assert.deepEqual(fresh.pi.appended, []);
	assert.equal(fresh.pi.activeTools.includes("write"), true);
	assert.equal(ctx.statuses.at(-1), "lazy");
	for (const branch of [implicitCwd(), [{ type: "custom", customType: "session-mode", data: { version: 2, mode: "plan" } }]]) {
		const flagged = harness([]);
		flagged.pi.lazyFlag = true;
		await flagged.pi.emit("session_start", realContext(branch));
		assert.equal(flagged.controller.state, "lazy");
		assert.deepEqual(flagged.acquisitions, []);
		assert.deepEqual(flagged.pi.appended.map((entry) => entry.data), [{ version: 1, mode: "plan" }, { version: 4, mode: "implement", scope: { kind: "lazy", originCwd: here } }]);
	}
});

test("--plan wins over --lazy, and --lazy with another scope flag starts guarded without a checkpoint", async () => {
	const planned = harness([]);
	planned.pi.planFlag = true; planned.pi.lazyFlag = true;
	const ctx = realContext([]);
	await planned.pi.emit("session_start", ctx);
	assert.equal(planned.controller.state, "plan");
	assert.doesNotMatch(ctx.notifications.map((notice) => notice.message).join("\n"), /cannot be combined/);
	for (const configure of [(pi: FakePi) => { pi.implementFlag = true; }, (pi: FakePi) => { pi.leaseRootsFlag = JSON.stringify([process.cwd()]); }]) {
		const conflicting = harness([]);
		conflicting.pi.lazyFlag = true; configure(conflicting.pi);
		const conflictContext = realContext();
		await conflicting.pi.emit("session_start", conflictContext);
		assert.equal(conflicting.controller.state, "plan");
		assert.deepEqual(conflicting.acquisitions, []);
		assert.deepEqual(conflicting.pi.appended, []);
		assert.equal(conflicting.pi.activeTools.includes("write"), false);
		assert.match(conflictContext.notifications.at(-1)!.message, /--lazy cannot be combined with --implement or --lease-roots/);
	}
});

test("restored lazy selections hold no worktree, and a changed origin guards to plan", async () => {
	const here = await realpath(process.cwd());
	const restored = harness([]);
	await restored.pi.emit("session_start", realContext([lazyEntry(here)]));
	assert.equal(restored.controller.state, "lazy");
	assert.deepEqual(restored.acquisitions, []);
	assert.deepEqual(restored.pi.appended, []);
	const drifted = harness([]);
	const ctx = realContext([lazyEntry("/elsewhere")]);
	await drifted.pi.emit("session_start", ctx);
	assert.equal(drifted.controller.state, "plan");
	assert.equal(drifted.pi.activeTools.includes("write"), false);
	assert.match(ctx.notifications.at(-1)!.message, /origin cwd changed/);
	assert.deepEqual(drifted.pi.appended.at(-1), { type: "session-mode", data: { version: 2, mode: "plan" } });
});

test("restored lazy grants are reacquired without a prompt, and failed reacquisition stays guarded", async () => {
	const here = await realpath(process.cwd()), file = "/home/user/config.json";
	const restored = harness([], fileOptions((path) => fileLease(path)));
	await restored.pi.emit("session_start", realContext([lazyEntry(here, [file])]));
	assert.equal(restored.controller.state, "lazy");
	assert.deepEqual(restored.controller.files, [file]);
	assert.deepEqual(restored.acquisitions, []);
	const contended = harness([], fileOptions(() => ({ kind: "contended", file })));
	await contended.pi.emit("session_start", realContext([lazyEntry(here, [file])]));
	assert.notEqual(contended.controller.state, "lazy");
	assert.equal(contended.pi.activeTools.includes("write"), false);
	assert.deepEqual(contended.controller.files, []);
});

test("/lazy releases worktrees, keeps exact-file grants, persists, and warns about dirty roots", async () => {
	const here = await realpath(process.cwd()), file = "/home/user/config.json";
	const releases: string[] = [];
	const { pi, controller } = harness([held(releases)], fileOptions((path) => fileLease(path, releases)));
	const ctx = realContext();
	await pi.emit("session_start", ctx);
	await pi.commands.get("grant-file")?.handler(JSON.stringify(file), ctx);
	assert.deepEqual(controller.files, [file]);
	pi.exec = dirtyExec(pi);
	await pi.commands.get("lazy")?.handler("", ctx);
	assert.equal(controller.state, "lazy");
	assert.deepEqual(controller.roots, []);
	assert.deepEqual(controller.files, [file]);
	assert.deepEqual(releases, ["release"], "only the worktree lease is released");
	assert.deepEqual(pi.appended.at(-1)?.data, { version: 4, mode: "implement", scope: { kind: "lazy", originCwd: here }, files: [file] });
	assert.match(ctx.notifications.map((notice) => notice.message).join("\n"), /Returning to lazy mode with a dirty worktree: "\/repo"/);
	assert.equal(pi.activeTools.includes("write"), true);
});

test("/lazy from plan acquires nothing; busy, disabled and failed additions keep the prior state", async () => {
	const { pi, controller, acquisitions } = harness([{ kind: "contended", root: "/repo" }]);
	pi.planFlag = true;
	const ctx = realContext([]);
	await pi.emit("session_start", ctx);
	ctx.idle = false;
	await pi.commands.get("lazy")?.handler("", ctx);
	assert.equal(controller.state, "plan");
	ctx.idle = true;
	await pi.commands.get("lazy")?.handler("", ctx);
	assert.equal(controller.state, "lazy");
	assert.deepEqual(acquisitions, []);
	await pi.commands.get("implement")?.handler("", ctx);
	assert.equal(controller.state, "lazy");
	assert.match(ctx.notifications.at(-1)!.message, /held by another live session\. The session remains lazy/);
	await pi.commands.get("implement")?.handler('"unterminated', ctx);
	assert.equal(controller.state, "lazy");
	assert.equal(pi.activeTools.includes("write"), true);
	const disabled = harness([], { isDisabled: () => true });
	const disabledContext = realContext([]);
	await disabled.pi.emit("session_start", disabledContext);
	await disabled.pi.commands.get("lazy")?.handler("", disabledContext);
	assert.equal(disabled.controller.state, "unguarded");
	assert.match(disabledContext.notifications.at(-1)!.message, /unavailable while the guard is disabled/);
});

test("lazy sessions keep the guarded shell boundary and fixed-destination exceptions", async () => {
	const { pi } = harness([]);
	const ctx = realContext([]);
	await pi.emit("session_start", ctx);
	for (const [toolName, input] of [
		["bash", { command: "git commit -m nope" }],
		["subagent", { agent: "worker" }],
		["activate_pi_package", { package: "x", version: "v1.0.0", expectedCommit: "0".repeat(40) }],
		["multi_tool_use.parallel", { tool_uses: [{ recipient_name: "functions.publish_commit", parameters: { action: "execute", token: "0".repeat(32) } }] }],
	] as const) {
		const [result] = await pi.emit("tool_call", ctx, { toolName, input });
		assert.equal((result as { block?: boolean })?.block, true, toolName);
	}
	for (const event of [
		{ toolName: "bash", input: { command: "git status" } },
		{ toolName: "save_handoff", input: {} },
		{ toolName: "publish_commit", input: { action: "confirm", root: "/repo", commit: "abcdef1" } },
	]) assert.deepEqual(await pi.emit("tool_call", ctx, event), [undefined], event.toolName);
	const [prompt] = await pi.emit("before_agent_start", ctx, { systemPrompt: "base" });
	const text = (prompt as { systemPrompt: string }).systemPrompt;
	assert.match(text, /Lazy implementation: no worktree lease is held yet/);
	assert.match(text, /first native edit\/write acquires only its target's canonical Git worktree/);
	assert.match(text, /session stays lazy/);
	assert.match(text, /\/implement <root>/);
	assert.match(text, /save_handoff.*every guard state/);
	assert.doesNotMatch(text, /GUARDED SESSION/);
});

test("release_scopes is sequential, idempotent in lazy and changes nothing outside implement with worktrees", async () => {
	const lazy = harness([]);
	assert.equal((lazy.pi.tools.get("release_scopes") as { executionMode?: string }).executionMode, "sequential");
	const lazyContext = realContext([]);
	await lazy.pi.emit("session_start", lazyContext);
	assert.deepEqual((await releaseTool(lazy.pi, lazyContext)).details, { status: "lazy", released: [], files: [] });
	assert.deepEqual(lazy.pi.appended, []);

	const plan = harness([]); plan.pi.planFlag = true;
	const planContext = realContext([]);
	await plan.pi.emit("session_start", planContext);
	await assert.rejects(releaseTool(plan.pi, planContext), /current: plan\)\. Nothing was released/);
	assert.equal(plan.controller.state, "plan");

	const conflict = harness([{ kind: "contended", root: "/repo" }]);
	const conflictContext = realContext();
	await conflict.pi.emit("session_start", conflictContext);
	await assert.rejects(releaseTool(conflict.pi, conflictContext), /current: conflict\)/);
	assert.equal(conflict.controller.state, "implement-blocked");

	const fileOnly = harness([], fileOptions((path) => fileLease(path))); fileOnly.pi.planFlag = true;
	const fileContext = realContext([]);
	await fileOnly.pi.emit("session_start", fileContext);
	await fileOnly.pi.commands.get("grant-file")?.handler('"/home/user/config.json"', fileContext);
	assert.equal(fileOnly.controller.state, "implement");
	await assert.rejects(releaseTool(fileOnly.pi, fileContext), /current: implement\)\. Nothing was released/);
	assert.equal(fileOnly.controller.state, "implement", "file-only sessions never gain lazy worktree intent");

	const disabled = harness([], { isDisabled: () => true });
	const disabledContext = realContext([]);
	await disabled.pi.emit("session_start", disabledContext);
	await assert.rejects(releaseTool(disabled.pi, disabledContext), /guard is disabled/);
});

test("release_scopes releases clean worktrees to lazy, keeps grants, and blocks nested wrapper use", async () => {
	const here = await realpath(process.cwd()), file = "/home/user/config.json";
	const releases: string[] = [];
	const { pi, controller } = harness([held(releases)], fileOptions((path) => fileLease(path, releases)));
	const ctx = realContext();
	await pi.emit("session_start", ctx);
	const [prompt] = await pi.emit("before_agent_start", ctx, { systemPrompt: "base" });
	assert.match((prompt as { systemPrompt: string }).systemPrompt, /release_scopes returns held worktrees to lazy mode; it refuses dirty worktrees/);
	const [nested] = await pi.emit("tool_call", ctx, { toolName: "multi_tool_use.parallel", input: { tool_uses: [{ recipient_name: "functions.release_scopes", parameters: {} }] } });
	assert.equal((nested as { block?: boolean })?.block, true);
	await pi.commands.get("grant-file")?.handler(JSON.stringify(file), ctx);
	const result = await releaseTool(pi, ctx);
	assert.deepEqual(result.details, { status: "released", released: ["/repo"], dirty: [], files: [file], checkpoint: "saved" });
	assert.deepEqual(pi.execCalls.at(-1), ["git", "-C", "/repo", "status", "--porcelain"]);
	assert.equal(controller.state, "lazy");
	assert.deepEqual(controller.files, [file]);
	assert.deepEqual(releases, ["release"], "only the worktree lease is released");
	assert.deepEqual(pi.appended.at(-1)?.data, { version: 4, mode: "implement", scope: { kind: "lazy", originCwd: here }, files: [file] });
	assert.equal(ctx.statuses.at(-1), "lazy");
});

test("release_scopes refuses dirty or unverifiable worktrees unless explicitly allowed with a reason", async () => {
	const releases: string[] = [];
	const { pi, controller } = harness([held(releases)]);
	const ctx = realContext();
	await pi.emit("session_start", ctx);
	pi.exec = dirtyExec(pi);
	await assert.rejects(releaseTool(pi, ctx), /Refusing to release dirty worktrees \["\/repo"\].*ask the user.*Nothing was released/);
	assert.equal(controller.state, "implement");
	assert.deepEqual(controller.roots, ["/repo"]);
	const probes = pi.execCalls.length;
	for (const reason of [undefined, "   "]) await assert.rejects(releaseTool(pi, ctx, { allowDirty: true, reason }), /nonempty reason/);
	assert.equal(pi.execCalls.length, probes, "a missing reason refuses before probing");
	pi.exec = async () => ({ code: 128, stdout: "", stderr: "fatal" });
	await assert.rejects(releaseTool(pi, ctx), /git exited 128/);
	pi.exec = async () => { throw new Error("timed out"); };
	await assert.rejects(releaseTool(pi, ctx), /Cannot check "\/repo" for uncommitted changes: Error: timed out/);
	assert.deepEqual(releases, []);
	pi.exec = dirtyExec(pi);
	const result = await releaseTool(pi, ctx, { allowDirty: true, reason: "user parked WIP" });
	assert.deepEqual(result.details.dirty, ["/repo"]);
	assert.equal(result.details.reason, "user parked WIP");
	assert.equal(controller.state, "lazy");
	assert.match(ctx.notifications.map((notice) => notice.message).join("\n"), /Released dirty worktrees \["\/repo"\] on request: user parked WIP/);
});

test("release_scopes refuses during in-flight writes and its own checks, and blocks writes while releasing", async () => {
	const { pi, controller } = harness([held()]);
	const ctx = realContext();
	await pi.emit("session_start", ctx);
	await pi.emit("tool_execution_start", ctx, { toolCallId: "w1", toolName: "edit" });
	await assert.rejects(releaseTool(pi, ctx), /while a write.*Nothing was released/);
	await pi.emit("tool_execution_start", ctx, { toolCallId: "r1", toolName: "read" });
	await pi.emit("tool_execution_end", ctx, { toolCallId: "w1", toolName: "edit" });
	let started!: () => void, finish!: () => void;
	const checking = new Promise<void>((done) => { started = done; });
	const gate = new Promise<void>((done) => { finish = done; });
	pi.exec = async () => { started(); await gate; return { code: 0, stdout: "", stderr: "" }; };
	const first = releaseTool(pi, ctx);
	await checking;
	await assert.rejects(releaseTool(pi, ctx), /while a write, scope transition, package activation, release or shutdown/);
	const [write] = await pi.emit("tool_call", ctx, { toolName: "write", input: { path: "/repo/file", content: "x" } });
	assert.match((write as { reason: string }).reason, /release is busy/);
	finish();
	assert.equal((await first).details.status, "released");
	assert.equal(controller.state, "lazy");
	await pi.emit("tool_execution_start", ctx, { toolCallId: "leaked", toolName: "write" });
	await assert.rejects(releaseTool(pi, ctx), /while a write/);
	await pi.emit("agent_settled", ctx);
	assert.equal((await releaseTool(pi, ctx)).details.status, "lazy", "settlement clears unpaired write tracking");
});

test("release_scopes reports a failed checkpoint after releasing, and shutdown during checks releases nothing early", async () => {
	const releases: string[] = [];
	const failed = harness([held(releases)]);
	const ctx = realContext();
	await failed.pi.emit("session_start", ctx);
	failed.pi.appendEntry = () => { throw new Error("checkpoint unavailable"); };
	const result = await releaseTool(failed.pi, ctx);
	assert.equal(result.details.checkpoint, "failed");
	assert.deepEqual(releases, ["release"], "only the worktree lease is released");
	assert.equal(failed.controller.state, "lazy");
	assert.match(ctx.notifications.at(-1)!.message, /released, but lazy mode could not be saved; use --lazy/);

	const shutdown = harness([held()]);
	const shutdownContext = realContext();
	await shutdown.pi.emit("session_start", shutdownContext);
	let started!: () => void, finish!: () => void;
	const checking = new Promise<void>((done) => { started = done; });
	const gate = new Promise<void>((done) => { finish = done; });
	shutdown.pi.exec = async () => { started(); await gate; return { code: 0, stdout: "", stderr: "" }; };
	const releasing = releaseTool(shutdown.pi, shutdownContext);
	await checking;
	await shutdown.pi.emit("session_shutdown", shutdownContext);
	finish();
	await assert.rejects(releasing, /cancelled during checks\. Nothing was released/);
	assert.equal(shutdown.pi.appended.some((entry) => (entry.data as { version?: number }).version === 4), false);
});

test("release_scopes reports a lease loss during its release drain instead of selecting lazy", async () => {
	let releasing!: () => void, finishRelease!: () => void, loseFile!: () => void;
	const releaseStarted = new Promise<void>((done) => { releasing = done; });
	const gate = new Promise<void>((done) => { finishRelease = done; });
	const root: HeldWorktreeLease = { kind: "held", root: "/repo", holderPid: 123, lost: new Promise(() => undefined), async release() { releasing(); await gate; } };
	const file: FileLeaseResult = { kind: "held", file: "/home/user/config.json", holderPid: 321, lost: new Promise<void>((done) => { loseFile = done; }), async release() {} };
	const { pi, controller } = harness([root], fileOptions(() => file));
	const ctx = realContext();
	await pi.emit("session_start", ctx);
	await pi.commands.get("grant-file")?.handler('"/home/user/config.json"', ctx);
	const result = releaseTool(pi, ctx);
	await releaseStarted;
	loseFile();
	await new Promise((done) => setImmediate(done));
	finishRelease();
	await assert.rejects(result, /\["\/repo"\] were released, but the session is now lost before lazy mode was selected/);
	assert.equal(controller.state, "lost");
	assert.deepEqual(controller.files, []);
	assert.equal(pi.activeTools.includes("write"), false);
	assert.equal(pi.appended.some((entry) => (entry.data as { version?: number }).version === 4), false);
	assert.deepEqual(pi.appended.at(-1)?.data, { version: 2, mode: "plan" });
});
