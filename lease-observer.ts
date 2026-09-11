import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
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

interface CommandOutput {
	stdout: string;
}

function runCommand(command: string, args: string[], options: ProbeWorktreeLeaseOccupancyOptions): Promise<CommandOutput> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_LEASE_OCCUPANCY_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		execFile(command, args, {
			encoding: "utf8",
			timeout: timeoutMs,
			windowsHide: true,
			signal: options.signal,
		}, (error, stdout) => {
			if (error?.killed && error.signal === "SIGTERM") reject(new Error(`${command} timed out after ${timeoutMs}ms`));
			else if (error) reject(error);
			else resolve({ stdout });
		});
	});
}

interface LockObservation {
	held: boolean;
	holderPid?: number;
}

function observeLock(stdout: string, lockPath: string): LockObservation | undefined {
	try {
		const payload = JSON.parse(stdout) as { locks?: unknown };
		if (!Array.isArray(payload.locks)) return undefined;
		for (const value of payload.locks) {
			if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
			const lock = value as { path?: unknown; type?: unknown; mode?: unknown; pid?: unknown };
			if (lock.path !== lockPath || lock.type !== "FLOCK" || lock.mode !== "WRITE") continue;
			if (typeof lock.pid !== "number" || !Number.isSafeInteger(lock.pid) || lock.pid <= 0) return undefined;
			return { held: true, holderPid: lock.pid };
		}
		return { held: false };
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
	const pending: Array<{ index: number; root: string; lockPath: string }> = [];
	for (const [index, cwd] of cwds.entries()) {
		try {
			options.signal?.throwIfAborted();
			const resolved = await resolveGitRoot(cwd, { gitCommand: options.gitCommand, gitTimeoutMs: options.timeoutMs ?? DEFAULT_LEASE_OCCUPANCY_TIMEOUT_MS, signal: options.signal });
			if (!("root" in resolved)) { results[index] = { kind: "unavailable", reason: resolved.detail ?? resolved.reason }; continue; }
			const root = resolved.root;
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
			for (const { index, root, lockPath } of pending) {
				options.signal?.throwIfAborted();
				const observation = observeLock(locks.stdout, lockPath);
				if (!observation) { results[index] = { kind: "unavailable", reason: "lslocks returned an incompatible response" }; continue; }
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
