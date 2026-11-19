import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Type } from "typebox";
import { attendedConfirm } from "./attention.ts";
import { acquireFileLease } from "./lease.ts";
import { safeDisplay } from "./scope.ts";

const MAX_BYTES = 65_536;
const HELPER_SHA256 = "776cdd5663a0b8af563b7e86c0285ae39ed553f5cae0306a0c7aa16bcd601750";
const STORAGE_PARENT = ".agents";
const LEGACY_STORAGE = join(".claude", "handoffs");
const GIT_TIMEOUT_MS = 5000;
const SHA256 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export interface HandoffRequest { date: string; time: string; slug: string; content: string; overwriteSha256?: string }
export interface HandoffResult {
	schemaVersion: "wrap-up-save/v1";
	status: "saved" | "collision" | "cancelled";
	path: string;
	mode?: "new" | "overwrite";
	sha256?: string;
	bytes?: number;
	existingSha256?: string;
	suggestedSlug?: string;
}
interface SaveContext { sessionId: string; signal?: AbortSignal; confirm?: (message: string) => Promise<boolean> }
interface Dependencies { home: string; acquire: typeof acquireFileLease; run?: typeof runHelper; gitCommand?: string; gitTimeoutMs?: number }
interface GitProbe { command: string; timeoutMs: number }
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

function validate(input: HandoffRequest): HandoffRequest {
	if (!input || typeof input !== "object" || Object.keys(input).some((key) => !["date", "time", "slug", "content", "overwriteSha256"].includes(key))
		|| typeof input.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)
		|| typeof input.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)
		|| typeof input.slug !== "string" || input.slug.length > 120 || !SLUG.test(input.slug)
		|| typeof input.content !== "string" || Buffer.byteLength(input.content) > MAX_BYTES || input.content.includes("\0")
		|| !input.content.startsWith(`# Resume: ${input.slug} — ${input.date} ${input.time}\n`)
		|| (input.overwriteSha256 !== undefined && (typeof input.overwriteSha256 !== "string" || !SHA256.test(input.overwriteSha256)))) {
		throw new Error("Invalid handoff input; only date, time, slug, bounded resume content and optional overwriteSha256 are accepted");
	}
	return { ...input };
}

