import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { MAX_FOLDER_GRANTS, resolveExplicitFolders } from "./file-scope.ts";
import { isWithin } from "./path.ts";
import { adminRunRefusal, destructiveCommandLines, invokedCommand } from "./policy.ts";
import { safeDisplay } from "./scope.ts";

export const ADMIN_MAX_SCRIPT_BYTES = 16 * 1024;
export const ADMIN_MAX_SCRIPT_LINES = 200;
export const ADMIN_MAX_ARGS = 32;
export const ADMIN_DEFAULT_TIMEOUT_SECONDS = 120;
export const ADMIN_MAX_TIMEOUT_SECONDS = 900;
const MAX_DIALOG_CHARS = 24_000;
const OUTPUT_LIMIT = 64 * 1024;
const OUTPUT_TAIL = 16 * 1024;
const KILL_GRACE_MS = 2000;
const GROUP_EXIT_POLL_MS = 20;
const GIT_TIMEOUT_MS = 5000;
// make options that would run a recipe other than the one bound through cwd.
const MAKE_REDIRECT = /^(?:-(?!-)[A-Za-z0-9]*[Cf].*|--directory(?:=.*)?|--file(?:=.*)?|--makefile(?:=.*)?)$/;

export interface AdminRunRequest {
	purpose: string;
	cwd: string;
	writes: string[];
	script?: string;
	argv?: string[];
	timeoutSeconds?: number;
}

export type AdminCommand =
	| { kind: "script"; shell: string; script: string; sha256: string }
	| { kind: "argv"; executable: string; argv: string[] };

export interface RepositoryBinding { root: string; head: string }

export interface PreparedAdminRun {
	purpose: string;
	command: AdminCommand;
	cwd: string;
	repository?: RepositoryBinding;
	writes: { path: string; exists: boolean }[];
	destructive: string[];
	timeoutMs: number;
}

export type AdminRunStatus = "ok" | "failed" | "declined" | "refused" | "stale" | "interrupted";

export interface AdminRunReceipt {
	schemaVersion: "admin-run/v1";
	status: AdminRunStatus;
	reason?: string;
	purpose?: string;
	cwd?: string;
	writes?: string[];
	sha256?: string;
	argv?: string[];
	exitCode?: number | null;
	signal?: string | null;
	durationMs?: number;
	lingering?: boolean;
	output?: string;
	outputTruncated?: boolean;
}

export interface AdminRunDependencies {
	env?: NodeJS.ProcessEnv;
	resolveFolders?(paths: string[], cwd: string, signal?: AbortSignal): Promise<string[]>;
}

function refuse(message: string): never { throw new Error(message); }

/** Escapes terminal control bytes but keeps line breaks and tabs readable. */
function displayLines(text: string): string {
	return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number | null; stdout: string }> {
	return new Promise((resolve) => {
		const child = spawn("git", args, {
			cwd, stdio: ["ignore", "pipe", "ignore"], timeout: GIT_TIMEOUT_MS, ...(signal ? { signal } : {}),
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
		});
		let stdout = "";
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.once("error", () => resolve({ code: null, stdout }));
		child.once("close", (code) => resolve({ code, stdout }));
	});
}

async function hasGitMarker(directory: string): Promise<boolean> {
	for (let current = directory; ; current = dirname(current)) {
		if (await lstat(join(current, ".git")).then(() => true, () => false)) return true;
		if (dirname(current) === current) return false;
	}
}

/** A repository-backed cwd must be clean so the approved recipe is the one that runs. */
async function bindRepository(cwd: string, signal?: AbortSignal): Promise<RepositoryBinding | undefined> {
	const top = await runGit(["rev-parse", "--show-toplevel"], cwd, signal);
	if (top.code !== 0) {
		if (top.code === 128 && !(await hasGitMarker(cwd))) return undefined;
		refuse("Cannot verify the working directory's repository state");
	}
	const root = await realpath(top.stdout.trim());
	const head = await runGit(["rev-parse", "--verify", "HEAD"], root, signal);
	if (head.code !== 0) refuse(`Repository ${JSON.stringify(root)} needs a committed HEAD`);
	const status = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], root, signal);
	if (status.code !== 0) refuse(`Cannot read the status of repository ${JSON.stringify(root)}`);
	if (status.stdout) refuse(`Repository-backed cwd ${JSON.stringify(root)} must be clean (no tracked changes or untracked non-ignored files); commit or stash first`);
	return { root, head: head.stdout.trim() };
}

