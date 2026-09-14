import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireFileLease, acquireWorktreeLease, type FileLeaseResult, type WorktreeLeaseResult } from "./lease.ts";
import { LeaseSet, type HeldScopes, type LeaseSetResult, type ScopeSetRequest } from "./lease-set.ts";
import { probeWorktreeLeaseOccupancies } from "./lease-observer.ts";
import { guardedToolBlockReason } from "./policy.ts";
import { scopedWriteBlockReason } from "./scoped-policy.ts";
import { resolveExplicitFiles } from "./file-scope.ts";
import { ADDITION_TIMEOUT_MS, parseRootArguments, parseRootFlag, resolveExplicitRoots, safeDisplay, scopeStatus } from "./scope.ts";
import { restoreSelection, selectionEntries, selectionFiles, type Selection, type WorktreeSelection } from "./selection.ts";
import { verifiedReadOnlySubagents } from "./subagent-policy.ts";

export type SessionMode = "implement" | "plan";
export type SessionGuardState = "acquiring" | "implement" | "plan" | "implement-blocked" | "lost" | "unguarded";
export interface SessionModeDependencies {
	acquireLease(cwd: string, options: { sessionId: string; signal?: AbortSignal; expectedRoot?: string }): Promise<WorktreeLeaseResult>;
	acquireFile?(file: string, options: { sessionId: string; signal?: AbortSignal; expectedFile?: string }): Promise<FileLeaseResult>;
	resolveFiles?(paths: string[], cwd: string, signal?: AbortSignal): Promise<string[]>;
	isDisabled(): boolean;
	readOnlySubagents(cwd: string, preferredProvider?: string): Promise<ReadonlySet<string>>;
}
export interface SessionModeController {
	readonly mode: SessionMode;
	readonly state: SessionGuardState;
	readonly roots: readonly string[];
	readonly files: readonly string[];
}
interface Implementation {
	generation: number;
	key: string;
	requestedRoots: readonly string[];
	requestedFiles: readonly string[];
	persist: boolean;
	promise: Promise<void>;
}
const STATE_META: Record<SessionGuardState, { label: string; tone: "success" | "warning" | "error" }> = {
	acquiring: { label: "acquiring", tone: "warning" },
	implement: { label: "implement", tone: "success" },
	plan: { label: "plan", tone: "warning" },
	"implement-blocked": { label: "conflict", tone: "error" },
	lost: { label: "lost", tone: "error" },
	unguarded: { label: "unguarded", tone: "error" },
};
function grantStatus(files: readonly string[]): string {
	return scopeStatus(files).replace(/^leases:/, "grants:");
}
function boundedScopeList(values: readonly string[]): string {
	const visible: string[] = [];
	for (const value of values) {
		if (JSON.stringify([...visible, value]).length > 4000) break;
		visible.push(value);
	}
	return `${JSON.stringify(visible)}${visible.length < values.length ? ` (${values.length - visible.length} more; use the inspection command)` : ""}`;
}

