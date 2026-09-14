import { acquireFileLease, acquireWorktreeLease, type FileLeaseResult, type HeldFileLease, type HeldWorktreeLease, type WorktreeLeaseResult } from "./lease.ts";
import { MAX_FILE_GRANTS, resolveExplicitFiles } from "./file-scope.ts";
import { ADDITION_TIMEOUT_MS, MAX_LEASE_ROOTS, resolveExplicitRoots } from "./scope.ts";

type AcquireRoot = (root: string, options: { sessionId: string; signal: AbortSignal; expectedRoot?: string }) => Promise<WorktreeLeaseResult>;
type AcquireFile = (file: string, options: { sessionId: string; signal: AbortSignal; expectedFile?: string }) => Promise<FileLeaseResult>;
type ResolveRoots = (paths: string[], cwd: string, signal?: AbortSignal) => Promise<string[]>;
type ResolveFiles = (paths: string[], cwd: string, signal?: AbortSignal) => Promise<string[]>;
type HeldScopeLease = HeldWorktreeLease | HeldFileLease;
export type WorktreeRequest = { kind: "none" } | { kind: "cwd" } | { kind: "paths"; paths: string[] };
export interface ScopeSetRequest { worktrees: WorktreeRequest; files: string[]; }
export interface HeldScopes { roots: string[]; files: string[]; }
export type LeaseSetResult =
	| ({ kind: "held" } & HeldScopes)
	| Exclude<WorktreeLeaseResult, HeldWorktreeLease>
	| Exclude<FileLeaseResult, HeldFileLease>
	| { kind: "invalid"; detail: string }
	| { kind: "cancelled" | "busy" };
interface Operation {
	key: string;
	epoch: number;
	controller: AbortController;
	added: Set<HeldScopeLease>;
	promise: Promise<LeaseSetResult>;
}

function same(left: readonly string[], right: readonly string[]): boolean {
	return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}
function leaseKey(lease: HeldScopeLease): string { return "root" in lease ? lease.root : lease.file; }

export class LeaseSet {
	readonly #roots = new Map<string, HeldWorktreeLease>();
	readonly #files = new Map<string, HeldFileLease>();
	readonly #releases = new WeakMap<HeldScopeLease, Promise<void>>();
	#operation?: Operation;
	#drain: Promise<void> = Promise.resolve();
	#epoch = 0;
	#revision = 0;
	#lost = false;

	constructor(
		private readonly acquire: AcquireRoot = acquireWorktreeLease,
		private readonly resolveRoots: ResolveRoots = resolveExplicitRoots,
		private readonly onLost: () => void = () => {},
		private readonly options: { timeoutMs?: number; acquireFile?: AcquireFile; resolveFiles?: ResolveFiles } = {},
	) {}

