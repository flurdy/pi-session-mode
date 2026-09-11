import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { acquireWorktreeLease, type WorktreeLeaseResult } from "./lease.ts";
import { LeaseSet, type LeaseSetResult } from "./lease-set.ts";
import { probeWorktreeLeaseOccupancies } from "./lease-observer.ts";
import { guardedToolBlockReason } from "./policy.ts";
import { scopedWriteBlockReason } from "./scoped-policy.ts";
import { parseRootArguments, parseRootFlag, resolveExplicitRoots, safeDisplay, scopeStatus } from "./scope.ts";
import { restoreSelection, selectionEntries, type Selection } from "./selection.ts";
import { verifiedReadOnlySubagents } from "./subagent-policy.ts";

export type SessionMode = "implement" | "plan";
export type SessionGuardState = "acquiring" | "implement" | "plan" | "implement-blocked" | "lost" | "unguarded";
export interface SessionModeDependencies {
	acquireLease(cwd: string, options: { sessionId: string; signal?: AbortSignal; expectedRoot?: string }): Promise<WorktreeLeaseResult>;
	isDisabled(): boolean;
	readOnlySubagents(cwd: string, preferredProvider?: string): Promise<ReadonlySet<string>>;
}
export interface SessionModeController {
	readonly mode: SessionMode;
	readonly state: SessionGuardState;
	readonly roots: readonly string[];
}
interface Implementation {
	generation: number;
	key: string;
	requested: readonly string[];
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

export function registerSessionMode(pi: ExtensionAPI, dependencies: SessionModeDependencies = {
	acquireLease: acquireWorktreeLease,
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
		notify(ctx, "Worktree lease was lost. All scopes are now guarded; use /implement to reacquire.", "error");
	});

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
			ctx.ui.setStatus("session-mode-leases", scopeStatus(next === "lost" || next === "unguarded" ? [] : leases.roots));
			ctx.ui.setStatus("session-mode", ctx.ui.theme.fg(tone, label));
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
		notify(ctx, `Scope acquisition failed: ${JSON.stringify(lastFailure)}. Existing valid leases are retained.`, "error");
	}

	function enterImplement(ctx: ExtensionContext, paths?: string[], persist = false, expected?: { roots: readonly string[]; originCwd: string }): Promise<void> {
		currentContext = ctx;
		const key = JSON.stringify([ctx.cwd, paths, expected]);
		if (implementation && current(implementation.generation)) {
			if (implementation.key !== key) { notify(ctx, "Another scope transition is acquiring; try again when it finishes.", "warning"); return Promise.resolve(); }
			implementation.persist ||= persist;
			return implementation.promise;
		}
		if (paths === undefined && leases.live && state === "implement" && !dependencies.isDisabled()) return Promise.resolve();
		const operation: Implementation = { generation: ++generation, key, requested: paths ?? [ctx.cwd], persist, promise: undefined! };
		implementation = operation;
		operation.promise = doImplement(ctx, paths, operation, expected).finally(() => {
			if (implementation === operation) implementation = undefined;
		});
		return operation.promise;
	}
	async function doImplement(ctx: ExtensionContext, paths: string[] | undefined, operation: Implementation, expected?: { roots: readonly string[]; originCwd: string }): Promise<void> {
		const ticket = operation.generation;
		mode = "implement";
		guardTools();
		setState(ctx, "acquiring");
		try {
			await leases.draining;
			if (!current(ticket)) return;
			if (dependencies.isDisabled()) {
				await leases.releaseAll();
				if (!current(ticket)) return;
				unguarded(ctx);
				notify(ctx, "Session guard disabled by PI_SESSION_GUARD=0.", "warning");
				return;
			}
			const originCwd = paths === undefined ? undefined : await realpath(ctx.cwd);
			if (!current(ticket)) return;
			if (expected && originCwd !== expected.originCwd) { await failScope(ctx, "Restored origin cwd changed; select scopes explicitly", paths ?? [], ticket, true); return; }
			let candidate: Selection = selection;
			const result = await leases.add(paths, ctx.cwd, ctx.sessionManager.getSessionId(), (roots) => {
				if (!current(ticket)) throw new Error("Scope transition superseded");
				if (expected && JSON.stringify(roots) !== JSON.stringify([...expected.roots].sort())) throw new Error("Restored worktree identity changed");
				candidate = paths === undefined ? { mode: "implement", scope: { kind: "cwd" } } : { mode: "implement", scope: { kind: "roots", roots, originCwd: originCwd! } };
				if (operation.persist) persistSelection(candidate);
			}, expected?.roots);
			if (!current(ticket)) return;
			if (result.kind === "held" && leases.live) {
				selection = candidate;
				lastFailure = undefined;
				mode = "implement";
				resetDiscovery(); restoreTools(); setState(ctx, "implement");
			} else if (result.kind === "unguarded" && paths === undefined) {
				selection = { mode: "implement", scope: { kind: "cwd" } };
				if (operation.persist) persistSelection(selection);
				unguarded(ctx);
				notify(ctx, `Session guard unavailable (${result.reason}). This session is unguarded.`, "error");
			} else {
				await failScope(ctx, result, paths ?? [ctx.cwd], ticket, operation.persist, paths === undefined && result.kind === "contended");
			}
		} catch (error) {
			if (current(ticket)) await failScope(ctx, error instanceof Error ? error.message : String(error), paths ?? [ctx.cwd], ticket, operation.persist);
		}
	}

	pi.registerCommand("plan", {
		description: "Guard writes and release every worktree lease",
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
	pi.registerCommand("leases", {
		description: "Show held scopes or inspect explicit roots without acquiring",
		handler: async (args, ctx) => {
			try {
				const paths = parseRootArguments(args);
				const requested = paths.length ? await resolveExplicitRoots(paths, ctx.cwd) : implementation && current(implementation.generation) ? implementation.requested : undefined;
				const observations = paths.length ? await probeWorktreeLeaseOccupancies(requested!, { selfPid: -1 }) : undefined;
				notify(ctx, JSON.stringify({ state: STATE_META[state].label, held: leases.roots, requested, lastFailure, observations }));
			} catch (error) { notify(ctx, `Lease inspection unavailable: ${String(error)}`, "error"); }
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (state === "unguarded") return;
		if (state === "implement" && leases.live) {
			const revision = leases.revision;
			const reason = await scopedWriteBlockReason(event.toolName, event.input, ctx.cwd, leases.roots, { isCurrent: () => state === "implement" && leases.live && revision === leases.revision });
			if (reason) return { block: true, reason };
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
			? `Leased worktrees: ${JSON.stringify(leases.roots)}. Only mutate these repositories. Shell/script effects are not automatically scoped. Ask the user to add scopes with /implement while idle; Beads claims do not grant write authority.`
			: "[GUARDED SESSION]\nDo not modify files or repository state. Read-only analysis, ordinary local Beads triage, safe subagent management and verified direct read-only reviewers are allowed. Ask the user to select /implement scopes before source changes.";
		return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
	});
	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx; shuttingDown = false;
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
			if (restored.invalid) notify(ctx, "Invalid restored scope; select worktrees explicitly with /implement.", "error");
		} else if (selection.scope.kind === "roots") {
			await enterImplement(ctx, selection.scope.roots.map((root) => pathToFileURL(root).href), true, selection.scope);
		} else await enterImplement(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true; generation++; guardTools();
		await leases.releaseAll();
		resetDiscovery(); restoreTools();
		try { ctx.ui.setStatus("session-mode-leases", undefined); ctx.ui.setStatus("session-mode", undefined); } catch { /* Teardown is already complete. */ }
		currentContext = undefined;
	});
	return { get mode() { return mode; }, get state() { return state; }, get roots() { return leases.roots; } };
}