export function registerSessionMode(pi: ExtensionAPI, dependencies: SessionModeDependencies = {
	acquireLease: acquireWorktreeLease,
	acquireFile: acquireFileLease,
	resolveFiles: resolveExplicitFiles,
	isDisabled: () => process.env.PI_SESSION_GUARD === "0",
	readOnlySubagents: (cwd, provider) => verifiedReadOnlySubagents(cwd, { preferredProvider: provider }),
}): SessionModeController {
	let mode: SessionMode = "implement";
	let state: SessionGuardState = "acquiring";
	let selection: Selection = { mode: "implement", scope: { kind: "cwd" } };
	let toolsBeforeGuard: string[] | undefined;
	let readOnlySubagents: ReadonlySet<string> = new Set();
	let discoveryFailed = false, warningShown = false, discoveryGeneration = 0;
	let generation = 0, shuttingDown = false;
	let currentContext: ExtensionContext | undefined;
	let implementation: Implementation | undefined;
	let dynamicAcquisition: symbol | undefined;
	let lastFailure: { requested: readonly string[]; result: LeaseSetResult | string } | undefined;
	const leases = new LeaseSet(dependencies.acquireLease, resolveExplicitRoots, () => {
		generation++;
		mode = "plan";
		selection = { mode: "plan" };
		guardTools();
		const ctx = currentContext;
		if (!ctx || shuttingDown) return;
		setState(ctx, "lost");
		try { persistSelection(selection); } catch { /* Write authority is already revoked. */ }
		void refreshReadOnlySubagents(ctx).catch(() => {});
		notify(ctx, "A scope lease was lost. All worktree and file scopes are now guarded; reacquire explicitly.", "error");
	}, { acquireFile: dependencies.acquireFile ?? acquireFileLease, resolveFiles: dependencies.resolveFiles ?? resolveExplicitFiles });

	pi.registerFlag("plan", { description: "Start in guarded plan mode without leases", type: "boolean", default: false });
	pi.registerFlag("implement", { description: "Acquire the cwd worktree lease", type: "boolean", default: false });
	pi.registerFlag("lease-roots", { description: "Explicit worktree roots as a JSON array; overrides restored scopes", type: "string" });

	function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
		const escaped = safeDisplay(text.slice(0, 12_000));
		const bounded = escaped.length > 12_000 || text.length > 12_000 ? `${escaped.slice(0, 11_970)} … (truncated)` : escaped;
		try { ctx.ui.notify(bounded, level); } catch { /* UI is not an authority boundary. */ }
	}
	function warnDiscovery(ctx: ExtensionContext): void {
		if (shuttingDown || !discoveryFailed || warningShown || !["plan", "implement-blocked", "lost"].includes(state)) return;
		warningShown = true;
		notify(ctx, "Read-only subagent verification failed; direct agent launches remain blocked.", "warning");
	}
	function setState(ctx: ExtensionContext, next: SessionGuardState): void {
		state = next;
		const { label, tone } = STATE_META[next];
		try {
			const guarded = next === "lost" || next === "unguarded";
			ctx.ui.setStatus("session-mode-leases", scopeStatus(guarded ? [] : leases.roots));
			const files = guarded ? [] : leases.files;
			ctx.ui.setStatus("session-mode-grants", files.length ? grantStatus(files) : undefined);
			ctx.ui.setStatus("session-mode", ctx.ui.theme.fg(tone, label));
			ctx.ui.setWidget("session-mode-grants", files.length ? [`${grantStatus(files)} — /grants for exact paths`] : undefined);
		} catch { /* State enforcement does not depend on rendering. */ }
		warnDiscovery(ctx);
	}
	function resetDiscovery(): void {
		discoveryGeneration++;
		readOnlySubagents = new Set();
		discoveryFailed = false;
		warningShown = false;
	}
	async function refreshReadOnlySubagents(ctx: ExtensionContext, provider = ctx.model?.provider): Promise<void> {
		const ticket = ++discoveryGeneration;
		try {
			const verified = await dependencies.readOnlySubagents(ctx.cwd, provider);
			if (ticket === discoveryGeneration) { readOnlySubagents = verified; discoveryFailed = false; }
		} catch {
			if (ticket === discoveryGeneration) { readOnlySubagents = new Set(); discoveryFailed = true; }
		}
		if (ticket === discoveryGeneration) warnDiscovery(ctx);
	}
	function guardTools(): void {
		toolsBeforeGuard ??= pi.getActiveTools();
		pi.setActiveTools(toolsBeforeGuard.filter((name) => name !== "edit" && name !== "write"));
	}
	function restoreTools(): void {
		if (!toolsBeforeGuard) return;
		pi.setActiveTools(toolsBeforeGuard);
		toolsBeforeGuard = undefined;
	}
	function unguarded(ctx: ExtensionContext): void { resetDiscovery(); restoreTools(); setState(ctx, "unguarded"); }
	function persistSelection(value: Selection): void {
		for (const entry of selectionEntries(value)) pi.appendEntry("session-mode", entry);
	}
	function current(ticket: number): boolean { return ticket === generation && !shuttingDown; }
	function rejectBusy(ctx: ExtensionContext): boolean {
		if (ctx.isIdle() && !ctx.hasPendingMessages()) return false;
		notify(ctx, "Cannot change session mode while Pi is busy.", "warning");
		return true;
	}
	async function failScope(ctx: ExtensionContext, result: LeaseSetResult | string, requested: readonly string[], ticket: number, persist: boolean, legacyContention = false): Promise<void> {
		if (!current(ticket) || state === "lost") return;
		lastFailure = { requested, result };
		if (leases.live) {
			mode = "implement";
			restoreTools();
			setState(ctx, "implement");
		} else {
			selection = legacyContention ? { mode: "implement", scope: { kind: "cwd" } } : { mode: "plan" };
			mode = selection.mode;
			guardTools();
			await refreshReadOnlySubagents(ctx);
			if (!current(ticket)) return;
			if (persist) {
				try { persistSelection(selection); }
				catch { notify(ctx, "Safe plan mode could not be saved; use --plan when restarting.", "error"); }
			}
			setState(ctx, typeof result !== "string" && result.kind === "contended" ? "implement-blocked" : "plan");
		}
		const authority = leases.live ? "Existing valid leases are retained." : "No scope leases are held; writes remain guarded.";
		if (typeof result !== "string" && result.kind === "contended") {
			const value = "root" in result ? result.root : result.file;
			const escaped = safeDisplay(value);
			const target = JSON.stringify(escaped.length > 1000 ? `${escaped.slice(0, 970)} … (truncated)` : escaped);
			if ("root" in result) notify(ctx, `Worktree ${target} is held by another live session. ${authority} Use /leases to inspect, /plan for read-only work, or /implement <root> for a disjoint worktree.`, "warning");
			else notify(ctx, `Exact file ${target} is held by another live session. ${authority} Use /grants to inspect, /plan for read-only work, or /grant-file <file> for a disjoint file.`, "warning");
		} else {
			notify(ctx, `Scope acquisition failed: ${JSON.stringify(lastFailure)}. ${authority}`, "error");
		}
	}

	function selected(scope: WorktreeSelection, scopes: HeldScopes): Selection {
		return scopes.files.length ? { mode: "implement", scope, files: scopes.files } : { mode: "implement", scope };
	}
	function enterScopes(
		ctx: ExtensionContext,
		request: ScopeSetRequest,
		scopeFor: (scopes: HeldScopes, originCwd?: string) => WorktreeSelection,
		persist = false,
		expected?: { roots?: readonly string[]; files?: readonly string[]; originCwd?: string },
		legacyImplicit = false,
	): Promise<void> {
		currentContext = ctx;
		const key = JSON.stringify([ctx.cwd, request, expected]);
		if (implementation && current(implementation.generation)) {
			if (implementation.key !== key) { notify(ctx, "Another scope transition is acquiring; try again when it finishes.", "warning"); return Promise.resolve(); }
			implementation.persist ||= persist;
			return implementation.promise;
		}
		const requestedRoots = request.worktrees.kind === "paths" ? request.worktrees.paths : request.worktrees.kind === "cwd" ? [ctx.cwd] : [];
		const operation: Implementation = { generation: ++generation, key, requestedRoots, requestedFiles: request.files, persist, promise: undefined! };
		implementation = operation;
		operation.promise = doAcquire(ctx, request, scopeFor, operation, expected, legacyImplicit).finally(() => {
			if (implementation === operation) implementation = undefined;
		});
		return operation.promise;
	}
	async function doAcquire(
		ctx: ExtensionContext,
		request: ScopeSetRequest,
		scopeFor: (scopes: HeldScopes, originCwd?: string) => WorktreeSelection,
		operation: Implementation,
		expected?: { roots?: readonly string[]; files?: readonly string[]; originCwd?: string },
		legacyImplicit = false,
	): Promise<void> {
		const ticket = operation.generation;
		mode = "implement"; guardTools(); setState(ctx, "acquiring");
		try {
			await leases.draining;
			if (!current(ticket)) return;
			if (dependencies.isDisabled()) {
				await leases.releaseAll();
				if (!current(ticket)) return;
				unguarded(ctx); notify(ctx, "Session guard disabled by PI_SESSION_GUARD=0.", "warning"); return;
			}
			const requested = [...operation.requestedRoots, ...operation.requestedFiles];
			const originCwd = request.worktrees.kind === "paths" ? await realpath(ctx.cwd) : undefined;
			if (!current(ticket)) return;
			if (expected?.originCwd !== undefined && originCwd !== expected.originCwd) {
				await failScope(ctx, "Restored origin cwd changed; select scopes explicitly", requested, ticket, true); return;
			}
			if (!current(ticket)) return;
			let candidate: Selection = selection;
			const result = await leases.addScopes(request, ctx.cwd, ctx.sessionManager.getSessionId(), (scopes) => {
				if (!current(ticket)) throw new Error("Scope transition superseded");
				candidate = selected(scopeFor(scopes, originCwd), scopes);
				if (operation.persist) persistSelection(candidate);
			}, expected && { ...(expected.roots ? { roots: expected.roots } : {}), ...(expected.files ? { files: expected.files } : {}) });
			if (!current(ticket)) return;
			if (result.kind === "held" && leases.live) {
				selection = candidate; lastFailure = undefined; mode = "implement";
				resetDiscovery(); restoreTools(); setState(ctx, "implement");
			} else if (result.kind === "unguarded" && legacyImplicit && leases.files.length === 0) {
				selection = { mode: "implement", scope: { kind: "cwd" } };
				if (operation.persist) persistSelection(selection);
				unguarded(ctx); notify(ctx, `Session guard unavailable (${result.reason}). This session is unguarded.`, "error");
			} else {
				await failScope(ctx, result, requested, ticket, operation.persist, legacyImplicit && result.kind === "contended");
			}
		} catch (error) {
			if (current(ticket)) await failScope(ctx, error instanceof Error ? error.message : String(error), [...operation.requestedRoots, ...operation.requestedFiles], ticket, operation.persist);
		}
	}
	async function enterImplement(ctx: ExtensionContext, paths?: string[], persist = false): Promise<void> {
		if (paths === undefined && leases.roots.length > 0 && leases.live && state === "implement" && !dependencies.isDisabled()) return;
		if (paths === undefined) return enterScopes(ctx, { worktrees: { kind: "cwd" }, files: [] }, () => ({ kind: "cwd" }), persist, undefined, true);
		return enterScopes(ctx, { worktrees: { kind: "paths", paths }, files: [] }, (scopes, originCwd) => ({ kind: "roots", roots: scopes.roots, originCwd: originCwd! }), persist);
	}
	function enterFiles(ctx: ExtensionContext, paths: string[], expectedFiles: readonly string[], persist = false): Promise<void> {
		const preserved = selection.mode === "implement" && leases.roots.length ? selection.scope : { kind: "none" } as const;
		return enterScopes(ctx, { worktrees: { kind: "none" }, files: paths }, () => preserved, persist, { files: expectedFiles });
	}
	function enterRestored(ctx: ExtensionContext, restored: Exclude<Selection, { mode: "plan" }>): Promise<void> {
		const files = [...selectionFiles(restored)];
		const worktrees: ScopeSetRequest["worktrees"] = restored.scope.kind === "roots"
			? { kind: "paths", paths: restored.scope.roots.map((root) => pathToFileURL(root).href) }
			: restored.scope.kind === "cwd" ? { kind: "cwd" } : { kind: "none" };
		return enterScopes(
			ctx,
			{ worktrees, files: files.map((file) => pathToFileURL(file).href) },
			(scopes) => restored.scope.kind === "roots" ? { ...restored.scope, roots: scopes.roots } : restored.scope,
			restored.scope.kind === "roots" || files.length > 0,
			{
				...(restored.scope.kind === "roots" ? { roots: restored.scope.roots, originCwd: restored.scope.originCwd } : {}),
				...(files.length ? { files } : {}),
			},
			worktrees.kind === "cwd" && files.length === 0,
		);
	}

	pi.registerCommand("plan", {
		description: "Guard writes and release every worktree and file lease",
		handler: async (_args, ctx) => {
			if (rejectBusy(ctx)) return;
			currentContext = ctx;
			const ticket = ++generation;
			const roots = leases.roots;
			mode = "plan"; selection = { mode: "plan" }; lastFailure = undefined;
			guardTools(); setState(ctx, dependencies.isDisabled() ? "unguarded" : "plan");
			let checkpointFailure: { error: unknown } | undefined;
			try { persistSelection(selection); } catch (error) { checkpointFailure = { error }; }
			await leases.releaseAll();
			if (!current(ticket)) return;
			if (dependencies.isDisabled()) restoreTools();
			setState(ctx, dependencies.isDisabled() ? "unguarded" : "plan");
			if (checkpointFailure) {
				notify(ctx, "Plan mode could not be saved; use --plan when restarting. Leases have been released.", "error");
				throw checkpointFailure.error;
			}
			await refreshReadOnlySubagents(ctx);
			if (!current(ticket)) return;
			for (const root of roots.length ? roots : [ctx.cwd]) {
				try {
					const result = await pi.exec("git", ["-C", root, "status", "--porcelain"], { timeout: 2000 });
					if (result.code === 0 && result.stdout.trim()) notify(ctx, `Entering plan mode with a dirty worktree: ${JSON.stringify(root)}; changes remain on disk.`, "warning");
				} catch { /* Dirty-state reporting is advisory. */ }
				if (!current(ticket)) return;
			}
			setState(ctx, dependencies.isDisabled() ? "unguarded" : "plan");
		},
	});
	pi.registerCommand("implement", {
		description: "Acquire cwd, or add explicitly named worktree roots",
		handler: async (args, ctx) => {
			if (rejectBusy(ctx)) return;
			try {
				const paths = parseRootArguments(args);
				await enterImplement(ctx, paths.length ? paths : undefined, true);
			} catch (error) {
				if ((implementation && current(implementation.generation)) || state === "lost") {
					lastFailure = { requested: [], result: String(error) };
					notify(ctx, `Scope error: ${String(error)}`, "error");
					return;
				}
				await failScope(ctx, String(error), [], ++generation, true);
			}
		},
	});
	pi.registerCommand("grant-file", {
		description: "Confirm and acquire exact non-repository file grants",
		handler: async (args, ctx) => {
			if (rejectBusy(ctx)) return;
			if (dependencies.isDisabled()) { notify(ctx, "Exact-file grants are unavailable while the guard is disabled.", "warning"); return; }
			if (ctx.mode !== "tui" || !ctx.hasUI) { notify(ctx, "Exact-file grants require interactive TUI confirmation.", "warning"); return; }
			const ticket = generation, sessionId = ctx.sessionManager.getSessionId();
			const confirmationCurrent = () => {
				try { return current(ticket) && currentContext?.sessionManager.getSessionId() === sessionId && ctx.sessionManager.getSessionId() === sessionId; }
				catch { return false; }
			};
			try {
				const paths = parseRootArguments(args);
				if (!paths.length) throw new Error("Expected at least one exact file path");
				const expected = await (dependencies.resolveFiles ?? resolveExplicitFiles)(paths, ctx.cwd);
				if (!confirmationCurrent()) { notify(ctx, "Exact-file grant cancelled because the session changed.", "warning"); return; }
				if (rejectBusy(ctx)) return;
				const display = expected.map((file) => safeDisplay(JSON.stringify(file))).join("\n");
				if (display.length > 10_000) throw new Error("Exact-file confirmation scope is too large");
				const confirmed = await ctx.ui.confirm(
					"Grant exact file writes?",
					`The native edit/write tools may change only these non-repository files while their leases remain held:\n\n${display}\n\nWith file-only scopes, obvious Bash, package, Git, system and writer-subagent mutations remain guarded. Other extensions, editors, users and machines are not confined.`,
					{ timeout: 60_000 },
				);
				if (!confirmed) { notify(ctx, "Exact-file grant cancelled."); return; }
				if (!confirmationCurrent()) { notify(ctx, "Exact-file grant cancelled because the session changed.", "warning"); return; }
				if (rejectBusy(ctx)) return;
				if (dependencies.isDisabled() || ctx.mode !== "tui" || !ctx.hasUI) { notify(ctx, "Exact-file grant cancelled because the authorization context changed.", "warning"); return; }
				await enterFiles(ctx, paths, expected, true);
			} catch (error) {
				if (!confirmationCurrent()) { notify(ctx, "Exact-file grant cancelled because the session changed.", "warning"); return; }
				if ((implementation && current(implementation.generation)) || state === "lost") {
					lastFailure = { requested: [], result: String(error) };
					notify(ctx, `Grant error: ${String(error)}`, "error"); return;
				}
				await failScope(ctx, String(error), [], ++generation, true);
			}
		},
	});
	pi.registerCommand("grants", {
		description: "Show held exact-file grants or inspect file identities",
		handler: async (args, ctx) => {
			try {
				const paths = parseRootArguments(args);
				const inspected = paths.length ? await (dependencies.resolveFiles ?? resolveExplicitFiles)(paths, ctx.cwd) : undefined;
				const requested = implementation && current(implementation.generation) ? implementation.requestedFiles : undefined;
				notify(ctx, JSON.stringify({ state: STATE_META[state].label, held: leases.files, requested, inspected, lastFailure }));
			} catch (error) { notify(ctx, `Grant inspection unavailable: ${String(error)}`, "error"); }
		},
	});
	pi.registerCommand("leases", {
		description: "Show held scopes or inspect explicit roots without acquiring",
		handler: async (args, ctx) => {
			try {
				const paths = parseRootArguments(args);
				const requested = paths.length ? await resolveExplicitRoots(paths, ctx.cwd) : implementation && current(implementation.generation) ? implementation.requestedRoots : undefined;
				const observations = paths.length ? await probeWorktreeLeaseOccupancies(requested!, { selfPid: -1 }) : undefined;
				notify(ctx, JSON.stringify({ state: STATE_META[state].label, held: leases.roots, requested, lastFailure, observations }));
			} catch (error) { notify(ctx, `Lease inspection unavailable: ${String(error)}`, "error"); }
		},
	});

	async function acquireWriteTargets(tool: string, input: unknown, ctx: ExtensionContext): Promise<string | undefined> {
		if (!["edit", "write", "multi_tool_use.parallel"].includes(tool) || leases.roots.length === 0 || dependencies.isDisabled()) return;
		if (dynamicAcquisition || (implementation && current(implementation.generation))) return "Another scope acquisition is busy; write blocked.";
		const operation = Symbol("native-write");
		dynamicAcquisition = operation;
		const ticket = generation, revision = leases.revision;
		const missing = new Set<string>();
		const abort = ctx.signal;
		const deadline = AbortSignal.timeout(ADDITION_TIMEOUT_MS);
		const signal = abort ? AbortSignal.any([abort, deadline]) : deadline;
		const eligible = () => current(ticket) && state === "implement" && leases.live && leases.roots.length > 0 && !dependencies.isDisabled() && !signal.aborted;
		const unchanged = () => eligible() && leases.revision === revision;
		try {
			const reason = await scopedWriteBlockReason(tool, input, ctx.cwd, leases.roots, { files: leases.files, collectMissingRoots: missing, signal, isCurrent: unchanged });
			if (reason) return reason;
			if (!unchanged()) return "Scope changed or tool cancelled during native-write validation; write blocked.";
			if (!missing.size) return;
			for (const root of missing) {
				if (leases.files.some((file) => {
					const path = relative(root, file);
					return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
				})) return `Worktree ${safeDisplay(JSON.stringify(root))} overlaps an exact-file grant; reselect scopes explicitly.`;
			}
			const originCwd = await realpath(ctx.cwd);
			if (!unchanged()) return "Scope changed or tool cancelled before acquisition; write blocked.";
			if (selection.mode !== "implement") return "Implementation selection changed; write blocked.";
			if (selection.scope.kind === "roots" && selection.scope.originCwd !== originCwd) return "Origin cwd changed; reselect scopes explicitly.";
			const roots = [...missing].sort();
			let candidate: Selection = selection;
			const result = await leases.addScopes(
				{ worktrees: { kind: "paths", paths: roots.map((root) => pathToFileURL(root).href) }, files: [] },
				ctx.cwd, ctx.sessionManager.getSessionId(),
				(scopes) => {
					if (!unchanged()) throw new Error("Native-write acquisition superseded or cancelled");
					candidate = selected({ kind: "roots", roots: scopes.roots, originCwd }, scopes);
					persistSelection(candidate);
				},
				{ roots }, signal,
			);
			if (result.kind === "held" && current(ticket) && state === "implement" && leases.live) {
				selection = candidate; lastFailure = undefined;
				setState(ctx, "implement");
			}
			if (!eligible()) return "Scope changed or tool cancelled during acquisition; write blocked.";
			if (result.kind !== "held") {
				lastFailure = { requested: roots, result };
				const detail = result.kind === "contended" && "root" in result
					? `Worktree ${JSON.stringify(result.root)} is held by another live session`
					: `${result.kind}${"detail" in result ? `: ${result.detail}` : ""}`;
				return safeDisplay(`Dynamic lease acquisition blocked for ${boundedScopeList(roots)}: ${detail.slice(0, 2000)}. Existing valid scopes are retained.`);
			}
		} catch (error) {
			return safeDisplay(`Native-write scope acquisition failed for ${boundedScopeList([...missing])}: ${String(error).slice(0, 2000)}. Write blocked.`);
		} finally {
			if (dynamicAcquisition === operation) dynamicAcquisition = undefined;
		}
	}

	pi.on("tool_call", async (event, ctx) => {
		if (state === "unguarded") return;
		if (state === "implement" && leases.live) {
			const acquisitionReason = await acquireWriteTargets(event.toolName, event.input, ctx);
			if (acquisitionReason) return { block: true, reason: acquisitionReason };
			const ticket = generation, revision = leases.revision;
			const reason = await scopedWriteBlockReason(event.toolName, event.input, ctx.cwd, leases.roots, { files: leases.files, signal: ctx.signal, isCurrent: () => current(ticket) && state === "implement" && leases.live && revision === leases.revision });
			if (reason) return { block: true, reason };
			if (leases.roots.length === 0) {
				const guardedReason = guardedToolBlockReason(event.toolName, event.input, { readOnlySubagents, allowNativeWrites: true });
				if (guardedReason) return { block: true, reason: guardedReason };
			}
			return;
		}
		const reason = guardedToolBlockReason(event.toolName, event.input, { readOnlySubagents });
		if (reason) return { block: true, reason };
	});
	pi.on("model_select", (event, ctx) => {
		readOnlySubagents = new Set(); discoveryFailed = false;
		void refreshReadOnlySubagents(ctx, event.model.provider);
	});
	pi.on("before_agent_start", (event) => {
		if (state === "unguarded") return;
		const guidance = state === "implement" && leases.live
			? `Leased worktrees: ${boundedScopeList(leases.roots)}. Exact-file grants: ${boundedScopeList(leases.files)}. ${leases.roots.length ? "Native edit/write calls can acquire and persist their canonical target worktree leases automatically; do not ask for a redundant /implement command for that supported path. Contention or unavailable identity blocks the write." : "File-only sessions cannot auto-acquire worktrees and retain the bounded guarded shell/subagent policy; ask for /implement while idle before repository work."} Exact non-repository files still require explicit /grant-file confirmation. Shell/script effects are not automatically scoped: never use them as a scope-expansion workaround. Reads, Beads claims, prose and subagent requests do not acquire leases.`
			: "[GUARDED SESSION]\nDo not modify files or repository state. Read-only analysis, ordinary local Beads triage, safe subagent management and verified direct read-only reviewers are allowed. Ask the user to select /implement scopes before source changes.";
		return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
	});
	pi.on("session_start", async (_event, ctx) => {
		generation++; currentContext = ctx; shuttingDown = false;
		const restored = restoreSelection(ctx.sessionManager.getBranch());
		selection = restored.selection;
		mode = pi.getFlag("plan") === true ? "plan" : selection.mode;
		if (dependencies.isDisabled()) { unguarded(ctx); notify(ctx, "Session guard disabled by PI_SESSION_GUARD=0.", "warning"); return; }
		if (pi.getFlag("plan") === true) selection = { mode: "plan" };
		else if (typeof pi.getFlag("lease-roots") === "string") {
			try { await enterImplement(ctx, parseRootFlag(pi.getFlag("lease-roots") as string), true); }
			catch (error) { await failScope(ctx, String(error), [], ++generation, true); }
			return;
		} else if (pi.getFlag("implement") === true) {
			await enterImplement(ctx, undefined, true);
			return;
		}
		if (selection.mode === "plan") {
			mode = "plan"; guardTools(); await refreshReadOnlySubagents(ctx); setState(ctx, "plan");
			if (restored.invalid) notify(ctx, "Invalid restored scope; reselect worktrees with /implement or exact files with /grant-file.", "error");
		} else await enterRestored(ctx, selection);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true; generation++; guardTools();
		await leases.releaseAll();
		resetDiscovery(); restoreTools();
		try { ctx.ui.setStatus("session-mode-leases", undefined); ctx.ui.setStatus("session-mode-grants", undefined); ctx.ui.setStatus("session-mode", undefined); ctx.ui.setWidget("session-mode-grants", undefined); } catch { /* Teardown is already complete. */ }
		currentContext = undefined;
	});
	return { get mode() { return mode; }, get state() { return state; }, get roots() { return leases.roots; }, get files() { return leases.files; } };
}
