import { execFile } from "node:child_process";
import { lstat, open, realpath, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { holderMetadata, lockIdentity, worktreeLeaseRuntimeDir } from "./lease.ts";

export const DEFAULT_LEASE_INVENTORY_TIMEOUT_MS = 2000;
export const MAX_INVENTORY_LOCKS = 128;
const MAX_METADATA_BYTES = 4096;
const LOCK_NAME = /^(file-|dir-)?([0-9a-f]{64})\.lock$/;
type LockKind = "worktree" | "file" | "folder";
const NAMESPACES: Record<LockKind, { prefix: string; identity: "root" | "file" | "dir" }> = {
	worktree: { prefix: "", identity: "root" },
	file: { prefix: "file-", identity: "file" },
	folder: { prefix: "dir-", identity: "dir" },
};

export interface CommandOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export function runCommand(command: string, args: string[], options: CommandOptions): Promise<{ stdout: string }> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_LEASE_INVENTORY_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		execFile(command, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, signal: options.signal }, (error, stdout) => {
			if (error?.killed && error.signal === "SIGTERM") reject(new Error(`${command} timed out after ${timeoutMs}ms`));
			else if (error) reject(error);
			else resolve({ stdout });
		});
	});
}

/** Live process ancestry, read from the kernel; never from holder metadata. */
export type ParentObservation =
	| { kind: "live"; parentPid: number }
	| { kind: "gone" }
	| { kind: "unavailable"; detail: string };

export async function observeParent(pid: number, ownerUid: number | undefined, signal?: AbortSignal): Promise<ParentObservation> {
	try {
		const owner = await stat(`/proc/${pid}`);
		if (ownerUid !== undefined && owner.uid !== ownerUid) return { kind: "unavailable", detail: "holder belongs to another user" };
		const status = await readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal });
		const commandEnd = status.lastIndexOf(") ");
		const parentPid = commandEnd < 0 ? Number.NaN : Number(status.slice(commandEnd + 2).trim().split(/\s+/)[1]);
		if (!Number.isSafeInteger(parentPid) || parentPid <= 0) return { kind: "unavailable", detail: "unreadable process ancestry" };
		return { kind: "live", parentPid };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "gone" };
		return { kind: "unavailable", detail: error instanceof Error ? error.message : String(error) };
	}
}

export interface HeldLock {
	kind: LockKind;
	identity: string;
	holderPid?: number;
	parent: "live" | "gone" | "unavailable";
	parentPid?: number;
	self: boolean;
	/** `bound` only when the metadata hash, holder pid and live parent pid all match the kernel observation. */
	binding: "bound" | "missing" | "invalid" | "mismatch";
	path?: string;
	sessionId?: string;
	startedAt?: string;
	detail?: string;
}

export interface LeaseInventorySession {
	parentPid?: number;
	self: boolean;
	/** Diagnostic session identifiers from bound metadata; never proof of a live Pi session. */
	sessionIds: string[];
	worktrees: HeldLock[];
	files: HeldLock[];
	/** Exclusive folder grants; shared ancestor intents are coordination detail and are not listed. */
	folders: HeldLock[];
}

export type LeaseInventory =
	| { kind: "inventory"; runtimeDir: string; sessions: LeaseInventorySession[]; truncated: boolean }
	| { kind: "unavailable"; runtimeDir: string; reason: string };

export interface LeaseInventoryOptions extends CommandOptions {
	runtimeDir?: string;
	lslocksCommand?: string;
	selfPid?: number;
	ownerUid?: number;
	readParent?(pid: number, signal?: AbortSignal): Promise<ParentObservation>;
}

interface LockRow { kind: LockKind; identity: string; pids: Set<number>; invalidPid: boolean }

function lockRows(stdout: string, runtimeDir: string): Map<string, LockRow> | undefined {
	let payload: { locks?: unknown };
	try { payload = JSON.parse(stdout); } catch { return undefined; }
	if (!Array.isArray(payload.locks)) return undefined;
	const rows = new Map<string, LockRow>();
	for (const value of payload.locks) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const lock = value as { path?: unknown; type?: unknown; mode?: unknown; pid?: unknown };
		if (typeof lock.path !== "string" || dirname(lock.path) !== runtimeDir || lock.type !== "FLOCK" || lock.mode !== "WRITE") continue;
		const name = basename(lock.path);
		const match = LOCK_NAME.exec(name);
		if (!match) continue;
		const row = rows.get(name) ?? { kind: match[1] === "file-" ? "file" : match[1] === "dir-" ? "folder" : "worktree", identity: match[2]!, pids: new Set(), invalidPid: false };
		if (typeof lock.pid === "number" && Number.isSafeInteger(lock.pid) && lock.pid > 0) row.pids.add(lock.pid);
		else row.invalidPid = true;
		rows.set(name, row);
	}
	return rows;
}

