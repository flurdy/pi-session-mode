import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveGrantFile, resolveGrantFolder } from "./file-scope.ts";
import { canonicalHome, isWithin, worktreeLeaseRuntimeDir } from "./path.ts";

export { worktreeLeaseRuntimeDir } from "./path.ts";

export interface LeaseHolderMetadata {
	root: string;
	pid: number;
	parentPid: number;
	sessionId: string;
	startedAt: string;
}

export interface HeldWorktreeLease {
	kind: "held";
	root: string;
	holderPid: number;
	lost: Promise<void>;
	readonly alive?: boolean;
	release(): Promise<void>;
}

export type WorktreeLeaseResult =
	| HeldWorktreeLease
	| { kind: "contended"; root: string; holder?: LeaseHolderMetadata }
	| { kind: "unguarded"; reason: "non-git" | "git-unavailable" | "flock-unavailable" | "lease-error"; detail?: string };

export interface FileLeaseHolderMetadata {
	file: string;
	pid: number;
	parentPid: number;
	sessionId: string;
	startedAt: string;
}

export interface HeldFileLease {
	kind: "held";
	file: string;
	holderPid: number;
	lost: Promise<void>;
	readonly alive?: boolean;
	release(): Promise<void>;
}

export type FileLeaseResult =
	| HeldFileLease
	| { kind: "contended"; file: string; holder?: FileLeaseHolderMetadata; intent?: string }
	| { kind: "unavailable"; reason: "invalid" | "flock-unavailable" | "lease-error"; file?: string; detail?: string };

export interface FolderLeaseHolderMetadata {
	dir: string;
	pid: number;
	parentPid: number;
	sessionId: string;
	startedAt: string;
}

export interface HeldFolderLease {
	kind: "held";
	dir: string;
	holderPid: number;
	lost: Promise<void>;
	readonly alive?: boolean;
	release(): Promise<void>;
}

/** `intent` names the ancestor whose exclusive folder lease blocked this acquisition. */
export type FolderLeaseResult =
	| HeldFolderLease
	| { kind: "contended"; dir: string; holder?: FolderLeaseHolderMetadata; intent?: string }
	| { kind: "unavailable"; reason: "invalid" | "flock-unavailable" | "lease-error"; dir?: string; detail?: string };

export interface LeaseExecOptions {
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface LeaseCommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
	error?: NodeJS.ErrnoException & { killed?: boolean; signal?: string };
}

export type LeaseExec = (command: string, args: string[], options: LeaseExecOptions) => Promise<LeaseCommandResult>;

export interface AcquireWorktreeLeaseOptions {
	expectedRoot?: string;
	signal?: AbortSignal;
	runtimeDir?: string;
	flockCommand?: string;
	gitCommand?: string;
	gitTimeoutMs?: number;
	exec?: LeaseExec;
	sessionId?: string;
	readyTimeoutMs?: number;
	writeMetadata?(path: string, contents: string): Promise<void>;
}

interface IntentLeaseOptions {
	/** Session-wide pool sharing ancestor intents; a private pool is used when omitted. */
	intentPool?: IntentPool;
	home?: string;
}

export interface AcquireFileLeaseOptions extends IntentLeaseOptions {
	expectedFile?: string;
	signal?: AbortSignal;
	runtimeDir?: string;
	flockCommand?: string;
	sessionId?: string;
	readyTimeoutMs?: number;
	writeMetadata?(path: string, contents: string): Promise<void>;
	resolveFile?(file: string, signal?: AbortSignal): Promise<string>;
}

export interface AcquireFolderLeaseOptions extends IntentLeaseOptions {
	expectedDir?: string;
	signal?: AbortSignal;
	runtimeDir?: string;
	flockCommand?: string;
	sessionId?: string;
	readyTimeoutMs?: number;
	writeMetadata?(path: string, contents: string): Promise<void>;
	resolveFolder?(dir: string, signal?: AbortSignal): Promise<string>;
}

