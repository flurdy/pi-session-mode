import { acquireFileLease, acquireFolderLease, acquireWorktreeLease, IntentPool, type FileLeaseResult, type FolderLeaseResult, type HeldFileLease, type HeldFolderLease, type HeldWorktreeLease, type WorktreeLeaseResult } from "./lease.ts";
import { MAX_FILE_GRANTS, MAX_FOLDER_GRANTS, resolveExplicitFiles, resolveExplicitFolders } from "./file-scope.ts";
import { isWithin } from "./path.ts";
import { ADDITION_TIMEOUT_MS, MAX_LEASE_ROOTS, resolveExplicitRoots } from "./scope.ts";

type AcquireRoot = (root: string, options: { sessionId: string; signal: AbortSignal; expectedRoot?: string }) => Promise<WorktreeLeaseResult>;
type AcquireFile = (file: string, options: { sessionId: string; signal: AbortSignal; expectedFile?: string; intentPool?: IntentPool }) => Promise<FileLeaseResult>;
type AcquireFolder = (dir: string, options: { sessionId: string; signal: AbortSignal; expectedDir?: string; intentPool?: IntentPool }) => Promise<FolderLeaseResult>;
type ResolveRoots = (paths: string[], cwd: string, signal?: AbortSignal) => Promise<string[]>;
type ResolveFiles = (paths: string[], cwd: string, signal?: AbortSignal) => Promise<string[]>;
type ResolveFolders = (paths: string[], cwd: string, signal?: AbortSignal) => Promise<string[]>;
type HeldScopeLease = HeldWorktreeLease | HeldFileLease | HeldFolderLease;
export type WorktreeRequest = { kind: "none" } | { kind: "cwd" } | { kind: "paths"; paths: string[] };
export interface ScopeSetRequest { worktrees: WorktreeRequest; files: string[]; folders?: string[]; }
export interface HeldScopes { roots: string[]; files: string[]; folders: string[]; }
export type LeaseSetResult =
	| ({ kind: "held" } & HeldScopes)
	| Exclude<WorktreeLeaseResult, HeldWorktreeLease>
	| Exclude<FileLeaseResult, HeldFileLease>
	| Exclude<FolderLeaseResult, HeldFolderLease>
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
function leaseKey(lease: HeldScopeLease): string { return "root" in lease ? lease.root : "file" in lease ? lease.file : lease.dir; }
function containing(path: string, folders: Iterable<string>): string | undefined {
	for (const folder of folders) if (folder !== path && isWithin(path, folder)) return folder;
	return undefined;
}