async function executableFile(path: string): Promise<string | undefined> {
	try {
		const real = await realpath(path);
		if (!(await stat(real)).isFile()) return undefined;
		await access(real, constants.X_OK);
		return real;
	} catch { return undefined; }
}

export async function resolveExecutable(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
	if (!name || name.includes("\0")) refuse("Invalid executable name");
	if (name.includes("/")) {
		if (!isAbsolute(name)) refuse("The executable must be an absolute path or a bare command name on PATH");
		return await executableFile(name) ?? refuse(`Executable ${JSON.stringify(name)} is not an executable file`);
	}
	for (const directory of (env.PATH ?? "").split(delimiter)) {
		if (!isAbsolute(directory)) continue;
		const found = await executableFile(join(directory, name));
		if (found) return found;
	}
	return refuse(`Executable ${JSON.stringify(name)} was not found on PATH`);
}

function shellQuote(word: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

const resolveFolders = (dependencies: AdminRunDependencies) => dependencies.resolveFolders
	?? ((paths: string[], cwd: string, signal?: AbortSignal) => resolveExplicitFolders(paths, cwd, signal ? { signal } : {}));

/** Validates and binds one run before confirmation. Throws a refusal message; nothing is executed. */
export async function prepareAdminRun(request: AdminRunRequest, dependencies: AdminRunDependencies = {}, signal?: AbortSignal): Promise<PreparedAdminRun> {
	const env = dependencies.env ?? process.env;
	const purpose = typeof request.purpose === "string" ? request.purpose.trim() : "";
	if (!purpose || purpose.length > 300 || /[\u0000-\u001f\u007f-\u009f]/.test(purpose)) refuse("Expected a one-line purpose of 1–300 characters");
	const hasScript = typeof request.script === "string", hasArgv = Array.isArray(request.argv);
	if (hasScript === hasArgv) refuse("Provide exactly one of script or argv");
	if (typeof request.cwd !== "string" || !isAbsolute(request.cwd)) refuse("cwd must be an absolute directory path");
	const cwd = await realpath(request.cwd).catch(() => refuse(`cwd ${JSON.stringify(request.cwd)} does not exist`));
	if (!(await stat(cwd)).isDirectory()) refuse("cwd must be a directory");
	let command: AdminCommand, inspected: string;
	if (hasScript) {
		const script = request.script!;
		if (!script.trim() || script.includes("\0") || Buffer.byteLength(script) > ADMIN_MAX_SCRIPT_BYTES) refuse(`Expected a non-empty script of at most ${ADMIN_MAX_SCRIPT_BYTES / 1024} KiB`);
		if (script.split("\n").length > ADMIN_MAX_SCRIPT_LINES) refuse(`Scripts are limited to ${ADMIN_MAX_SCRIPT_LINES} lines; keep them short and inspectable`);
		command = { kind: "script", shell: await resolveExecutable("bash", env), script, sha256: createHash("sha256").update(script).digest("hex") };
		inspected = script;
	} else {
		const argv = request.argv!;
		if (argv.length === 0 || argv.length > ADMIN_MAX_ARGS || argv.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 4096)) refuse(`Expected 1–${ADMIN_MAX_ARGS} argv strings`);
		const invoked = invokedCommand(argv);
		if (invoked && (invoked.executable === "make" || invoked.executable === "gmake") && invoked.args.some((arg) => MAKE_REDIRECT.test(arg))) {
			refuse("run_admin binds the recipe through cwd: set cwd to the recipe directory instead of using make -C or -f");
		}
		command = { kind: "argv", executable: await resolveExecutable(argv[0]!, env), argv: [...argv] };
		inspected = argv.map(shellQuote).join(" ");
	}
	const refusal = adminRunRefusal(inspected);
	if (refusal) refuse(refusal);
	if (!Array.isArray(request.writes) || request.writes.length === 0 || request.writes.length > MAX_FOLDER_GRANTS) refuse(`Declare 1–${MAX_FOLDER_GRANTS} non-Git folders the run is expected to change`);
	const resolved = await resolveFolders(dependencies)(request.writes, cwd, signal);
	const outermost = resolved.filter((path) => !resolved.some((other) => other !== path && isWithin(path, other)));
	const writes = await Promise.all(outermost.map(async (path) => ({ path, exists: await lstat(path).then(() => true, () => false) })));
	const timeoutSeconds = request.timeoutSeconds ?? ADMIN_DEFAULT_TIMEOUT_SECONDS;
	if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > ADMIN_MAX_TIMEOUT_SECONDS) refuse(`timeoutSeconds must be an integer from 1 to ${ADMIN_MAX_TIMEOUT_SECONDS}`);
	const repository = await bindRepository(cwd, signal);
	const prepared: PreparedAdminRun = { purpose, command, cwd, ...(repository ? { repository } : {}), writes, destructive: destructiveCommandLines(inspected), timeoutMs: timeoutSeconds * 1000 };
	if (adminRunDialog(prepared).length > MAX_DIALOG_CHARS) refuse("The confirmation would be too large to review; shorten the script");
	return prepared;
}