async function readBoundedMetadata(path: string, signal?: AbortSignal): Promise<{ kind: "missing" } | { kind: "invalid" } | { kind: "value"; value: unknown }> {
	let handle;
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.size > MAX_METADATA_BYTES) return { kind: "invalid" };
		handle = await open(path, "r");
		const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		signal?.throwIfAborted();
		if (bytesRead > MAX_METADATA_BYTES) return { kind: "invalid" };
		return { kind: "value", value: JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		if (signal?.aborted) throw error;
		return { kind: "invalid" };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function bindMetadata(entry: HeldLock, runtimeDir: string, signal?: AbortSignal): Promise<void> {
	const namespace = NAMESPACES[entry.kind];
	const result = await readBoundedMetadata(join(runtimeDir, `${namespace.prefix}${entry.identity}.json`), signal);
	if (result.kind !== "value") { entry.binding = result.kind; return; }
	const metadata = holderMetadata(result.value, namespace.identity);
	if (!metadata) { entry.binding = "invalid"; return; }
	const path = (metadata as unknown as Record<string, string>)[namespace.identity]!;
	const matches = lockIdentity(path) === entry.identity
		&& metadata.pid === entry.holderPid
		&& entry.parent === "live" && metadata.parentPid === entry.parentPid;
	if (!matches) { entry.binding = "mismatch"; return; }
	Object.assign(entry, { binding: "bound", path, sessionId: metadata.sessionId, startedAt: metadata.startedAt });
}

function groupSessions(entries: readonly HeldLock[]): LeaseInventorySession[] {
	const sessions = new Map<number | undefined, LeaseInventorySession>();
	for (const entry of entries) {
		const key = entry.parent === "live" ? entry.parentPid : undefined;
		const session = sessions.get(key) ?? { ...(key === undefined ? {} : { parentPid: key }), self: entry.self, sessionIds: [], worktrees: [], files: [], folders: [] };
		(entry.kind === "file" ? session.files : entry.kind === "folder" ? session.folders : session.worktrees).push(entry);
		if (entry.sessionId !== undefined && !session.sessionIds.includes(entry.sessionId)) session.sessionIds.push(entry.sessionId);
		sessions.set(key, session);
	}
	return [...sessions.values()].sort((left, right) => {
		if (left.self !== right.self) return left.self ? -1 : 1;
		if (left.parentPid === undefined || right.parentPid === undefined) return left.parentPid === undefined ? 1 : -1;
		return left.parentPid - right.parentPid;
	});
}

/**
 * Read-only inventory of every worktree and exact-file lease currently held in the
 * same-user Pi runtime directory. Kernel locks are the authority: holder metadata is
 * attached only when it agrees with the observed holder and its live parent process.
 * Nothing is acquired, released or created.
 */
export async function inventoryHeldLeases(options: LeaseInventoryOptions = {}): Promise<LeaseInventory> {
	const requestedDir = options.runtimeDir ?? worktreeLeaseRuntimeDir();
	const unavailable = (reason: string): LeaseInventory => ({ kind: "unavailable", runtimeDir: requestedDir, reason });
	let runtimeDir: string;
	try {
		options.signal?.throwIfAborted();
		runtimeDir = await realpath(requestedDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "inventory", runtimeDir: requestedDir, sessions: [], truncated: false };
		return unavailable(error instanceof Error ? error.message : String(error));
	}
	const ownerUid = options.ownerUid ?? process.getuid?.();
	try {
		const info = await stat(runtimeDir);
		if (!info.isDirectory()) return unavailable("runtime directory is not a directory");
		if ((ownerUid !== undefined && info.uid !== ownerUid) || (info.mode & 0o077) !== 0) return unavailable("runtime directory is not private to this user");
	} catch (error) {
		return unavailable(error instanceof Error ? error.message : String(error));
	}
	let rows: Map<string, LockRow> | undefined;
	try {
		const scan = await runCommand(options.lslocksCommand ?? "lslocks", ["--json", "--output", "PATH,TYPE,MODE,PID"], options);
		rows = lockRows(scan.stdout, runtimeDir);
	} catch (error) {
		return unavailable(error instanceof Error ? error.message : String(error));
	}
	if (!rows) return unavailable("lslocks returned an incompatible response");
	const selfPid = options.selfPid ?? process.pid;
	const readParent = options.readParent ?? ((pid, signal) => observeParent(pid, ownerUid, signal));
	const names = [...rows.keys()].sort();
	const entries: HeldLock[] = [];
	try {
		for (const name of names.slice(0, MAX_INVENTORY_LOCKS)) {
			options.signal?.throwIfAborted();
			const row = rows.get(name)!;
			const entry: HeldLock = { kind: row.kind, identity: row.identity, parent: "unavailable", self: false, binding: "mismatch" };
			if (row.invalidPid || row.pids.size !== 1) {
				entry.detail = row.pids.size > 1 ? "lock scan reports several holder pids" : "lock scan reports no valid holder pid";
			} else {
				entry.holderPid = [...row.pids][0]!;
				const parent = await readParent(entry.holderPid, options.signal);
				entry.parent = parent.kind;
				if (parent.kind === "live") { entry.parentPid = parent.parentPid; entry.self = parent.parentPid === selfPid; }
				else if (parent.kind === "unavailable") entry.detail = parent.detail;
				await bindMetadata(entry, runtimeDir, options.signal);
			}
			entries.push(entry);
		}
	} catch (error) {
		return unavailable(error instanceof Error ? error.message : String(error));
	}
	return { kind: "inventory", runtimeDir, sessions: groupSessions(entries), truncated: names.length > MAX_INVENTORY_LOCKS };
}
