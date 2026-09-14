import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveGrantFile } from "./file-scope.ts";

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
	| { kind: "contended"; file: string; holder?: FileLeaseHolderMetadata }
	| { kind: "unavailable"; reason: "invalid" | "flock-unavailable" | "lease-error"; file?: string; detail?: string };

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

export interface AcquireFileLeaseOptions {
	expectedFile?: string;
	signal?: AbortSignal;
	runtimeDir?: string;
	flockCommand?: string;
	sessionId?: string;
	readyTimeoutMs?: number;
	writeMetadata?(path: string, contents: string): Promise<void>;
	resolveFile?(file: string, signal?: AbortSignal): Promise<string>;
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

export function worktreeLeaseRuntimeDir(): string {
	return join(process.env.XDG_RUNTIME_DIR || tmpdir(), `pi-session-guard-${process.getuid?.() ?? "user"}`);
}

export function worktreeLeaseLockPath(root: string, runtimeDir = worktreeLeaseRuntimeDir()): string {
	return join(runtimeDir, `${lockIdentity(root)}.lock`);
}

export function fileLeaseLockPath(file: string, runtimeDir = worktreeLeaseRuntimeDir()): string {
	return join(runtimeDir, `file-${lockIdentity(file)}.lock`);
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

function validHolder(value: Record<string, unknown>): boolean {
	return typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0
		&& typeof value.parentPid === "number" && Number.isSafeInteger(value.parentPid) && value.parentPid > 0
		&& typeof value.sessionId === "string" && typeof value.startedAt === "string";
}

async function readHolder<Metadata>(path: string, identity: "root" | "file"): Promise<Metadata | undefined> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		if (typeof value[identity] === "string" && validHolder(value)) return value as Metadata;
	} catch {
		// Diagnostic metadata is best effort and never establishes ownership.
	}
	return undefined;
}

async function acquireKernelLease<Metadata>(
	lockPath: string,
	metadataPath: string,
	metadataFor: (holderPid: number) => Metadata,
	identity: "root" | "file",
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
	const metadataTempPath = `${metadataPath}.${randomUUID()}.tmp`;
	const writeMetadata = options.writeMetadata ?? ((path: string, contents: string) => writeFile(path, contents, { mode: 0o600 }));
	const holderScript = 'if ! IFS= read -r command || [ "$command" != publish ]; then rm -f -- "$1"; exit 70; fi; mv -f -- "$1" "$2" || exit 71; printf "ready\\n"; exec cat >/dev/null';
	const child = spawn(
		options.flockCommand ?? "flock",
		["-n", "-F", "-E", "75", lockPath, "sh", "-c", holderScript, "pi-session-guard", metadataTempPath, metadataPath],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	return new Promise<KernelLeaseResult<Metadata>>((resolve) => {
		let output = "", errorOutput = "";
		let holderPid: number | undefined;
		let phase: "acquiring" | "held" | "finished" = "acquiring";
		let releasing = false;
		let lostResolve: (() => void) | undefined;
		const lost = new Promise<void>((done) => (lostResolve = done));
		const cleanupTemp = () => void unlink(metadataTempPath).catch(() => undefined);
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
			void writeMetadata(metadataTempPath, `${JSON.stringify(metadataFor(holderPid))}\n`)
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
			if (code === 75) { void readHolder<Metadata>(metadataPath, identity).then((holder) => resolve({ kind: "contended", holder })); return; }
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
	const result = await acquireKernelLease<LeaseHolderMetadata>(
		worktreeLeaseLockPath(resolved.root, runtimeDir),
		join(runtimeDir, `${identity}.json`),
		(holderPid) => ({ root: resolved.root, pid: holderPid, parentPid: process.pid, sessionId, startedAt: new Date().toISOString() }),
		"root",
		options,
	);
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
	const identity = lockIdentity(resolved), sessionId = options.sessionId ?? process.env.PI_SESSION_ID ?? `pid-${process.pid}`;
	const result = await acquireKernelLease<FileLeaseHolderMetadata>(
		fileLeaseLockPath(resolved, runtimeDir),
		join(runtimeDir, `file-${identity}.json`),
		(holderPid) => ({ file: resolved, pid: holderPid, parentPid: process.pid, sessionId, startedAt: new Date().toISOString() }),
		"file",
		options,
	);
	if (result.kind === "held") return {
		kind: "held", file: resolved, holderPid: result.holderPid, lost: result.lost,
		get alive() { return result.alive; }, release: () => result.release(),
	};
	if (result.kind === "contended") return { ...result, file: resolved };
	return { ...result, file: resolved };
}
