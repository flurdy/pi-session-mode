import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { resolveGitRoot } from "./lease.ts";

/**
 * Exact uncommitted state of one worktree: porcelain v2 status records plus the worktree bytes
 * of every listed path. Two equal snapshots mean no listed change was added, removed, staged,
 * renamed or rewritten in between. Ambiguous shapes (submodules, conflicts, symlinks, special
 * files, oversized state) are never snapshotted.
 */
export interface DirtySnapshot {
	root: string;
	entries: readonly string[];
	takenAt: string;
}
export type DirtySnapshotResult = { kind: "snapshot"; snapshot: DirtySnapshot } | { kind: "unavailable"; reason: string };
export type DirtySnapshotComparison = { kind: "unchanged"; entries: number } | { kind: "changed"; reason: string };
export interface DirtySnapshotLimits {
	maxEntries: number;
	maxBytes: number;
	statusTimeoutMs: number;
	deadlineMs: number;
}
type Exec = (command: string, args: string[], options: { timeoutMs: number; signal?: AbortSignal }) => Promise<{ code: number; stdout: string }>;
export interface CaptureDirtySnapshotOptions {
	signal?: AbortSignal;
	limits?: Partial<DirtySnapshotLimits>;
	exec?: Exec;
	now?: () => Date;
}

export const DIRTY_SNAPSHOT_LIMITS: DirtySnapshotLimits = { maxEntries: 200, maxBytes: 32 * 1024 * 1024, statusTimeoutMs: 2000, deadlineMs: 5000 };

const defaultExec: Exec = (command, args, { timeoutMs, signal }) => new Promise((resolve, reject) => {
	execFile(command, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, ...(signal ? { signal } : {}) }, (error, stdout) => {
		if (error && typeof error.code !== "number") reject(error);
		else resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout });
	});
});

class Unavailable extends Error {}

/** Parses NUL-separated porcelain v2 records into status records and the worktree paths to hash. */
function parseStatus(stdout: string): { records: string[]; paths: Map<string, string> } {
	const fields = stdout.split("\0");
	if (fields.at(-1) === "") fields.pop();
	const records: string[] = [];
	const paths = new Map<string, string>();
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index]!;
		const kind = field[0];
		if (kind === "?") {
			const path = field.slice(2);
			records.push(field); paths.set(path, "untracked");
			continue;
		}
		if (kind === "u") throw new Unavailable("unmerged paths are present");
		if (kind !== "1" && kind !== "2") throw new Unavailable(`unexpected status record ${JSON.stringify(field.slice(0, 2))}`);
		const parts = field.split(" ");
		const [, , sub, , , worktreeMode] = parts;
		if (sub !== "N...") throw new Unavailable("submodule changes are present");
		const path = parts.slice(kind === "1" ? 8 : 9).join(" ");
		if (kind === "2") {
			const origin = fields[++index];
			if (origin === undefined) throw new Unavailable("truncated rename record");
			records.push(`${field}\0${origin}`);
		} else records.push(field);
		if (worktreeMode === "000000") continue;
		if (worktreeMode !== "100644" && worktreeMode !== "100755") throw new Unavailable("symlinks or special files are changed");
		paths.set(path, worktreeMode);
	}
	return { records, paths };
}

export async function captureDirtySnapshot(root: string, options: CaptureDirtySnapshotOptions = {}): Promise<DirtySnapshotResult> {
	const limits = { ...DIRTY_SNAPSHOT_LIMITS, ...options.limits };
	const deadline = Date.now() + limits.deadlineMs;
	try {
		const status = await (options.exec ?? defaultExec)(
			"git",
			["--no-optional-locks", "-C", root, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"],
			{ timeoutMs: limits.statusTimeoutMs, ...(options.signal ? { signal: options.signal } : {}) },
		);
		if (status.code !== 0) throw new Unavailable(`git status exited ${status.code}`);
		const { records, paths } = parseStatus(status.stdout);
		if (records.length > limits.maxEntries) throw new Unavailable(`more than ${limits.maxEntries} changed paths`);
		const entries = [...records];
		let bytes = 0;
		for (const [path, kind] of paths) {
			options.signal?.throwIfAborted();
			if (Date.now() > deadline) throw new Unavailable(`snapshot exceeded ${limits.deadlineMs}ms`);
			const file = join(root, path);
			const info = await lstat(file);
			if (!info.isFile()) throw new Unavailable("symlinks or special files are changed");
			bytes += info.size;
			if (bytes > limits.maxBytes) throw new Unavailable(`changed files exceed ${limits.maxBytes} bytes`);
			const digest = createHash("sha256").update(await readFile(file)).digest("hex");
			const mode = kind === "untracked" ? ((info.mode & 0o111) ? "x" : "-") : kind;
			entries.push(`worktree ${mode} ${digest} ${path}`);
		}
		if (Date.now() > deadline) throw new Unavailable(`snapshot exceeded ${limits.deadlineMs}ms`);
		return { kind: "snapshot", snapshot: { root, entries: entries.sort(), takenAt: (options.now?.() ?? new Date()).toISOString() } };
	} catch (error) {
		if (options.signal?.aborted) throw error;
		const reason = error instanceof Unavailable ? error.message : `cannot read uncommitted state (${(error as NodeJS.ErrnoException).code ?? "error"})`;
		return { kind: "unavailable", reason };
	}
}

/** Snapshots the canonical worktree that owns a path. */
export async function captureWorktreeDirtySnapshot(path: string, signal?: AbortSignal): Promise<DirtySnapshotResult> {
	let resolved: Awaited<ReturnType<typeof resolveGitRoot>>;
	try { resolved = await resolveGitRoot(await realpath(path), signal ? { signal } : {}); }
	catch (error) {
		if (signal?.aborted) throw error;
		return { kind: "unavailable", reason: "cannot resolve the owning worktree" };
	}
	if (!("root" in resolved)) return { kind: "unavailable", reason: `no owning Git worktree (${resolved.reason})` };
	return captureDirtySnapshot(resolved.root, signal ? { signal } : {});
}

export function compareDirtySnapshots(baseline: DirtySnapshot, current: DirtySnapshot): DirtySnapshotComparison {
	if (baseline.root !== current.root) return { kind: "changed", reason: "different worktree" };
	if (baseline.entries.length !== current.entries.length || baseline.entries.some((entry, index) => entry !== current.entries[index])) {
		return { kind: "changed", reason: "uncommitted changes differ from the session-startup snapshot" };
	}
	return { kind: "unchanged", entries: current.entries.length };
}
