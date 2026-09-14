import assert from "node:assert/strict";
import test from "node:test";
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
	leaseRootsFlag: string | undefined;

	registerFlag(): void {}
	getFlag(name: string): boolean | string | undefined { return name === "plan" ? this.planFlag : name === "implement" ? this.implementFlag : this.leaseRootsFlag; }
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

function context(branch: any[] = [], provider = "provider-a") {
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

test("defaults to implement and acquires before reporting write authority", async () => {
	const { pi, acquisitions, controller } = harness();
	const ctx = context();
	await pi.emit("session_start", ctx);
	assert.deepEqual(acquisitions, ["acquire"]);
	assert.equal(controller.state, "implement");
	assert.equal(ctx.statuses.at(-1), "implement");
	assert.deepEqual(pi.activeTools, ["read", "bash", "edit", "write", "questionnaire", "subagent"]);
});

test("fresh initial contention explains the held root without exposing holder metadata", async (t) => {
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
	const replacement = harness([{ kind: "contended", root: "/repo" }]);
	const newContext = context();
	await replacement.pi.emit("session_start", newContext);
	assert.deepEqual(replacement.acquisitions, ["acquire"]);
	assert.equal(replacement.controller.state, "implement-blocked");
	assert.match(newContext.notifications.at(-1)!.message, /another live session/);
	assert.doesNotMatch(newContext.notifications.at(-1)!.message, /retained/);
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
	let resolveLease: ((result: WorktreeLeaseResult) => void) | undefined;
	const pending = new Promise<WorktreeLeaseResult>((resolve) => (resolveLease = resolve));
	let acquisitionCount = 0;
	const { pi, controller } = harness([], {
		acquireLease: async () => {
			acquisitionCount += 1;
			return pending;
		},
	});
	const ctx = context();

	const startup = pi.emit("session_start", ctx);
	await Promise.resolve();
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
