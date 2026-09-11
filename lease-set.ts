import { acquireWorktreeLease, type HeldWorktreeLease, type WorktreeLeaseResult } from "./lease.ts";
import { ADDITION_TIMEOUT_MS, MAX_LEASE_ROOTS, resolveExplicitRoots } from "./scope.ts";

type Acquire = (root: string, options: { sessionId: string; signal: AbortSignal; expectedRoot?: string }) => Promise<WorktreeLeaseResult>;
type ResolveRoots = (paths: string[], cwd: string, signal?: AbortSignal) => Promise<string[]>;
export type LeaseSetResult =
	| { kind: "held"; roots: string[] }
	| Exclude<WorktreeLeaseResult, HeldWorktreeLease>
	| { kind: "invalid"; detail: string }
	| { kind: "cancelled" | "busy" };
interface Operation {
	key: string;
	epoch: number;
	controller: AbortController;
	added: Set<HeldWorktreeLease>;
	promise: Promise<LeaseSetResult>;
}

export class LeaseSet {
	readonly #held = new Map<string, HeldWorktreeLease>();
	readonly #releases = new WeakMap<HeldWorktreeLease, Promise<void>>();
	#operation?: Operation;
	#drain: Promise<void> = Promise.resolve();
	#epoch = 0;
	#revision = 0;
	#lost = false;

	constructor(
		private readonly acquire: Acquire = acquireWorktreeLease,
		private readonly resolveRoots: ResolveRoots = resolveExplicitRoots,
		private readonly onLost: () => void = () => {},
		private readonly options: { timeoutMs?: number } = {},
	) {}

	get roots(): string[] { return [...this.#held.keys()].sort(); }
	get revision(): number { return this.#revision; }
	get lost(): boolean { return this.#lost; }
	get live(): boolean { return !this.#lost && this.#held.size > 0 && [...this.#held.values()].every((lease) => lease.alive !== false); }
	get draining(): Promise<void> { return this.#drain; }

	add(paths: string[] | undefined, cwd: string, sessionId: string, beforeCommit?: (roots: string[]) => void, expectedRoots?: readonly string[]): Promise<LeaseSetResult> {
		const key = JSON.stringify([cwd, sessionId, paths, expectedRoots]);
		if (this.#operation) return this.#operation.key === key ? this.#operation.promise : Promise.resolve({ kind: "busy" });
		const priorDrain = this.#drain;
		const operation: Operation = {
			key, epoch: ++this.#epoch, controller: new AbortController(), added: new Set(),
			promise: undefined!,
		};
		this.#operation = operation;
		this.#lost = false;
		const timer = setTimeout(() => operation.controller.abort(), this.options.timeoutMs ?? ADDITION_TIMEOUT_MS);
		operation.promise = this.execute(operation, paths, cwd, sessionId, priorDrain, beforeCommit, expectedRoots).finally(() => {
			clearTimeout(timer);
			if (this.#operation === operation) this.#operation = undefined;
		});
		return operation.promise;
	}

	private release(lease: HeldWorktreeLease): Promise<void> {
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
		const leases = new Set([...this.#held.values(), ...(pending?.added ?? [])]);
		this.#held.clear();
		pending?.added.clear();
		this.#drain = Promise.all([this.#drain, ...[...leases].map((lease) => this.release(lease)), pending?.promise]).then(() => undefined);
		return this.#drain;
	}

	private lose(): void {
		if (this.#lost) return;
		this.#lost = true;
		try { this.onLost(); }
		finally { void this.releaseAll().catch(() => { /* The rejected drain prevents further acquisitions. */ }); }
	}

	private watch(lease: HeldWorktreeLease, operation: Operation): void {
		const onLoss = () => {
			if (this.#held.get(lease.root) === lease || operation.added.has(lease)) this.lose();
		};
		void lease.lost.then(onLoss, onLoss).catch(() => { /* Loss has already guarded and initiated draining. */ });
	}

	private current(operation: Operation): boolean {
		return operation.epoch === this.#epoch && !operation.controller.signal.aborted && !this.#lost;
	}

	private async execute(operation: Operation, paths: string[] | undefined, cwd: string, sessionId: string, priorDrain: Promise<void>, beforeCommit?: (roots: string[]) => void, expectedRoots?: readonly string[]): Promise<LeaseSetResult> {
		const signal = operation.controller.signal;
		let committed = false;
		try {
			await priorDrain;
			if (!this.current(operation)) return { kind: "cancelled" };
			const roots = paths === undefined ? [cwd] : await this.resolveRoots(paths, cwd, signal);
			if (expectedRoots && JSON.stringify([...new Set(roots)].sort()) !== JSON.stringify([...expectedRoots].sort())) return { kind: "invalid", detail: "Restored canonical roots changed; select scopes explicitly" };
			if (!this.current(operation)) return { kind: "cancelled" };
			if (roots.length === 0 || new Set([...this.roots, ...roots]).size > MAX_LEASE_ROOTS) return { kind: "invalid", detail: `Expected at most ${MAX_LEASE_ROOTS} held worktrees` };
			for (const root of [...new Set(roots)].sort()) {
				if (!this.current(operation)) return { kind: "cancelled" };
				if (this.#held.has(root)) continue;
				const result = await this.acquire(root, { signal, sessionId, ...(paths === undefined ? {} : { expectedRoot: root }) });
				if (result.kind === "held") {
					operation.added.add(result);
					this.watch(result, operation);
					if (result.alive === false) this.lose();
					if (paths !== undefined && result.root !== root) return { kind: "invalid", detail: "Worktree identity changed during acquisition" };
				}
				if (!this.current(operation)) return { kind: "cancelled" };
				if (result.kind !== "held") return result;
			}
			if ([...this.#held.values(), ...operation.added].some((lease) => lease.alive === false)) this.lose();
			if (!this.current(operation)) return { kind: "cancelled" };
			beforeCommit?.([...new Set([...this.roots, ...[...operation.added].map((lease) => lease.root)])].sort());
			if (!this.current(operation)) return { kind: "cancelled" };
			for (const lease of operation.added) this.#held.set(lease.root, lease);
			operation.added.clear();
			this.#revision++;
			committed = true;
			return { kind: "held", roots: this.roots };
		} catch (error) {
			return this.current(operation) ? { kind: "invalid", detail: error instanceof Error ? error.message : String(error) } : { kind: "cancelled" };
		} finally {
			if (!committed) {
				const rollback = [...operation.added];
				operation.added.clear();
				try { await Promise.all(rollback.map((lease) => this.release(lease))); }
				catch (error) { this.lose(); throw error; }
			}
		}
	}
}