function defaultExec(command: string, args: string[], options: LeaseExecOptions): Promise<LeaseCommandResult> {
	return new Promise((resolve) => {
		const child = execFile(command, args, {
			encoding: "utf8",
			timeout: options.timeoutMs,
			signal: options.signal,
			windowsHide: true,
		}, (error, stdout, stderr) => {
			resolve({
				code: typeof error?.code === "number" ? error.code : child.exitCode,
				stdout,
				stderr,
				...(error ? { error: error as NodeJS.ErrnoException } : {}),
			});
		});
	});
}

export function lockIdentity(root: string): string {
	return createHash("sha256").update(root).digest("hex");
}

export function worktreeLeaseLockPath(root: string, runtimeDir = worktreeLeaseRuntimeDir()): string {
	return join(runtimeDir, `${lockIdentity(root)}.lock`);
}

export function fileLeaseLockPath(file: string, runtimeDir = worktreeLeaseRuntimeDir()): string {
	return join(runtimeDir, `file-${lockIdentity(file)}.lock`);
}

/** Exclusive folder leases and shared ancestor intents use the same lock file per directory. */
export function folderLeaseLockPath(dir: string, runtimeDir = worktreeLeaseRuntimeDir()): string {
	return join(runtimeDir, `dir-${lockIdentity(dir)}.lock`);
}

/**
 * Proper ancestors needing a shared intent lock, outermost first. Root, home and home ancestors
 * can never be granted as folders, so intents there would protect nothing.
 */
export function intentAncestors(path: string, home: string): string[] {
	const ancestors: string[] = [];
	for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
		if (!isWithin(home, dir)) ancestors.push(dir);
	}
	return ancestors.reverse();
}

export async function resolveGitRoot(
	cwd: string,
	options: AcquireWorktreeLeaseOptions = {},
): Promise<{ root: string } | { reason: "non-git" | "git-unavailable"; detail?: string }> {
	const configuredTimeoutMs = options.gitTimeoutMs ?? 2000;
	const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : 2000;
	let result: LeaseCommandResult;
	try {
		result = await (options.exec ?? defaultExec)(
			options.gitCommand ?? "git",
			["-C", cwd, "rev-parse", "--show-toplevel"],
			{ timeoutMs, ...(options.signal ? { signal: options.signal } : {}) },
		);
	} catch (error) {
		return { reason: "git-unavailable", detail: error instanceof Error ? error.message : String(error) };
	}
	if (result.error?.code === "ENOENT") return { reason: "git-unavailable" };
	if (result.error?.killed && result.error.signal === "SIGTERM") {
		return { reason: "git-unavailable", detail: `git root lookup timed out after ${timeoutMs}ms` };
	}
	if (result.code !== 0) {
		if (result.code === 128) return { reason: "non-git" };
		return { reason: "git-unavailable", detail: result.stderr.trim() || result.error?.message || `git exited ${result.code}` };
	}
	try {
		const root = await realpath(result.stdout.replace(/\n$/, ""));
		let marker = await realpath(cwd);
		while (true) {
			options.signal?.throwIfAborted();
			try { await lstat(join(marker, ".git")); break; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(marker) === marker) throw error;
				marker = dirname(marker);
			}
		}
		if (root !== marker) return { reason: "git-unavailable", detail: "Git top-level does not match the nearest filesystem .git marker" };
		return { root };
	} catch (error) {
		return { reason: "git-unavailable", detail: error instanceof Error ? error.message : String(error) };
	}
}

interface KernelLeaseOptions {
	signal?: AbortSignal;
	flockCommand?: string;
	readyTimeoutMs?: number;
	writeMetadata?(path: string, contents: string): Promise<void>;
}

interface HeldKernelLease {
	kind: "held";
	holderPid: number;
	lost: Promise<void>;
	readonly alive?: boolean;
	release(): Promise<void>;
}

type KernelLeaseResult<Metadata> =
	| HeldKernelLease
	| { kind: "contended"; holder?: Metadata }
	| { kind: "unavailable"; reason: "flock-unavailable" | "lease-error"; detail?: string };

type HolderIdentity = "root" | "file" | "dir";

