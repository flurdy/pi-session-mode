import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";

const CONFIG_NAME = "package-activation.json";
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 1024 * 1024;
const VERSION_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const PACKAGE_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GITHUB_REPOSITORY = /^github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const MANIFEST_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const MUTABLE_EXTENSION_PATH = /^extensions\/[A-Za-z0-9._-]+$/;

export interface PackageActivationRequest {
	package: string;
	version: string;
	expectedCommit: string;
}

export interface ActivationCommand {
	command: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface ActivationCommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface PackageActivationDependencies {
	agentDir: string;
	packageDir: string;
	run(command: ActivationCommand): Promise<ActivationCommandResult>;
	runInstaller(command: ActivationCommand): Promise<ActivationCommandResult>;
}

export interface PackageActivationLaunchOptions {
	signal?: AbortSignal;
	beforeLaunch?: () => void;
}

interface AllowlistedPackage {
	key: string;
	repository: string;
	manifestName: string;
	mutableExtensionPaths: string[];
}

interface ActivationSnapshot {
	allowlisted: AllowlistedPackage;
	cliPath: string;
	unrelatedSettingsRevision: string;
}

export interface PreparedPackageActivation {
	revision: string;
	display: {
		package: string;
		currentSource: string;
		requestedSource: string;
		currentCommit: string;
		expectedCommit: string;
		settingsPath: string;
		checkoutPath: string;
	};
	snapshot: ActivationSnapshot;
}

export interface PackageActivationEvidence {
	package: string;
	source: string;
	commit: string;
	version: string;
	verified: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatedRequest(value: PackageActivationRequest): Readonly<PackageActivationRequest> {
	if (!isRecord(value) || !PACKAGE_KEY.test(value.package)) throw new Error("Package key is invalid");
	if (!VERSION_TAG.test(value.version)) throw new Error("Expected a strict vX.Y.Z version tag");
	if (!COMMIT_SHA.test(value.expectedCommit)) throw new Error("Expected a lowercase full commit SHA");
	return Object.freeze({ package: value.package, version: value.version, expectedCommit: value.expectedCommit });
}

async function readJsonText(path: string, label: string): Promise<string> {
	const status = await requireRegularPath(path, label);
	if (!status.isFile()) throw new Error(`${label} is not a regular file`);
	if (status.size > MAX_JSON_BYTES) throw new Error(`${label} is too large`);
	const text = await readFile(path, "utf8");
	if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error(`${label} is too large`);
	return text;
}

function parseJsonRecord(text: string, label: string): Record<string, unknown> {
	let value: unknown;
	try { value = JSON.parse(text); }
	catch { throw new Error(`${label} is not valid JSON`); }
	if (!isRecord(value)) throw new Error(`${label} must contain an object`);
	return value;
}

function parseAllowlist(text: string, key: string): AllowlistedPackage {
	const config = parseJsonRecord(text, CONFIG_NAME);
	if (config.version !== 1 || !Array.isArray(config.packages) || config.packages.length < 1 || config.packages.length > 32) {
		throw new Error(`${CONFIG_NAME} has an unsupported schema`);
	}
	const parsed: AllowlistedPackage[] = config.packages.map((candidate) => {
		const repository = String(isRecord(candidate) ? candidate.repository ?? "" : "");
		if (!isRecord(candidate)
			|| !PACKAGE_KEY.test(String(candidate.key ?? ""))
			|| !GITHUB_REPOSITORY.test(repository)
			|| repository.split("/").some((segment) => segment === "." || segment === "..")
			|| !MANIFEST_NAME.test(String(candidate.manifestName ?? ""))
			|| !Array.isArray(candidate.mutableExtensionPaths)
			|| candidate.mutableExtensionPaths.length > 8
			|| !candidate.mutableExtensionPaths.every((path) => typeof path === "string" && MUTABLE_EXTENSION_PATH.test(path))) {
			throw new Error(`${CONFIG_NAME} contains an invalid package entry`);
		}
		return {
			key: candidate.key as string,
			repository: candidate.repository as string,
			manifestName: candidate.manifestName as string,
			mutableExtensionPaths: [...candidate.mutableExtensionPaths] as string[],
		};
	});
	if (new Set(parsed.map((entry) => entry.key)).size !== parsed.length
		|| new Set(parsed.map((entry) => entry.repository)).size !== parsed.length) {
		throw new Error(`${CONFIG_NAME} contains duplicate package authority`);
	}
	const selected = parsed.find((entry) => entry.key === key);
	if (!selected) throw new Error(`Package '${key}' is not allowlisted`);
	return selected;
}

function packageSource(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	return isRecord(entry) && typeof entry.source === "string" ? entry.source : undefined;
}

function sourceRef(source: string, repository: string): string | undefined {
	const [host, owner, repo] = repository.split("/").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	if (!host || !owner || !repo) return;
	const path = `${owner}/${repo}(?:\\.git)?`;
	const patterns = [
		new RegExp(`^git:${host}/${path}(?:[@#](.*))?$`, "i"),
		new RegExp(`^(?:git:)?https?://${host}/${path}(?:[@#](.*))?$`, "i"),
		new RegExp(`^git:git@${host}:${path}(?:[@#](.*))?$`, "i"),
		new RegExp(`^(?:git:)?ssh://git@${host}/${path}(?:[@#](.*))?$`, "i"),
		new RegExp(`^(?:git:)?git://${host}/${path}(?:[@#](.*))?$`, "i"),
	];
	for (const pattern of patterns) {
		const match = pattern.exec(source.trim());
		if (match) return match[1] ?? "";
	}
	return;
}

function sourceIdentity(source: string, repository: string): boolean {
	return sourceRef(source, repository) !== undefined;
}

function normalizedOriginMatches(origin: string, repository: string): boolean {
	const [host, owner, repo] = repository.split("/");
	if (!host || !owner || !repo) return false;
	const escapedHost = host.replaceAll(".", "\\.");
	const escapedOwner = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^(?:https?://${escapedHost}/${escapedOwner}/${escapedRepo}(?:\\.git)?|git@${escapedHost}:${escapedOwner}/${escapedRepo}(?:\\.git)?|ssh://git@${escapedHost}/${escapedOwner}/${escapedRepo}(?:\\.git)?)$`, "i").test(origin.trim());
}

async function command(dependencies: PackageActivationDependencies, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
	const result = await dependencies.run({ command: "git", args, cwd, env: activationEnvironment(cwd), ...(signal ? { signal } : {}), timeoutMs: COMMAND_TIMEOUT_MS });
	if (result.code !== 0) throw new Error(`Git verification failed with exit code ${result.code}`);
	return result.stdout;
}

async function requireRegularPath(path: string, label: string) {
	let status;
	try { status = await lstat(path); }
	catch { throw new Error(`${label} is unavailable`); }
	if (status.isSymbolicLink() || (!status.isFile() && !status.isDirectory())) throw new Error(`${label} has an unsupported filesystem identity`);
	return status;
}

async function resolveCheckout(agentDir: string, repository: string): Promise<string> {
	const canonicalAgentDir = await realpath(resolve(agentDir));
	const checkout = join(canonicalAgentDir, "git", ...repository.split("/"));
	await requireRegularPath(checkout, "Managed checkout");
	const canonicalCheckout = await realpath(checkout);
	const rel = relative(join(canonicalAgentDir, "git"), canonicalCheckout);
	if (canonicalCheckout !== checkout || rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error("Managed checkout path is not canonical");
	}
	return checkout;
}

async function resolvePiCli(packageDir: string): Promise<string> {
	const canonicalPackageDir = await realpath(resolve(packageDir));
	const manifest = parseJsonRecord(await readJsonText(join(canonicalPackageDir, "package.json"), "Pi package manifest"), "Pi package manifest");
	const bin = isRecord(manifest.bin) ? manifest.bin.pi : undefined;
	if (typeof bin !== "string" || bin.startsWith("/") || bin.split(/[\\/]/).includes("..")) throw new Error("Pi CLI path is invalid");
	const cliPath = join(canonicalPackageDir, bin);
	await requireRegularPath(cliPath, "Pi CLI");
	if (await realpath(cliPath) !== cliPath) throw new Error("Pi CLI path is not canonical");
	return cliPath;
}

function peeledTagCommit(output: string, version: string): string | undefined {
	const direct = `refs/tags/${version}`;
	const peeled = `${direct}^{}`;
	const rows = output.split("\n").map((line) => line.split("\t", 2)).filter((row) => row.length === 2);
	return rows.find((row) => row[1] === peeled)?.[0] ?? rows.find((row) => row[1] === direct)?.[0];
}

async function inspectLocalState(
	allowlisted: AllowlistedPackage,
	agentDir: string,
	dependencies: PackageActivationDependencies,
): Promise<{
	settingsPath: string;
	settingsText: string;
	settings: Record<string, unknown>;
	currentSource: string;
	checkoutPath: string;
	currentCommit: string;
}> {
	const settingsPath = join(agentDir, "settings.json");
	const settingsText = await readJsonText(settingsPath, "User settings");
	const settings = parseJsonRecord(settingsText, "User settings");
	if (!Array.isArray(settings.packages)) throw new Error("User settings packages are unavailable");
	const matches = settings.packages.map((entry) => packageSource(entry))
		.filter((source): source is string => source !== undefined && sourceIdentity(source, allowlisted.repository));
	if (matches.length !== 1) throw new Error("Expected exactly one installed user package with the allowlisted identity");
	const currentSource = matches[0]!;
	const currentVersion = sourceRef(currentSource, allowlisted.repository)!;
	if (!VERSION_TAG.test(currentVersion)) throw new Error("Installed package source is not pinned to a strict version tag");
	if (currentSource !== `git:${allowlisted.repository}@${currentVersion}`) throw new Error("Installed package source must use canonical GitHub shorthand with a strict version tag");
	const checkoutPath = await resolveCheckout(agentDir, allowlisted.repository);
	const dirty = await command(dependencies, ["-C", checkoutPath, "status", "--porcelain=v1", "--untracked-files=all"], agentDir);
	if (dirty.trim()) throw new Error("Managed checkout has uncommitted changes");
	const origin = await command(dependencies, ["-C", checkoutPath, "config", "--get", "remote.origin.url"], agentDir);
	if (!normalizedOriginMatches(origin, allowlisted.repository)) throw new Error("Managed checkout origin does not match the allowlist");
	const currentCommit = (await command(dependencies, ["-C", checkoutPath, "rev-parse", "HEAD"], agentDir)).trim();
	if (!COMMIT_SHA.test(currentCommit)) throw new Error("Managed checkout HEAD is invalid");
	const packageManifest = parseJsonRecord(await readJsonText(join(checkoutPath, "package.json"), "Managed package manifest"), "Managed package manifest");
	if (packageManifest.name !== allowlisted.manifestName || packageManifest.version !== currentVersion.slice(1)) {
		throw new Error("Managed package manifest does not match its configured source");
	}
	for (const configuredPath of allowlisted.mutableExtensionPaths) {
		try { await lstat(join(agentDir, ...configuredPath.split("/"))); throw new Error(`Mutable duplicate extension source is present: ${configuredPath}`); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	return { settingsPath, settingsText, settings, currentSource, checkoutPath, currentCommit };
}

export async function preparePackageActivation(
	input: PackageActivationRequest,
	dependencies: PackageActivationDependencies,
	signal?: AbortSignal,
): Promise<PreparedPackageActivation> {
	const request = validatedRequest(input);
	signal?.throwIfAborted();
	const agentDir = await realpath(resolve(dependencies.agentDir));
	const configPath = join(agentDir, CONFIG_NAME);
	const configStatus = await requireRegularPath(configPath, "Package activation allowlist");
	const uid = process.getuid?.();
	if (!configStatus.isFile() || configStatus.nlink !== 1 || (uid !== undefined && configStatus.uid !== uid) || (configStatus.mode & 0o022) !== 0) {
		throw new Error("Package activation allowlist ownership or permissions are unsafe");
	}
	const configText = await readJsonText(configPath, "Package activation allowlist");
	const allowlisted = parseAllowlist(configText, request.package);
	const local = await inspectLocalState(allowlisted, agentDir, dependencies);
	const remoteUrl = `https://${allowlisted.repository}.git`;
	const tagOutput = await command(dependencies, ["ls-remote", remoteUrl, `refs/tags/${request.version}`, `refs/tags/${request.version}^{}`], agentDir, signal);
	if (peeledTagCommit(tagOutput, request.version) !== request.expectedCommit) throw new Error("Requested tag does not resolve to the expected commit");
	const cliPath = await resolvePiCli(dependencies.packageDir);
	const requestedSource = `git:${allowlisted.repository}@${request.version}`;
	const revision = createHash("sha256").update(JSON.stringify({
		request,
		configText,
		settingsText: local.settingsText,
		currentSource: local.currentSource,
		currentCommit: local.currentCommit,
		checkoutPath: local.checkoutPath,
		cliPath,
		tagCommit: request.expectedCommit,
	})).digest("hex");
	return {
		revision,
		display: {
			package: request.package,
			currentSource: local.currentSource,
			requestedSource,
			currentCommit: local.currentCommit,
			expectedCommit: request.expectedCommit,
			settingsPath: local.settingsPath,
			checkoutPath: local.checkoutPath,
		},
		snapshot: {
			allowlisted,
			cliPath,
			unrelatedSettingsRevision: createHash("sha256").update(JSON.stringify(settingsWithoutTarget(local.settings, allowlisted.repository))).digest("hex"),
		},
	};
}

function settingsWithoutTarget(settings: Record<string, unknown>, repository: string): Record<string, unknown> {
	const copy = structuredClone(settings);
	if (Array.isArray(copy.packages)) copy.packages = copy.packages.filter((entry) => {
		const source = packageSource(entry);
		return source === undefined || !sourceIdentity(source, repository);
	});
	return copy;
}

function activationEnvironment(agentDir: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG(?:_|$))/.test(key)
			|| key === "GIT_ASKPASS" || key === "SSH_ASKPASS") delete env[key];
	}
	return {
		...env,
		PI_CODING_AGENT_DIR: agentDir,
		GIT_TERMINAL_PROMPT: "0",
		GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
		SSH_ASKPASS_REQUIRE: "never",
	};
}

export async function activatePreparedPackage(
	input: PackageActivationRequest,
	prepared: PreparedPackageActivation,
	dependencies: PackageActivationDependencies,
	options: PackageActivationLaunchOptions = {},
): Promise<PackageActivationEvidence> {
	const request = validatedRequest(input);
	const fresh = await preparePackageActivation(request, dependencies, options.signal);
	if (fresh.revision !== prepared.revision) throw new Error("Package activation evidence changed after confirmation");
	options.signal?.throwIfAborted();
	options.beforeLaunch?.();
	const agentDir = resolve(fresh.display.settingsPath, "..");
	const result = await dependencies.runInstaller({
		command: process.execPath,
		args: [fresh.snapshot.cliPath, "install", fresh.display.requestedSource],
		cwd: agentDir,
		env: activationEnvironment(agentDir),
	});
	if (result.code !== 0) throw new Error(`Pi package activation failed with exit code ${result.code}`);
	const after = await inspectLocalState(fresh.snapshot.allowlisted, agentDir, dependencies);
	if (after.currentSource !== fresh.display.requestedSource || after.currentCommit !== request.expectedCommit) {
		throw new Error("Pi package activation completed but the requested source and commit were not installed");
	}
	const unrelatedSettingsRevision = createHash("sha256").update(JSON.stringify(settingsWithoutTarget(after.settings, fresh.snapshot.allowlisted.repository))).digest("hex");
	if (unrelatedSettingsRevision !== fresh.snapshot.unrelatedSettingsRevision) {
		throw new Error("Pi package activation changed unrelated user settings or package entries");
	}
	return {
		package: request.package,
		source: after.currentSource,
		commit: after.currentCommit,
		version: request.version.slice(1),
		verified: true,
	};
}

function defaultRun(command: ActivationCommand): Promise<ActivationCommandResult> {
	return new Promise((done) => {
		execFile(command.command, command.args, {
			cwd: command.cwd,
			env: command.env,
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
			timeout: command.timeoutMs,
			windowsHide: true,
			...(command.signal ? { signal: command.signal } : {}),
		}, (error, stdout, stderr) => done({
			code: typeof error?.code === "number" ? error.code : error ? -1 : 0,
			stdout,
			stderr,
		}));
	});
}

function defaultRunInstaller(command: ActivationCommand): Promise<ActivationCommandResult> {
	return new Promise((done) => {
		let finished = false;
		const finish = (code: number) => {
			if (finished) return;
			finished = true;
			done({ code, stdout: "", stderr: "" });
		};
		const child = spawn(command.command, command.args, {
			cwd: command.cwd,
			env: command.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		child.stdout.resume();
		child.stderr.resume();
		child.once("error", () => finish(-1));
		child.once("close", (code) => finish(code ?? -1));
	});
}

export function defaultPackageActivationDependencies(): PackageActivationDependencies {
	return {
		agentDir: getAgentDir(),
		packageDir: getPackageDir(),
		run: defaultRun,
		runInstaller: defaultRunInstaller,
	};
}