export function adminRunDialog(prepared: PreparedAdminRun): string {
	const show = (value: string) => safeDisplay(JSON.stringify(value));
	const { command } = prepared;
	const lines = [`Purpose: ${safeDisplay(prepared.purpose)}`];
	if (command.kind === "script") lines.push(`Command: bash script via ${show(command.shell)} --noprofile --norc -c`, `Script sha256: ${command.sha256}`);
	else lines.push(`Executable: ${show(command.executable)}`, `Arguments: ${safeDisplay(JSON.stringify(command.argv))}`);
	lines.push(`Working directory: ${show(prepared.cwd)}`);
	lines.push(prepared.repository
		? `Repository: ${show(prepared.repository.root)} at ${prepared.repository.head}, clean. Ignored files, PATH tools and user configuration remain trusted inputs.`
		: "Repository: none");
	lines.push("Declared folders (leased for coordination, not confinement):", ...prepared.writes.map((write) => `  ${show(write.path)} (${write.exists ? "exists" : "missing"})`));
	if (prepared.destructive.length) lines.push("Flagged destructive commands:", ...prepared.destructive.map((line) => `  ${safeDisplay(line)}`));
	lines.push(`Timeout: ${prepared.timeoutMs / 1000}s. Stdin is closed; nothing is retried.`, "", "Effects are not confined to these folders. Approving runs exactly this command once.");
	if (command.kind === "script") lines.push("", "--- script ---", displayLines(command.script));
	return lines.join("\n");
}

export function adminRunReceiptBase(prepared: PreparedAdminRun): Omit<AdminRunReceipt, "status"> {
	return {
		schemaVersion: "admin-run/v1",
		purpose: prepared.purpose,
		cwd: prepared.cwd,
		writes: prepared.writes.map((write) => write.path),
		...(prepared.command.kind === "script" ? { sha256: prepared.command.sha256 } : { argv: prepared.command.argv }),
	};
}