/** Exclusive holders publish diagnostic metadata before reporting ready; shared intents publish none. */
type KernelLeaseMode<Metadata> =
	| { kind: "exclusive"; metadataPath: string; metadataFor(holderPid: number): Metadata; identity: HolderIdentity }
	| { kind: "shared" };

function validHolder(value: Record<string, unknown>): boolean {
	return typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0
		&& typeof value.parentPid === "number" && Number.isSafeInteger(value.parentPid) && value.parentPid > 0
		&& typeof value.sessionId === "string" && typeof value.startedAt === "string";
}

/** Shape check only: diagnostic metadata never establishes ownership. */
export function holderMetadata(value: unknown, identity: HolderIdentity): LeaseHolderMetadata | FileLeaseHolderMetadata | FolderLeaseHolderMetadata | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	return typeof record[identity] === "string" && validHolder(record) ? record as unknown as LeaseHolderMetadata | FileLeaseHolderMetadata | FolderLeaseHolderMetadata : undefined;
}

async function readHolder<Metadata>(path: string, identity: HolderIdentity): Promise<Metadata | undefined> {
	try {
		return holderMetadata(JSON.parse(await readFile(path, "utf8")), identity) as Metadata | undefined;
	} catch {
		// Diagnostic metadata is best effort and never establishes ownership.
	}
	return undefined;
}

