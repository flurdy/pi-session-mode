import { readFile, realpath } from "node:fs/promises";
import { runCommand } from "./lease-inventory.ts";
import { resolveGitRoot, worktreeLeaseLockPath } from "./lease.ts";
import { MAX_LEASE_ROOTS } from "./scope.ts";

export const DEFAULT_LEASE_OCCUPANCY_TIMEOUT_MS = 2000;

export type WorktreeLeaseOccupancy =
	| { kind: "held" | "free"; root: string }
	| { kind: "unavailable"; reason: string };

export interface ProbeWorktreeLeaseOccupancyOptions {
	runtimeDir?: string;
	gitCommand?: string;
	lslocksCommand?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	selfPid?: number;
}

interface LockObservation {
	held: boolean;
	holderPid?: number;
}

/** Exclusive flocks by path; `null` marks a lock whose holder cannot be read, so its path stays unavailable rather than free. */
function observeLocks(stdout: string): Map<string, LockObservation | null> | undefined {
	try {
		const payload = JSON.parse(stdout) as { locks?: unknown };
		if (!Array.isArray(payload.locks)) return undefined;
		const observations = new Map<string, LockObservation | null>();
		for (const value of payload.locks) {
			if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
			const lock = value as { path?: unknown; type?: unknown; mode?: unknown; pid?: unknown };
			if (typeof lock.path !== "string" || lock.type !== "FLOCK" || lock.mode !== "WRITE" || observations.has(lock.path)) continue;
			const valid = typeof lock.pid === "number" && Number.isSafeInteger(lock.pid) && lock.pid > 0;
			observations.set(lock.path, valid ? { held: true, holderPid: lock.pid as number } : null);
		}
		return observations;
	} catch {
		return undefined;
	}
}

async function processParentPid(pid: number, signal?: AbortSignal): Promise<number | undefined> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal });
		const commandEnd = stat.lastIndexOf(") ");
		if (commandEnd < 0) return undefined;
		const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
		const parentPid = Number(fields[1]);
		return Number.isSafeInteger(parentPid) && parentPid > 0 ? parentPid : undefined;
	} catch {
		return undefined;
	}
}

export async function probeWorktreeLeaseOccupancy(
	cwd: string,
	options: ProbeWorktreeLeaseOccupancyOptions = {},
): Promise<WorktreeLeaseOccupancy> {
	return (await probeWorktreeLeaseOccupancies([cwd], options))[0]!;
}

export async function probeWorktreeLeaseOccupancies(
	cwds: readonly string[],
	options: ProbeWorktreeLeaseOccupancyOptions = {},
): Promise<WorktreeLeaseOccupancy[]> {
	if (cwds.length > MAX_LEASE_ROOTS) throw new Error(`At most ${MAX_LEASE_ROOTS} worktrees may be inspected`);
	const results: WorktreeLeaseOccupancy[] = [];
	const roots: string[] = [], indexes: number[] = [];
	for (const [index, cwd] of cwds.entries()) {
		try {
			options.signal?.throwIfAborted();
			const resolved = await resolveGitRoot(cwd, { gitCommand: options.gitCommand, gitTimeoutMs: options.timeoutMs ?? DEFAULT_LEASE_OCCUPANCY_TIMEOUT_MS, signal: options.signal });
			if (!("root" in resolved)) { results[index] = { kind: "unavailable", reason: resolved.detail ?? resolved.reason }; continue; }
			roots.push(resolved.root); indexes.push(index);
		} catch (error) {
			results[index] = { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
		}
	}
	const observations = await probeCanonicalWorktreeLeaseOccupancies(roots, options);
	for (const [index, result] of observations.entries()) results[indexes[index]!] = result;
	return results;
}

/** @internal Inventory roots already resolved by the scope scanner; no Git lookup or public batch limit. */
export async function probeCanonicalWorktreeLeaseOccupancies(
	roots: readonly string[],
	options: ProbeWorktreeLeaseOccupancyOptions = {},
): Promise<WorktreeLeaseOccupancy[]> {
	const results: WorktreeLeaseOccupancy[] = [];
	const pending: Array<{ index: number; root: string; lockPath: string }> = [];
	for (const [index, root] of roots.entries()) {
		try {
			options.signal?.throwIfAborted();
			if (await realpath(root) !== root) throw new Error("Worktree inventory root changed canonical identity");
			try {
				const lockPath = await realpath(worktreeLeaseLockPath(root, options.runtimeDir));
				pending.push({ index, root, lockPath });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				results[index] = { kind: "free", root };
			}
		} catch (error) {
			results[index] = { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
		}
	}
	if (pending.length) {
		try {
			const locks = await runCommand(options.lslocksCommand ?? "lslocks", ["--json", "--output", "PATH,TYPE,MODE,PID"], options);
			const observations = observeLocks(locks.stdout);
			if (!observations) throw new Error("lslocks returned an incompatible response");
			for (const { index, root, lockPath } of pending) {
				options.signal?.throwIfAborted();
				const observation = observations.has(lockPath) ? observations.get(lockPath)! : { held: false };
				if (observation === null) { results[index] = { kind: "unavailable", reason: "lslocks returned an incompatible response" }; continue; }
				const parentPid = observation.held ? await processParentPid(observation.holderPid!, options.signal) : undefined;
				options.signal?.throwIfAborted();
				results[index] = { kind: observation.held && parentPid !== (options.selfPid ?? process.pid) ? "held" : "free", root };
			}
		} catch (error) {
			for (const { index } of pending) results[index] = { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
		}
	}
	return results;
}