export class LeaseSet {
	readonly #roots = new Map<string, HeldWorktreeLease>();
	readonly #files = new Map<string, HeldFileLease>();
	readonly #folders = new Map<string, HeldFolderLease>();
	readonly #intents = new IntentPool();
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
		private readonly options: {
			timeoutMs?: number; acquireFile?: AcquireFile; resolveFiles?: ResolveFiles; acquireFolder?: AcquireFolder; resolveFolders?: ResolveFolders;
			/** After a loss, authority is revoked at once but surviving holders stay locked until this settles. */
			holdReleaseOnLoss?: () => Promise<void> | undefined;
		} = {},
	) {}

	get roots(): string[] { return [...this.#roots.keys()].sort(); }
	get files(): string[] { return [...this.#files.keys()].sort(); }
	get folders(): string[] { return [...this.#folders.keys()].sort(); }
	get revision(): number { return this.#revision; }
	get lost(): boolean { return this.#lost; }
	get live(): boolean {
		const leases = [...this.#roots.values(), ...this.#files.values(), ...this.#folders.values()];
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

	addScopes(request: ScopeSetRequest, cwd: string, sessionId: string, beforeCommit?: (scopes: HeldScopes) => void, expected?: { roots?: readonly string[]; files?: readonly string[]; folders?: readonly string[] }, signal?: AbortSignal): Promise<LeaseSetResult> {
		if (signal?.aborted) return Promise.resolve({ kind: "cancelled" });
		const key = JSON.stringify([cwd, sessionId, request, expected]);
		if (this.#operation) return this.#operation.key === key ? this.#operation.promise : Promise.resolve({ kind: "busy" });
		const priorDrain = this.#drain;
		const operation: Operation = { key, epoch: ++this.#epoch, controller: new AbortController(), added: new Set(), promise: undefined! };
		this.#operation = operation;
		this.#lost = false;
		const cancel = () => operation.controller.abort();
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		const timer = setTimeout(cancel, this.options.timeoutMs ?? ADDITION_TIMEOUT_MS);
		operation.promise = this.execute(operation, request, cwd, sessionId, priorDrain, beforeCommit, expected).finally(() => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
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
		const leases = new Set<HeldScopeLease>([...this.#roots.values(), ...this.#files.values(), ...this.#folders.values(), ...(pending?.added ?? [])]);
		this.#roots.clear(); this.#files.clear(); this.#folders.clear(); pending?.added.clear();
		this.#drain = Promise.all([this.#drain, ...[...leases].map((lease) => this.release(lease)), pending?.promise]).then(() => undefined);
		return this.#drain;
	}

	/** Release every worktree lease, keep exact-file leases, and invalidate pending operations and preflights. */
	releaseWorktrees(): Promise<void> {
		this.#epoch++;
		this.#revision++;
		const pending = this.#operation;
		pending?.controller.abort();
		const roots = [...this.#roots.values()];
		this.#roots.clear();
		this.#drain = Promise.all([this.#drain, ...roots.map((lease) => this.release(lease)), pending?.promise]).then(() => undefined);
		return this.#drain;
	}

	/** Release the named exact-file and folder grants (all when omitted), keep worktrees, and invalidate pending operations and preflights. */
	releaseGrants(paths?: readonly string[]): Promise<void> {
		this.#epoch++;
		this.#revision++;
		const pending = this.#operation;
		pending?.controller.abort();
		const leases: HeldScopeLease[] = [];
		for (const map of [this.#files, this.#folders] as Map<string, HeldFileLease | HeldFolderLease>[]) {
			for (const [key, lease] of map) if (!paths || paths.includes(key)) { leases.push(lease); map.delete(key); }
		}
		this.#drain = Promise.all([this.#drain, ...leases.map((lease) => this.release(lease)), pending?.promise]).then(() => undefined);
		return this.#drain;
	}

	/**
	 * Revoke all authority at once. Surviving handles are parked: no longer reported or usable, but
	 * still locked until the configured hold settles, then released together.
	 */
	private lose(): void {
		if (this.#lost) return;
		this.#lost = true;
		try { this.onLost(); }
		finally {
			this.#epoch++;
			this.#revision++;
			const pending = this.#operation;
			pending?.controller.abort();
			const parked = new Set<HeldScopeLease>([...this.#roots.values(), ...this.#files.values(), ...this.#folders.values(), ...(pending?.added ?? [])]);
			this.#roots.clear(); this.#files.clear(); this.#folders.clear(); pending?.added.clear();
			const hold = Promise.resolve(this.options.holdReleaseOnLoss?.()).catch(() => undefined);
			this.#drain = Promise.all([this.#drain, hold.then(() => Promise.all([...parked].map((lease) => this.release(lease)))), pending?.promise]).then(() => undefined);
			void this.#drain.catch(() => { /* The rejected drain prevents further acquisitions. */ });
		}
	}

	private held(lease: HeldScopeLease): boolean {
		if ("root" in lease) return this.#roots.get(lease.root) === lease;
		return "file" in lease ? this.#files.get(lease.file) === lease : this.#folders.get(lease.dir) === lease;
	}
	private watch(lease: HeldScopeLease, operation: Operation): void {
		const onLoss = () => { if (this.held(lease) || operation.added.has(lease)) this.lose(); };
		void lease.lost.then(onLoss, onLoss).catch(() => { /* Loss has already guarded and initiated draining. */ });
	}
	private current(operation: Operation): boolean {
		return operation.epoch === this.#epoch && !operation.controller.signal.aborted && !this.#lost;
	}
	private scopesWith(added: Iterable<HeldScopeLease>): HeldScopes {
		const roots = new Set(this.roots), files = new Set(this.files), folders = new Set(this.folders);
		for (const lease of added) ("root" in lease ? roots : "file" in lease ? files : folders).add(leaseKey(lease));
		return { roots: [...roots].sort(), files: [...files].sort(), folders: [...folders].sort() };
	}

	private async execute(operation: Operation, request: ScopeSetRequest, cwd: string, sessionId: string, priorDrain: Promise<void>, beforeCommit?: (scopes: HeldScopes) => void, expected?: { roots?: readonly string[]; files?: readonly string[]; folders?: readonly string[] }): Promise<LeaseSetResult> {
		const signal = operation.controller.signal;
		let committed = false;
		try {
			await priorDrain;
			if (!this.current(operation)) return { kind: "cancelled" };
			const roots = request.worktrees.kind === "none" ? []
				: request.worktrees.kind === "cwd" ? [cwd]
					: await this.resolveRoots(request.worktrees.paths, cwd, signal);
			const requestedFiles = request.files.length ? await (this.options.resolveFiles ?? resolveExplicitFiles)(request.files, cwd, signal) : [];
			const requestedFolders = request.folders?.length
				? await (this.options.resolveFolders ?? ((paths, base, abort) => resolveExplicitFolders(paths, base, abort ? { signal: abort } : {})))(request.folders, cwd, signal)
				: [];
			if (expected?.roots && !same(roots, expected.roots)) return { kind: "invalid", detail: "Restored canonical roots changed; select scopes explicitly" };
			if (expected?.files && !same(requestedFiles, expected.files)) return { kind: "invalid", detail: "Restored canonical files changed; grant files explicitly" };
			if (expected?.folders && !same(requestedFolders, expected.folders)) return { kind: "invalid", detail: "Restored canonical folders changed; grant folders explicitly" };
			if (!this.current(operation)) return { kind: "cancelled" };
			if (roots.length === 0 && requestedFiles.length === 0 && requestedFolders.length === 0) return { kind: "invalid", detail: "Expected at least one worktree, exact file or folder scope" };
			for (const folder of requestedFolders) {
				const inside = [...this.#files.keys(), ...this.#folders.keys()].find((grant) => grant !== folder && isWithin(grant, folder));
				if (inside) return { kind: "invalid", detail: `Folder ${JSON.stringify(folder)} contains the held grant ${JSON.stringify(inside)}; revoke it first` };
			}
			const folders = requestedFolders.filter((folder) => !this.#folders.has(folder) && !containing(folder, [...this.#folders.keys(), ...requestedFolders]));
			const files = requestedFiles.filter((file) => !containing(file, [...this.#folders.keys(), ...folders]));
			if (new Set([...this.roots, ...roots]).size > MAX_LEASE_ROOTS) return { kind: "invalid", detail: `Expected at most ${MAX_LEASE_ROOTS} held worktrees` };
			if (new Set([...this.files, ...files]).size > MAX_FILE_GRANTS) return { kind: "invalid", detail: `Expected at most ${MAX_FILE_GRANTS} held file grants` };
			if (new Set([...this.folders, ...folders]).size > MAX_FOLDER_GRANTS) return { kind: "invalid", detail: `Expected at most ${MAX_FOLDER_GRANTS} held folder grants` };
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
				const result = await (this.options.acquireFile ?? acquireFileLease)(file, { signal, sessionId, expectedFile: file, intentPool: this.#intents });
				if (result.kind === "held") {
					operation.added.add(result); this.watch(result, operation);
					if (result.alive === false) this.lose();
					if (result.file !== file) return { kind: "invalid", detail: "File identity changed during acquisition" };
				}
				if (!this.current(operation)) return { kind: "cancelled" };
				if (result.kind !== "held") return result;
			}
			for (const folder of [...new Set(folders)].sort()) {
				if (!this.current(operation)) return { kind: "cancelled" };
				const result = await (this.options.acquireFolder ?? acquireFolderLease)(folder, { signal, sessionId, expectedDir: folder, intentPool: this.#intents });
				if (result.kind === "held") {
					operation.added.add(result); this.watch(result, operation);
					if (result.alive === false) this.lose();
					if (result.dir !== folder) return { kind: "invalid", detail: "Folder identity changed during acquisition" };
				}
				if (!this.current(operation)) return { kind: "cancelled" };
				if (result.kind !== "held") return result;
			}
			if ([...this.#roots.values(), ...this.#files.values(), ...this.#folders.values(), ...operation.added].some((lease) => lease.alive === false)) this.lose();
			if (!this.current(operation)) return { kind: "cancelled" };
			const scopes = this.scopesWith(operation.added);
			beforeCommit?.(scopes);
			if (!this.current(operation)) return { kind: "cancelled" };
			for (const lease of operation.added) {
				if ("root" in lease) this.#roots.set(lease.root, lease);
				else if ("file" in lease) this.#files.set(lease.file, lease);
				else this.#folders.set(lease.dir, lease);
			}
			operation.added.clear(); this.#revision++; committed = true;
			return { kind: "held", roots: this.roots, files: this.files, folders: this.folders };
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