async function acquireKernelLease<Metadata>(
	lockPath: string,
	mode: KernelLeaseMode<Metadata>,
	options: KernelLeaseOptions,
): Promise<KernelLeaseResult<Metadata>> {
	const unavailable = (detail: string): KernelLeaseResult<Metadata> => ({ kind: "unavailable", reason: "lease-error", detail });
	if (options.signal?.aborted) return unavailable("Lease acquisition cancelled");
	const runtimeDir = dirname(lockPath);
	try {
		await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
		await chmod(runtimeDir, 0o700);
	} catch (error) {
		return unavailable(error instanceof Error ? error.message : String(error));
	}
	if (options.signal?.aborted) return unavailable("Lease acquisition cancelled");
	const exclusive = mode.kind === "exclusive" ? mode : undefined;
	const metadataTempPath = exclusive ? `${exclusive.metadataPath}.${randomUUID()}.tmp` : undefined;
	const writeMetadata = options.writeMetadata ?? ((path: string, contents: string) => writeFile(path, contents, { mode: 0o600 }));
	const holderArgs = exclusive
		? ["sh", "-c", 'if ! IFS= read -r command || [ "$command" != publish ]; then rm -f -- "$1"; exit 70; fi; mv -f -- "$1" "$2" || exit 71; printf "ready\\n"; exec cat >/dev/null', "pi-session-guard", metadataTempPath!, exclusive.metadataPath]
		: ["sh", "-c", 'printf "ready\\n"; exec cat >/dev/null', "pi-session-guard"];
	const child = spawn(
		options.flockCommand ?? "flock",
		[...(exclusive ? [] : ["-s"]), "-n", "-F", "-E", "75", lockPath, ...holderArgs],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	return new Promise<KernelLeaseResult<Metadata>>((resolve) => {
		let output = "", errorOutput = "";
		let holderPid: number | undefined;
		let phase: "acquiring" | "held" | "finished" = "acquiring";
		let releasing = false;
		let lostResolve: (() => void) | undefined;
		const lost = new Promise<void>((done) => (lostResolve = done));
		const cleanupTemp = () => { if (metadataTempPath) void unlink(metadataTempPath).catch(() => undefined); };
		const detachAbort = () => options.signal?.removeEventListener("abort", onAbort);
		const fail = (result: KernelLeaseResult<Metadata>) => {
			if (phase !== "acquiring") return;
			phase = "finished";
			clearTimeout(readyTimer);
			detachAbort(); cleanupTemp();
			child.once("close", () => resolve(result));
			child.kill("SIGKILL");
		};
		const onAbort = () => fail(unavailable("Lease acquisition cancelled"));
		const readyTimer = setTimeout(() => fail(unavailable("flock ready handshake timed out")), options.readyTimeoutMs ?? 2000);
		child.stdin.on("error", () => undefined);
		child.stderr.on("data", (chunk) => (errorOutput += String(chunk)));
		child.once("spawn", () => {
			if (phase !== "acquiring") return;
			holderPid = child.pid!;
			if (!exclusive) return;
			void writeMetadata(metadataTempPath!, `${JSON.stringify(exclusive.metadataFor(holderPid))}\n`)
				.then(() => {
					if (phase !== "acquiring") { cleanupTemp(); return; }
					child.stdin.write("publish\n");
				})
				.catch((error) => {
					cleanupTemp();
					fail(unavailable(error instanceof Error ? error.message : String(error)));
				});
		});
		child.once("error", (error: NodeJS.ErrnoException) => fail({
			kind: "unavailable",
			reason: error.code === "ENOENT" ? "flock-unavailable" : "lease-error",
			detail: error.message,
		}));
		child.once("close", (code) => {
			detachAbort();
			if (phase === "held") { phase = "finished"; if (!releasing) lostResolve?.(); return; }
			if (phase !== "acquiring") return;
			phase = "finished"; cleanupTemp(); clearTimeout(readyTimer);
			if (code === 75) {
				if (!exclusive) { resolve({ kind: "contended" }); return; }
				void readHolder<Metadata>(exclusive.metadataPath, exclusive.identity).then((holder) => resolve({ kind: "contended", holder }));
				return;
			}
			resolve(unavailable(errorOutput.trim() || `flock exited before ready (${code ?? "signal"})`));
		});
		child.stdout.on("data", (chunk) => {
			if (phase !== "acquiring") return;
			output += String(chunk);
			if (!output.includes("\n") || output.split("\n", 1)[0] !== "ready") return;
			phase = "held"; detachAbort(); clearTimeout(readyTimer);
			let releasePromise: Promise<void> | undefined;
			resolve({
				kind: "held", holderPid: holderPid!, lost,
				get alive() { return phase === "held" && !releasing && child.exitCode === null && child.signalCode === null; },
				release() {
					if (releasePromise) return releasePromise;
					releasing = true;
					releasePromise = new Promise<void>((done) => {
						if (phase === "finished") { done(); return; }
						const force = setTimeout(() => {
							if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
						}, 1000);
						child.once("close", () => { clearTimeout(force); done(); });
						try { child.stdin.end(); } catch { child.kill("SIGKILL"); }
					});
					return releasePromise;
				},
			});
		});
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
	});
}

export async function acquireWorktreeLease(cwd: string, options: AcquireWorktreeLeaseOptions = {}): Promise<WorktreeLeaseResult> {
	if (options.signal?.aborted) return { kind: "unguarded", reason: "lease-error", detail: "Lease acquisition cancelled" };
	const resolved = await resolveGitRoot(cwd, options);
	if (options.signal?.aborted) return { kind: "unguarded", reason: "lease-error", detail: "Lease acquisition cancelled" };
	if (!("root" in resolved)) return { kind: "unguarded", ...resolved };
	if (options.expectedRoot !== undefined && options.expectedRoot !== resolved.root) return { kind: "unguarded", reason: "lease-error", detail: "Worktree identity changed before acquisition" };
	const runtimeDir = options.runtimeDir ?? worktreeLeaseRuntimeDir();
	const identity = lockIdentity(resolved.root);
	const sessionId = options.sessionId ?? process.env.PI_SESSION_ID ?? `pid-${process.pid}`;
	const result = await acquireKernelLease<LeaseHolderMetadata>(worktreeLeaseLockPath(resolved.root, runtimeDir), {
		kind: "exclusive",
		metadataPath: join(runtimeDir, `${identity}.json`),
		metadataFor: (holderPid) => ({ root: resolved.root, pid: holderPid, parentPid: process.pid, sessionId, startedAt: new Date().toISOString() }),
		identity: "root",
	}, options);
	if (result.kind === "held") return {
		kind: "held", root: resolved.root, holderPid: result.holderPid, lost: result.lost,
		get alive() { return result.alive; }, release: () => result.release(),
	};
	if (result.kind === "contended") return { ...result, root: resolved.root };
	return { kind: "unguarded", reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) };
}