async function marked(directory: string, marker: string): Promise<boolean> {
	try { await lstat(join(directory, marker)); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Walks from a directory under home up to home itself; ancestors above home have their own rule. */
async function assertHandoffDirectory(directory: string, home: string, signal?: AbortSignal): Promise<void> {
	while (true) {
		signal?.throwIfAborted();
		if (basename(directory) === ".git") throw new Error("Handoff directory overlaps Git administration");
		for (const marker of [".git", "HEAD", "objects", "refs"]) {
			if (marker === ".git" && (directory === home || directory === join(home, STORAGE_PARENT))) continue;
			if (await marked(directory, marker)) throw new Error("Handoff directory overlaps Git administration or an unsupported repository");
		}
		const parent = dirname(directory);
		if (directory === home || parent === directory) return;
		directory = parent;
	}
}

function runGit(probe: GitProbe, args: string[], cwd: string, home: string, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; unavailable?: string }> {
	return new Promise((resolve) => {
		// Fixed argv and a fixed environment: caller Git overrides (GIT_DIR, GIT_WORK_TREE, config) never redirect the verdict.
		// Reading the index must not run a repository-configured fsmonitor command; the trailing -c wins over every config file.
		const child = execFile(probe.command, ["-c", "core.fsmonitor=false", ...args], { cwd, env: { HOME: home, PATH: process.env.PATH, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, timeout: probe.timeoutMs, maxBuffer: 16_384, encoding: "utf8", windowsHide: true, ...(signal ? { signal } : {}) }, (error, stdout) => {
			if (error && (error.killed || typeof error.code !== "number")) resolve({ code: null, stdout: "", unavailable: error.killed ? "timed out" : "could not be started" });
			else resolve({ code: child.exitCode, stdout });
		});
	});
}

/**
 * A repository enclosing home may stay only when it ignores the handoffs directory (covering the helper's temporary and
 * recovery files) and the exact target (so a tracked handoff is refused); anything unverifiable fails closed.
 */
async function assertIgnoredByEnclosingRepository(repository: string, target: string, home: string, probe: GitProbe, signal?: AbortSignal): Promise<void> {
	const toplevel = await runGit(probe, ["rev-parse", "--show-toplevel"], repository, home, signal);
	signal?.throwIfAborted();
	if (toplevel.unavailable) throw new Error(`Git ${toplevel.unavailable} while checking the repository enclosing the handoff home; nothing was saved`);
	let root: string | undefined;
	if (toplevel.code === 0) { try { root = await realpath(toplevel.stdout.replace(/\n$/, "")); } catch { root = undefined; } }
	if (root !== repository) throw new Error("Git repository enclosing the handoff home could not be verified; nothing was saved");
	for (const path of [dirname(target), target]) {
		const ignored = await runGit(probe, ["check-ignore", "-q", "--", path], repository, home, signal);
		signal?.throwIfAborted();
		if (ignored.unavailable) throw new Error(`Git ${ignored.unavailable} while checking whether the enclosing repository ignores the handoff; nothing was saved`);
		if (ignored.code === 1) throw new Error(`Git repository enclosing the handoff home does not ignore ${safeDisplay(JSON.stringify(path))}; nothing was saved`);
		if (ignored.code !== 0) throw new Error("Git check-ignore failed for the repository enclosing the handoff home; nothing was saved");
	}
}

async function assertAncestorsAboveHome(home: string, target: string, probe: GitProbe, signal?: AbortSignal): Promise<void> {
	for (let directory = dirname(home); ; directory = dirname(directory)) {
		signal?.throwIfAborted();
		if (basename(directory) === ".git") throw new Error("Handoff home overlaps Git administration");
		for (const marker of ["HEAD", "objects", "refs"]) {
			if (await marked(directory, marker)) throw new Error("Handoff home is nested inside Git administration or a bare repository");
		}
		if (await marked(directory, ".git")) await assertIgnoredByEnclosingRepository(directory, target, home, probe, signal);
		if (dirname(directory) === directory) return;
	}
}

async function assertCanonicalDirectory(path: string): Promise<void> {
	let info;
	try { info = await lstat(path); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Handoff directory unavailable"); throw error; }
	if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error("Handoff directory must be canonical and not symlinked");
}

async function assertMigrated(home: string): Promise<void> {
	// Hard cutover: while the retired location exists no handoff is written anywhere,
	// so an unmigrated machine fails visibly instead of splitting the store.
	try { await lstat(join(home, LEGACY_STORAGE)); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	throw new Error(`Handoff storage migration-required: ~/${LEGACY_STORAGE} still exists; complete the approved move to ~/${STORAGE_PARENT}/handoffs before saving`);
}

async function directory(home: string, name: string, probe: GitProbe, signal?: AbortSignal): Promise<string> {
	if (await realpath(home) !== home) throw new Error("Handoff home identity changed");
	await assertMigrated(home);
	// Decided before any directory is created, lease taken or helper launched.
	await assertAncestorsAboveHome(home, join(home, STORAGE_PARENT, "handoffs", name), probe, signal);
	await assertHandoffDirectory(home, home, signal);
	// ~/.agents already holds the reviewed helper; only the handoffs directory itself may be created.
	const parent = join(home, STORAGE_PARENT);
	await assertCanonicalDirectory(parent);
	await assertHandoffDirectory(parent, home, signal);
	signal?.throwIfAborted();
	const folder = join(parent, "handoffs");
	try { await mkdir(folder, { mode: 0o700 }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("Handoff directory unavailable"); }
	await assertCanonicalDirectory(folder);
	await assertHandoffDirectory(folder, home, signal);
	return folder;
}

async function targetBytes(path: string): Promise<Buffer> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = await file.stat();
		if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) throw new Error("Invalid handoff target");
		const bytes = Buffer.alloc(MAX_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const result = await file.read(bytes, length, bytes.length - length, null);
			if (!result.bytesRead) break;
			length += result.bytesRead;
		}
		const current = await lstat(path);
		if (length > MAX_BYTES || current.ino !== info.ino || current.dev !== info.dev || current.size !== info.size || current.mtimeMs !== info.mtimeMs) throw new Error("Handoff target changed during read");
		return bytes.subarray(0, length);
	} finally { await file.close(); }
}

async function assertTarget(path: string, home: string, probe: GitProbe, signal?: AbortSignal): Promise<void> {
	if (dirname(path) !== await directory(home, basename(path), probe, signal)) throw new Error("Handoff target identity changed");
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink()) throw new Error("Symlink handoff target refused");
		if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) throw new Error("Invalid handoff target");
		if (await realpath(path) !== path) throw new Error("Handoff target identity changed");
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	signal?.throwIfAborted();
}

async function runHelper(source: string, home: string, input: HandoffRequest): Promise<{ code: number | null; stdout: string }> {
	const args = ["-I", "-c", source, input.date, input.time, input.slug];
	if (input.overwriteSha256) args.push("--overwrite-sha256", input.overwriteSha256);
	return new Promise((resolve, reject) => {
		// Execute the digest-checked bytes, not a mutable script path; no shell or caller environment.
		const child = execFile("python3", args, { cwd: home, env: { HOME: home, PATH: process.env.PATH }, timeout: 10_000, maxBuffer: 16_384, encoding: "utf8" }, (error, stdout) => {
			if (error && (error.killed || typeof error.code !== "number")) reject(new Error("Handoff helper unavailable, timed out or exceeded output limit; save unverified"));
			else resolve({ code: child.exitCode, stdout });
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(input.content);
	});
}

export function createHandoffSaver(dependencies: Dependencies = { home: homedir(), acquire: acquireFileLease }) {
	// Runtime-owned home and dependencies are never tool arguments or project settings.
	const { home, acquire } = dependencies;
	const run = dependencies.run ?? runHelper;
	const probe: GitProbe = { command: dependencies.gitCommand ?? "git", timeoutMs: dependencies.gitTimeoutMs ?? GIT_TIMEOUT_MS };
	return async (value: HandoffRequest, ctx: SaveContext): Promise<HandoffResult> => {
		const input = validate(value);
		ctx.signal?.throwIfAborted();
		const source = await readFile(join(home, ".agents/skills/wrap-up/scripts/save-handoff.py"), "utf8");
		if (digest(source) !== HELPER_SHA256) throw new Error("Handoff helper digest differs from reviewed code; update the adapter after review");
		const canonicalHome = await realpath(home);
		const name = `${input.date}-${input.slug}.md`;
		const folder = await directory(canonicalHome, name, probe, ctx.signal);
		const path = join(folder, name);
		await assertTarget(path, canonicalHome, probe, ctx.signal);
		if (input.overwriteSha256) {
			if (!ctx.confirm) throw new Error("Handoff overwrite requires fresh interactive TUI confirmation");
			if (digest(await targetBytes(path)) !== input.overwriteSha256) throw new Error("Handoff overwrite-mismatch; inspect the current file again");
			const approved = await ctx.confirm(`Replace handoff ${safeDisplay(JSON.stringify(path))}?\nExisting SHA-256: ${input.overwriteSha256}\nReplacement SHA-256: ${digest(input.content)}\nReplacement bytes: ${Buffer.byteLength(input.content)}`);
			ctx.signal?.throwIfAborted();
			if (!approved) return { schemaVersion: "wrap-up-save/v1", status: "cancelled", path };
		}
		return withFileMutationQueue(path, async () => {
			ctx.signal?.throwIfAborted();
			if (await directory(canonicalHome, name, probe, ctx.signal) !== folder) throw new Error("Handoff directory changed");
			await assertTarget(path, canonicalHome, probe, ctx.signal);
			const lease = await acquire(path, {
				sessionId: ctx.sessionId, expectedFile: path, signal: ctx.signal,
				resolveFile: async (candidate, signal) => {
					if (candidate !== path) throw new Error("Handoff target identity changed");
					await assertTarget(candidate, canonicalHome, probe, signal);
					return candidate;
				},
			});
			if (lease.kind !== "held") throw new Error(lease.kind === "contended" ? "Handoff target held by another writer; no file was saved" : "Handoff target lease unavailable; no file was saved");
			let lost = false;
			void lease.lost.then(() => { lost = true; });
			try {
				ctx.signal?.throwIfAborted();
				await directory(canonicalHome, name, probe, ctx.signal);
				await assertTarget(path, canonicalHome, probe, ctx.signal);
				const healthy = () => !lost && lease.alive !== false;
				if (!healthy()) throw new Error("Handoff lease lost before save");
				// Once launched, drain this bounded atomic operation even on cancellation/shutdown.
				const response = await run(source, canonicalHome, input);
				let result: Record<string, unknown>;
				try { result = JSON.parse(response.stdout); } catch { throw new Error("Invalid handoff helper response; save unverified"); }
				if (!result || result.schemaVersion !== "wrap-up-save/v1" || result.path !== path || !healthy()) throw new Error("Invalid handoff receipt or lost lease; save unverified");
				if (response.code === 0 && result.status === "saved" && result.mode === (input.overwriteSha256 ? "overwrite" : "new")
					&& result.sha256 === digest(input.content) && result.bytes === Buffer.byteLength(input.content)
					&& (await targetBytes(path)).equals(Buffer.from(input.content))) {
					return { schemaVersion: "wrap-up-save/v1", status: "saved", path, mode: input.overwriteSha256 ? "overwrite" : "new", sha256: result.sha256 as string, bytes: result.bytes as number };
				}
				if (response.code === 3 && result.status === "collision" && !input.overwriteSha256
					&& typeof result.existingSha256 === "string" && SHA256.test(result.existingSha256)
					&& typeof result.suggestedSlug === "string" && SLUG.test(result.suggestedSlug) && result.suggestedSlug.length <= 120) {
					return { schemaVersion: "wrap-up-save/v1", status: "collision", path, existingSha256: result.existingSha256, suggestedSlug: result.suggestedSlug };
				}
				const reason = typeof result.reason === "string" && /^[a-z-]{1,80}$/.test(result.reason) ? result.reason : "invalid-receipt";
				const backup = typeof result.backupPath === "string" && dirname(result.backupPath) === folder && /\/\.wrap-up-backup-[0-9a-f]{16}\.tmp$/.test(result.backupPath) ? `; recovery copy: ${safeDisplay(JSON.stringify(result.backupPath))}` : "";
				throw new Error(`Handoff save unverified: ${reason}${backup}`);
			} finally { await lease.release(); }
		});
	};
}

export function registerHandoffSave(pi: ExtensionAPI, save = createHandoffSaver()): void {
	let session: { id: string; abort: AbortController } | undefined;
	const pending = new Set<Promise<unknown>>();
	pi.on("session_start", (_event, ctx) => { session = { id: ctx.sessionManager.getSessionId(), abort: new AbortController() }; });
	pi.on("session_shutdown", async () => {
		session?.abort.abort(); session = undefined;
		await Promise.allSettled([...pending]);
	});
	pi.registerTool({
		name: "save_handoff",
		label: "Save handoff",
		description: "Save the rendered wrap-up resume block to the fixed ~/.agents/handoffs location. A home nested inside a Git repository is accepted only while that repository ignores the exact target. Available in every guard state without /implement or /grant-file. New files auto-save; collisions never overwrite. overwriteSha256 requests a fresh native TUI confirmation, not automatic approval. Returns a verified wrap-up-save/v1 receipt; no caller-selected paths, commands or environment. Requires the reviewed installed wrap-up helper and Python 3.10+.",
		parameters: Type.Object({
			date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
			time: Type.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }),
			slug: Type.String({ pattern: SLUG.source, maxLength: 120 }),
			content: Type.String({ description: "Exact unfenced resume block; at most 64 KiB UTF-8", maxLength: MAX_BYTES }),
			overwriteSha256: Type.Optional(Type.String({ pattern: SHA256.source })),
		}, { additionalProperties: false }),
		async execute(_id, params, signal, _update, ctx) {
			const active = session;
			if (!active || active.id !== ctx.sessionManager.getSessionId()) throw new Error("Handoff session is no longer active");
			const combined = signal ? AbortSignal.any([active.abort.signal, signal]) : active.abort.signal;
			const operation = save(params, {
				sessionId: active.id, signal: combined,
				...(ctx.mode === "tui" && ctx.hasUI ? { confirm: async (message: string) => await attendedConfirm(ctx, "Overwrite handoff?", message, { signal: combined }) === "approved" } : {}),
			});
			pending.add(operation);
			try {
				const result = await operation;
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			} finally { pending.delete(operation); }
		},
	});
}