	get roots(): string[] { return [...this.#roots.keys()].sort(); }
	get files(): string[] { return [...this.#files.keys()].sort(); }
	get revision(): number { return this.#revision; }
	get lost(): boolean { return this.#lost; }
	get live(): boolean {
		const leases = [...this.#roots.values(), ...this.#files.values()];
		return !this.#lost && leases.length > 0 && leases.every((lease) => lease.alive !== false);
	}
	get draining(): Promise<void> { return this.#drain; }

	add(paths: string[] | undefined, cwd: string, sessionId: string, beforeCommit?: (roots: string[]) => void, expectedRoots?: readonly string[]): Promise<LeaseSetResult> {
		return this.addScopes(
			{ worktrees: paths === undefined ? { kind: "cwd" } : { kind: "paths", paths }, files: [] },
			cwd, sessionId,
			beforeCommit ? (scopes) => beforeCommit(scopes.roots) : undefined,
			expectedRoots ? { roots: expectedRoots } : undefined,
		);
	}

	addFiles(paths: string[], cwd: string, sessionId: string, beforeCommit?: (files: string[]) => void, expectedFiles?: readonly string[]): Promise<LeaseSetResult> {
		return this.addScopes(
			{ worktrees: { kind: "none" }, files: paths },
			cwd, sessionId,
			beforeCommit ? (scopes) => beforeCommit(scopes.files) : undefined,
			expectedFiles ? { files: expectedFiles } : undefined,
		);
	}

	addScopes(request: ScopeSetRequest, cwd: string, sessionId: string, beforeCommit?: (scopes: HeldScopes) => void, expected?: { roots?: readonly string[]; files?: readonly string[] }): Promise<LeaseSetResult> {
		const key = JSON.stringify([cwd, sessionId, request, expected]);
		if (this.#operation) return this.#operation.key === key ? this.#operation.promise : Promise.resolve({ kind: "busy" });
		const priorDrain = this.#drain;
		const operation: Operation = { key, epoch: ++this.#epoch, controller: new AbortController(), added: new Set(), promise: undefined! };
		this.#operation = operation;
		this.#lost = false;
		const timer = setTimeout(() => operation.controller.abort(), this.options.timeoutMs ?? ADDITION_TIMEOUT_MS);
		operation.promise = this.execute(operation, request, cwd, sessionId, priorDrain, beforeCommit, expected).finally(() => {
			clearTimeout(timer);
			if (this.#operation === operation) this.#operation = undefined;
		});
		return operation.promise;
	}

	private release(lease: HeldScopeLease): Promise<void> {
		let releasing = this.#releases.get(lease);
		if (!releasing) {
			releasing = Promise.resolve().then(() => lease.release());
			this.#releases.set(lease, releasing);
		}
		return releasing;
	}

	releaseAll(): Promise<void> {
		this.#epoch++;
		this.#revision++;
		const pending = this.#operation;
		pending?.controller.abort();
		const leases = new Set<HeldScopeLease>([...this.#roots.values(), ...this.#files.values(), ...(pending?.added ?? [])]);
		this.#roots.clear(); this.#files.clear(); pending?.added.clear();
		this.#drain = Promise.all([this.#drain, ...[...leases].map((lease) => this.release(lease)), pending?.promise]).then(() => undefined);
		return this.#drain;
	}

	private lose(): void {
		if (this.#lost) return;
		this.#lost = true;
		try { this.onLost(); }
		finally { void this.releaseAll().catch(() => { /* The rejected drain prevents further acquisitions. */ }); }
	}

	private held(lease: HeldScopeLease): boolean {
		return "root" in lease ? this.#roots.get(lease.root) === lease : this.#files.get(lease.file) === lease;
	}
	private watch(lease: HeldScopeLease, operation: Operation): void {
		const onLoss = () => { if (this.held(lease) || operation.added.has(lease)) this.lose(); };
		void lease.lost.then(onLoss, onLoss).catch(() => { /* Loss has already guarded and initiated draining. */ });
	}
	private current(operation: Operation): boolean {
		return operation.epoch === this.#epoch && !operation.controller.signal.aborted && !this.#lost;
	}
	private scopesWith(added: Iterable<HeldScopeLease>): HeldScopes {
		const roots = new Set(this.roots), files = new Set(this.files);
		for (const lease of added) ("root" in lease ? roots : files).add(leaseKey(lease));
		return { roots: [...roots].sort(), files: [...files].sort() };
	}

	private async execute(operation: Operation, request: ScopeSetRequest, cwd: string, sessionId: string, priorDrain: Promise<void>, beforeCommit?: (scopes: HeldScopes) => void, expected?: { roots?: readonly string[]; files?: readonly string[] }): Promise<LeaseSetResult> {
		const signal = operation.controller.signal;
		let committed = false;
		try {
			await priorDrain;
			if (!this.current(operation)) return { kind: "cancelled" };
			const roots = request.worktrees.kind === "none" ? []
				: request.worktrees.kind === "cwd" ? [cwd]
					: await this.resolveRoots(request.worktrees.paths, cwd, signal);
			const files = request.files.length ? await (this.options.resolveFiles ?? resolveExplicitFiles)(request.files, cwd, signal) : [];
			if (expected?.roots && !same(roots, expected.roots)) return { kind: "invalid", detail: "Restored canonical roots changed; select scopes explicitly" };
			if (expected?.files && !same(files, expected.files)) return { kind: "invalid", detail: "Restored canonical files changed; grant files explicitly" };
			if (!this.current(operation)) return { kind: "cancelled" };
			if (roots.length === 0 && files.length === 0) return { kind: "invalid", detail: "Expected at least one worktree or exact file scope" };
			if (new Set([...this.roots, ...roots]).size > MAX_LEASE_ROOTS) return { kind: "invalid", detail: `Expected at most ${MAX_LEASE_ROOTS} held worktrees` };
			if (new Set([...this.files, ...files]).size > MAX_FILE_GRANTS) return { kind: "invalid", detail: `Expected at most ${MAX_FILE_GRANTS} held file grants` };
			for (const root of [...new Set(roots)].sort()) {
				if (!this.current(operation)) return { kind: "cancelled" };
				if (this.#roots.has(root)) continue;
				const result = await this.acquire(root, { signal, sessionId, ...(request.worktrees.kind === "paths" ? { expectedRoot: root } : {}) });
				if (result.kind === "held") {
					operation.added.add(result); this.watch(result, operation);
					if (result.alive === false) this.lose();
					if (request.worktrees.kind === "paths" && result.root !== root) return { kind: "invalid", detail: "Worktree identity changed during acquisition" };
				}
				if (!this.current(operation)) return { kind: "cancelled" };
				if (result.kind !== "held") return result;
			}
			for (const file of [...new Set(files)].sort()) {
				if (!this.current(operation)) return { kind: "cancelled" };
				if (this.#files.has(file)) continue;
				const result = await (this.options.acquireFile ?? acquireFileLease)(file, { signal, sessionId, expectedFile: file });
				if (result.kind === "held") {
					operation.added.add(result); this.watch(result, operation);
					if (result.alive === false) this.lose();
					if (result.file !== file) return { kind: "invalid", detail: "File identity changed during acquisition" };
				}
				if (!this.current(operation)) return { kind: "cancelled" };
				if (result.kind !== "held") return result;
			}
			if ([...this.#roots.values(), ...this.#files.values(), ...operation.added].some((lease) => lease.alive === false)) this.lose();
			if (!this.current(operation)) return { kind: "cancelled" };
			const scopes = this.scopesWith(operation.added);
			beforeCommit?.(scopes);
			if (!this.current(operation)) return { kind: "cancelled" };
			for (const lease of operation.added) {
				if ("root" in lease) this.#roots.set(lease.root, lease);
				else this.#files.set(lease.file, lease);
			}
			operation.added.clear(); this.#revision++; committed = true;
			return { kind: "held", roots: this.roots, files: this.files };
		} catch (error) {
			return this.current(operation) ? { kind: "invalid", detail: error instanceof Error ? error.message : String(error) } : { kind: "cancelled" };
		} finally {
			if (!committed) {
				const rollback = [...operation.added]; operation.added.clear();
				try { await Promise.all(rollback.map((lease) => this.release(lease))); }
				catch (error) { this.lose(); throw error; }
			}
		}
	}
}