export async function acquireFileLease(file: string, options: AcquireFileLeaseOptions = {}): Promise<FileLeaseResult> {
	if (!isAbsolute(file)) return { kind: "unavailable", reason: "invalid", detail: "Expected an absolute file path" };
	let resolved: string;
	try {
		resolved = await (options.resolveFile ?? ((path, signal) => resolveGrantFile(pathToFileURL(path).href, "/", signal)))(file, options.signal);
	} catch (error) {
		return { kind: "unavailable", reason: "invalid", detail: error instanceof Error ? error.message : String(error) };
	}
	if (options.signal?.aborted) return { kind: "unavailable", reason: "lease-error", file: resolved, detail: "Lease acquisition cancelled" };
	if (options.expectedFile !== undefined && options.expectedFile !== resolved) return { kind: "unavailable", reason: "invalid", file: resolved, detail: "File identity changed before acquisition" };
	const runtimeDir = options.runtimeDir ?? worktreeLeaseRuntimeDir();
	const intents = await takeIntents(resolved, runtimeDir, options);
	if (intents.kind === "contended") return { kind: "contended", file: resolved, intent: intents.dir };
	if (intents.kind === "unavailable") return { ...intents, file: resolved };
	const identity = lockIdentity(resolved), sessionId = options.sessionId ?? process.env.PI_SESSION_ID ?? `pid-${process.pid}`;
	const result = await acquireKernelLease<FileLeaseHolderMetadata>(fileLeaseLockPath(resolved, runtimeDir), {
		kind: "exclusive",
		metadataPath: join(runtimeDir, `file-${identity}.json`),
		metadataFor: (holderPid) => ({ file: resolved, pid: holderPid, parentPid: process.pid, sessionId, startedAt: new Date().toISOString() }),
		identity: "file",
	}, options);
	if (result.kind === "held") {
		const lease = withIntents(result, intents);
		return { kind: "held", file: resolved, holderPid: lease.holderPid, lost: lease.lost, get alive() { return lease.alive; }, release: lease.release };
	}
	await intents.release();
	return { ...result, file: resolved };
}

export async function acquireFolderLease(dir: string, options: AcquireFolderLeaseOptions = {}): Promise<FolderLeaseResult> {
	if (!isAbsolute(dir)) return { kind: "unavailable", reason: "invalid", detail: "Expected an absolute folder path" };
	const runtimeDir = options.runtimeDir ?? worktreeLeaseRuntimeDir();
	let resolved: string;
	try {
		resolved = await (options.resolveFolder ?? ((path, signal) => resolveGrantFolder(pathToFileURL(path).href, "/", { runtimeDir, ...(signal ? { signal } : {}), ...(options.home ? { home: options.home } : {}) })))(dir, options.signal);
	} catch (error) {
		return { kind: "unavailable", reason: "invalid", detail: error instanceof Error ? error.message : String(error) };
	}
	if (options.signal?.aborted) return { kind: "unavailable", reason: "lease-error", dir: resolved, detail: "Lease acquisition cancelled" };
	if (options.expectedDir !== undefined && options.expectedDir !== resolved) return { kind: "unavailable", reason: "invalid", dir: resolved, detail: "Folder identity changed before acquisition" };
	const intents = await takeIntents(resolved, runtimeDir, options);
	if (intents.kind === "contended") return { kind: "contended", dir: resolved, intent: intents.dir };
	if (intents.kind === "unavailable") return { ...intents, dir: resolved };
	const identity = lockIdentity(resolved), sessionId = options.sessionId ?? process.env.PI_SESSION_ID ?? `pid-${process.pid}`;
	const result = await acquireKernelLease<FolderLeaseHolderMetadata>(folderLeaseLockPath(resolved, runtimeDir), {
		kind: "exclusive",
		metadataPath: join(runtimeDir, `dir-${identity}.json`),
		metadataFor: (holderPid) => ({ dir: resolved, pid: holderPid, parentPid: process.pid, sessionId, startedAt: new Date().toISOString() }),
		identity: "dir",
	}, options);
	if (result.kind === "held") {
		const lease = withIntents(result, intents);
		return { kind: "held", dir: resolved, holderPid: lease.holderPid, lost: lease.lost, get alive() { return lease.alive; }, release: lease.release };
	}
	await intents.release();
	return { ...result, dir: resolved };
}