/** Rebinds everything shown in the confirmation; returns the first change, if any. */
export async function recheckAdminRun(prepared: PreparedAdminRun, dependencies: AdminRunDependencies = {}, signal?: AbortSignal): Promise<string | undefined> {
	try {
		if (await realpath(prepared.cwd) !== prepared.cwd) return "The working directory changed after confirmation";
		const declared = prepared.writes.map((write) => write.path);
		if (JSON.stringify(await resolveFolders(dependencies)(declared, prepared.cwd, signal)) !== JSON.stringify([...declared].sort())) return "A declared folder changed identity after confirmation";
		for (const write of prepared.writes) {
			if (await lstat(write.path).then(() => true, () => false) !== write.exists) return `Declared folder ${JSON.stringify(write.path)} appeared or disappeared after confirmation`;
		}
		if (JSON.stringify(await bindRepository(prepared.cwd, signal)) !== JSON.stringify(prepared.repository)) return "The working directory's repository changed after confirmation";
		const { command } = prepared;
		const program = command.kind === "script" ? "bash" : command.argv[0]!;
		const executable = await resolveExecutable(program, dependencies.env ?? process.env);
		if (executable !== (command.kind === "script" ? command.shell : command.executable)) return "The executable changed after confirmation";
		return undefined;
	} catch (error) {
		return `Recheck failed: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function interruptionReason(signal: AbortSignal): string {
	return typeof signal.reason === "string" ? signal.reason : "cancelled";
}

/** Runs one prepared command in its own process group with closed stdin; no retry. */
export function executeAdminRun(prepared: PreparedAdminRun, options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<AdminRunReceipt> {
	const base = adminRunReceiptBase(prepared);
	if (options.signal?.aborted) return Promise.resolve({ ...base, status: "interrupted", reason: `${interruptionReason(options.signal)}; nothing ran` });
	const { command } = prepared;
	const started = Date.now();
	return new Promise<AdminRunReceipt>((resolve) => {
		const child = spawn(
			command.kind === "script" ? command.shell : command.executable,
			command.kind === "script" ? ["--noprofile", "--norc", "-c", command.script, "run_admin"] : command.argv.slice(1),
			{
				cwd: prepared.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true,
				env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
				...(command.kind === "argv" ? { argv0: command.argv[0]! } : {}),
			},
		);
		let output = "", truncated = false, interruption: string | undefined, lingering = false, settled = false, closing = false;
		let killTimer: NodeJS.Timeout | undefined, lingerTimer: NodeJS.Timeout | undefined;
		const append = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.length > OUTPUT_LIMIT) { output = output.slice(-OUTPUT_LIMIT); truncated = true; }
		};
		const groupAlive = () => { try { process.kill(-child.pid!, 0); return true; } catch { return false; } };
		const killGroup = (signal: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, signal); } catch { /* Group already gone. */ } };
		const interrupt = (reason: string) => {
			if (interruption || settled || closing) return;
			interruption = reason;
			killGroup("SIGTERM");
			killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
		};
		const deadline = setTimeout(() => interrupt(`deadline of ${prepared.timeoutMs / 1000}s reached`), prepared.timeoutMs);
		const onAbort = () => interrupt(interruptionReason(options.signal!));
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (receipt: AdminRunReceipt) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline); clearTimeout(killTimer); clearTimeout(lingerTimer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve(receipt);
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.once("error", (error) => finish({ ...base, status: "failed", reason: `Could not start: ${error.message}`, durationMs: Date.now() - started }));
		// Members still holding the output pipes after the main process exits are terminated after a grace period.
		child.once("exit", () => { lingerTimer = setTimeout(() => { lingering = true; killGroup("SIGKILL"); }, KILL_GRACE_MS); });
		// Killing is asynchronous: resolve only once no member of the group remains (bounded).
		const groupGone = async () => {
			for (let waited = 0; groupAlive() && waited < KILL_GRACE_MS; waited += GROUP_EXIT_POLL_MS) await new Promise((done) => setTimeout(done, GROUP_EXIT_POLL_MS));
			return !groupAlive();
		};
		child.once("close", async (code, signal) => {
			closing = true;
			clearTimeout(lingerTimer);
			if (groupAlive()) { lingering = true; killGroup("SIGKILL"); }
			const gone = await groupGone();
			const shown = output.slice(-OUTPUT_TAIL);
			finish({
				...base,
				status: interruption ? "interrupted" : code === 0 ? "ok" : "failed",
				...(interruption ? { reason: interruption } : {}),
				exitCode: code, signal, durationMs: Date.now() - started,
				...(lingering ? { lingering: true } : {}),
				...(gone ? {} : { reason: `${interruption ? `${interruption}; ` : ""}process group members survived SIGKILL` }),
				output: displayLines(shown),
				outputTruncated: truncated || shown.length < output.length,
			});
		});
	});
}