interface HeldIntents {
	kind: "held";
	lost: Promise<void>;
	readonly alive: boolean;
	release(): Promise<void>;
}

export type IntentResult =
	| HeldIntents
	| { kind: "contended"; dir: string }
	| { kind: "unavailable"; reason: "flock-unavailable" | "lease-error"; detail?: string };

interface IntentEntry { lease: HeldKernelLease; count: number }

/**
 * Shared ancestor intent locks for one session, reference-counted per lock file, so an
 * exclusive folder lease elsewhere contends with every contained grant without enumerating
 * descendants. Loss of a shared holder is reported to every dependent lease.
 */
export class IntentPool {
	readonly #entries = new Map<string, IntentEntry>();
	readonly #pending = new Map<string, Promise<unknown>>();

	async acquire(dirs: readonly string[], runtimeDir: string, options: KernelLeaseOptions = {}): Promise<IntentResult> {
		const taken: IntentEntry[] = [];
		const releaseTaken = async () => { await Promise.all(taken.map((entry) => this.#release(entry))); };
		for (const dir of dirs) {
			const result = await this.#take(folderLeaseLockPath(dir, runtimeDir), options);
			if ("count" in result) { taken.push(result); continue; }
			await releaseTaken();
			return result.kind === "contended" ? { kind: "contended", dir } : { kind: "unavailable", reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) };
		}
		let released: Promise<void> | undefined;
		return {
			kind: "held",
			lost: Promise.race(taken.map((entry) => entry.lease.lost)),
			get alive() { return released === undefined && taken.every((entry) => entry.lease.alive !== false); },
			release: () => (released ??= releaseTaken()),
		};
	}

	async #take(lockPath: string, options: KernelLeaseOptions): Promise<IntentEntry | Exclude<KernelLeaseResult<never>, HeldKernelLease>> {
		while (true) {
			const pending = this.#pending.get(lockPath);
			if (pending) { await pending; continue; }
			const existing = this.#entries.get(lockPath);
			if (existing && existing.lease.alive !== false) { existing.count++; return existing; }
			if (existing) this.#entries.delete(lockPath);
			const acquiring = acquireKernelLease<never>(lockPath, { kind: "shared" }, options);
			this.#pending.set(lockPath, acquiring);
			let result: KernelLeaseResult<never>;
			try { result = await acquiring; }
			finally { this.#pending.delete(lockPath); }
			if (result.kind !== "held") return result;
			const entry: IntentEntry = { lease: result, count: 1 };
			this.#entries.set(lockPath, entry);
			void result.lost.then(() => { if (this.#entries.get(lockPath) === entry) this.#entries.delete(lockPath); });
			return entry;
		}
	}

	async #release(entry: IntentEntry): Promise<void> {
		if (--entry.count > 0) return;
		for (const [path, value] of this.#entries) if (value === entry) this.#entries.delete(path);
		await entry.lease.release();
	}
}

async function takeIntents(path: string, runtimeDir: string, options: AcquireFileLeaseOptions | AcquireFolderLeaseOptions): Promise<IntentResult> {
	const home = options.home ?? await canonicalHome();
	return (options.intentPool ?? new IntentPool()).acquire(intentAncestors(path, home), runtimeDir, options);
}

/** Losing either the exclusive holder or any intent loses the whole lease and drains its remaining holders. */
function withIntents(lease: HeldKernelLease, intents: HeldIntents): { holderPid: number; lost: Promise<void>; readonly alive: boolean; release(): Promise<void> } {
	let releasing: Promise<void> | undefined;
	const release = () => (releasing ??= lease.release().finally(() => intents.release()));
	const lost = Promise.race([lease.lost, intents.lost]);
	void lost.then(release);
	return {
		holderPid: lease.holderPid,
		lost,
		get alive() { return releasing === undefined && lease.alive !== false && intents.alive; },
		release,
	};
}
