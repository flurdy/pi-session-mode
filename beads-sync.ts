import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { acquireFileLease, type FileLeaseResult } from "./lease.ts";

export const BEADS_SYNC_CONFIG_NAME = "beads-sync.json";
const MAX_BYTES = 1024 * 1024;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const COMMIT = /^[0-9a-v]{32}$/;
const SUPPORTED_SCHEMA = "1.2.2";
const MAX_DOLT_PATCH = 1;

export type BeadsSyncAction = "fetch" | "pull" | "push";
export interface BeadsSyncRequest { action: BeadsSyncAction; directory: string; remote: string; }
export interface BeadsSyncCommand {
	command: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	timeoutMs?: number;
}
export interface BeadsSyncCommandResult { code: number; stdout: string; stderr: string; }
export interface BeadsSyncDependencies {
	agentDir: string;
	env?: NodeJS.ProcessEnv;
	run(command: BeadsSyncCommand): Promise<BeadsSyncCommandResult>;
	resolveExecutable(command: "bd" | "dolt" | "git"): Promise<string>;
	readState?(path: string): Promise<string>;
	canonicalize(path: string): Promise<string>;
	acquireConfigLease(file: string, options: { sessionId: string; signal?: AbortSignal; expectedFile?: string }): Promise<FileLeaseResult>;
}
export interface BeadsSyncTrustDisplay {
	directory: string;
	beadsDir: string;
	databasePath: string;
	databaseName: string;
	mode: "embedded" | "server";
	remote: string;
	remoteUrl: string;
	remotePath: string;
	branch: string;
	bdPath: string;
	bdVersion: string;
	doltPath: string;
	doltVersion: string;
	schemaVersion: string;
	connectionRevision: string;
	connection: string;
	transportUrl: string;
	transportRevision: string;
}
type TrustEntry = BeadsSyncTrustDisplay;
interface TrustConfig { version: 1; stores: TrustEntry[]; }
export interface PreparedBeadsSyncTrust { revision: string; display: BeadsSyncTrustDisplay; entry: TrustEntry; }
export interface BeadsSyncOptions { sessionId: string; signal?: AbortSignal; beforeLaunch?: () => void; }
export interface BeadsSyncAdapter {
	inspectTrust(input: { directory: string; remote: string }, signal?: AbortSignal): Promise<PreparedBeadsSyncTrust>;
	persistTrust(prepared: PreparedBeadsSyncTrust, options: BeadsSyncOptions): Promise<void>;
	execute(input: BeadsSyncRequest, options: BeadsSyncOptions): Promise<BeadsSyncEvidence>;
}
export interface BeadsSyncEvidence {
	action: BeadsSyncAction;
	status: "fetched" | "pulled" | "pushed" | "up-to-date" | "skipped";
	directory: string;
	remote: string;
	branch: string;
	localAhead?: number;
	localBehind?: number;
	before?: string;
	after?: string;
	remoteHead?: string;
	reason?: string;
	verified: boolean;
}
interface StoreInspection { entry: TrustEntry; config: Map<string, string>; head: string; }
const ENTRY_FIELDS: readonly (keyof TrustEntry)[] = [
	"directory", "beadsDir", "databasePath", "databaseName", "mode", "remote", "remoteUrl", "remotePath", "branch",
	"bdPath", "bdVersion", "doltPath", "doltVersion", "schemaVersion", "connectionRevision", "connection", "transportUrl", "transportRevision",
];

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function parseJson(text: string, label: string): unknown {
	try { return JSON.parse(text); } catch { throw new Error(`${label} returned invalid JSON`); }
}
function revision(entry: TrustEntry): string { return createHash("sha256").update(JSON.stringify(ENTRY_FIELDS.map((key) => entry[key]))).digest("hex"); }
function booleanConfig(config: Map<string, string>, key: string): boolean {
	const value = config.get(key)?.toLowerCase();
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`Beads configuration '${key}' is unavailable or ambiguous`);
}
function environment(dependencies: BeadsSyncDependencies, beadsDir?: string): NodeJS.ProcessEnv {
	const env = { ...(dependencies.env ?? process.env) };
	for (const key of Object.keys(env)) {
		if (/^(?:BD|BEADS)_IGNORE_SCHEMA_SKEW$/.test(key) && env[key] && !["0", "false"].includes(env[key]!)) throw new Error("Schema-skew override is incompatible with routine sync");
		if (key === "BEADS_DIR" || key === "BEADS_DB" || key === "BD_DB" || key === "GIT_ASKPASS" || key === "SSH_ASKPASS"
			|| /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_)/.test(key)) delete env[key];
	}
	if (beadsDir) env.BEADS_DIR = beadsDir;
	return { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null", BD_NON_INTERACTIVE: "1", BD_NO_HOOKS: "true", BD_DOLT_AUTO_COMMIT: "off", GIT_TERMINAL_PROMPT: "0", SSH_ASKPASS_REQUIRE: "never", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" };
}
async function run(dependencies: BeadsSyncDependencies, label: string, value: BeadsSyncCommand): Promise<string> {
	value.signal?.throwIfAborted();
	const result = await dependencies.run(value);
	if (result.code !== 0) throw new Error(`${label} failed (exit ${result.code}); command output withheld because it may contain credentials`);
	return result.stdout;
}
function bdCommand(entry: Pick<TrustEntry, "directory" | "beadsDir" | "bdPath">, args: string[], dependencies: BeadsSyncDependencies, signal?: AbortSignal): BeadsSyncCommand {
	return { command: entry.bdPath, args: ["-C", entry.directory, ...args, "--sandbox", "--dolt-auto-commit=off"], cwd: entry.directory,
		env: environment(dependencies, entry.beadsDir), signal, timeoutMs: 60_000 };
}
async function bd(entry: Pick<TrustEntry, "directory" | "beadsDir" | "bdPath">, args: string[], label: string, dependencies: BeadsSyncDependencies, signal?: AbortSignal): Promise<string> {
	return run(dependencies, label, bdCommand(entry, args, dependencies, signal));
}
function supportedDoltVersion(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const match = /^2\.3\.(0|[1-9]\d*)$/.exec(value);
	return match !== null && Number(match[1]) <= MAX_DOLT_PATCH;
}
async function version(name: "bd" | "dolt", dependencies: BeadsSyncDependencies, signal?: AbortSignal): Promise<{ path: string; version: string }> {
	const path = await dependencies.resolveExecutable(name);
	const text = (await run(dependencies, `${name} version check`, { command: path, args: name === "bd" ? ["--version"] : ["version"], cwd: dependencies.agentDir, env: environment(dependencies), signal, timeoutMs: 5000 })).trim();
	const versionLines = text.split(/\r?\n/).filter((line) => line.startsWith(`${name} version `));
	if (versionLines.length !== 1 || !(name === "bd" ? /^bd version 1\.2\.2(?:\s|$)/.test(versionLines[0]!) : supportedDoltVersion(versionLines[0]!.slice("dolt version ".length)))) {
		throw new Error(`Unsupported ${name} version; routine sync requires Beads 1.2.2 and stable Dolt >=2.3.0 <=2.3.${MAX_DOLT_PATCH}, with live capability checks`);
	}
	return { path, version: versionLines[0]! };
}
function configMap(value: unknown): Map<string, string> {
	if (!Array.isArray(value)) throw new Error("Beads configuration output is malformed");
	const config = new Map<string, string>();
	for (const row of value) {
		if (!record(row) || typeof row.key !== "string" || !["string", "boolean", "number"].includes(typeof row.value) || config.has(row.key)) throw new Error("Beads configuration output is malformed");
		config.set(row.key, String(row.value));
	}
	return config;
}
function checkedUrl(text: unknown): URL {
	if (typeof text !== "string" || text.length > 4096 || /[\u0000-\u0020\u007f-\u009f]/.test(text)) throw new Error("Invalid remote URL");
	let url: URL;
	try { url = new URL(text); } catch { throw new Error("Remote URL needs an explicit supported protocol"); }
	if (!["file:", "https:", "http:", "git+ssh:", "git+https:", "ssh:"].includes(url.protocol) || url.password || url.search || url.hash
		|| (url.username && !["git+ssh:", "ssh:"].includes(url.protocol))) throw new Error("Remote URL contains credentials, overrides or an unsupported protocol");
	return url;
}
async function inspectStore(input: { directory: string; remote: string }, dependencies: BeadsSyncDependencies, signal?: AbortSignal): Promise<StoreInspection> {
	signal?.throwIfAborted();
	if (!REMOTE_NAME.test(input.remote) || !input.directory || input.directory.includes("\0")) throw new Error("Invalid store or remote selector");
	const directory = await dependencies.canonicalize(input.directory);
	const beadsDir = await dependencies.canonicalize(join(directory, ".beads"));
	if (beadsDir !== join(directory, ".beads")) throw new Error("Redirected Beads directories require separate review");
	const bdVersion = await version("bd", dependencies, signal);
	const doltVersion = await version("dolt", dependencies, signal);
	const base = { directory, beadsDir, bdPath: bdVersion.path };
	const where = parseJson(await bd(base, ["where", "--json", "--readonly"], "Store discovery", dependencies, signal), "Store discovery");
	if (!record(where) || where.path !== beadsDir || typeof where.database_path !== "string" || !isAbsolute(where.database_path)) throw new Error("Requested directory does not own the resolved Beads store");
	const databasePath = await dependencies.canonicalize(where.database_path);
	const config = configMap(parseJson(await bd(base, ["config", "show", "--json", "--readonly"], "Configuration inspection", dependencies, signal), "Configuration inspection"));
	const mode = config.get("dolt_mode"), databaseName = config.get("dolt_database");
	if ((mode !== "embedded" && mode !== "server") || !databaseName || !REMOTE_NAME.test(databaseName)) throw new Error("Unsupported Beads database configuration");
	if (databasePath !== join(beadsDir, mode === "embedded" ? "embeddeddolt" : "dolt")) throw new Error("Redirected database storage requires separate review");
	const remotes = parseJson(await bd(base, ["dolt", "remote", "list", "--json", "--readonly"], "Remote inspection", dependencies, signal), "Remote inspection");
	if (!Array.isArray(remotes)) throw new Error("Remote inspection output is malformed");
	const matches = remotes.filter((row) => record(row) && row.name === input.remote);
	if (matches.length !== 1 || !record(matches[0])) throw new Error("The requested Dolt remote is not configured exactly once");
	const remoteUrl = matches[0].url as string;
	const url = checkedUrl(remoteUrl);
	const remotePath = url.protocol === "file:" ? await dependencies.canonicalize(fileURLToPath(url)) : "";
	const status = parseJson(await bd(base, ["vc", "status", "--json", "--readonly"], "Branch inspection", dependencies, signal), "Branch inspection");
	if (!record(status) || typeof status.branch !== "string" || !BRANCH.test(status.branch) || typeof status.commit !== "string" || !COMMIT.test(status.commit)) throw new Error("Branch inspection output is malformed");
	const migration = await bd(base, ["migrate", "--dry-run", "--readonly"], "Schema inspection", dependencies, signal);
	if (!/^Dolt database version: 1\.2\.2\s*$/m.test(migration) || !/Version matches/.test(migration) || !/All metadata fields present/.test(migration)) throw new Error("Beads schema metadata needs maintenance before routine sync");
	const statePath = join(databasePath, databaseName, ".dolt", "repo_state.json");
	if (await dependencies.canonicalize(statePath) !== statePath) throw new Error("Redirected Dolt CLI state requires separate review");
	const stateText = dependencies.readState ? await dependencies.readState(statePath) : await readFile(statePath, "utf8");
	if (Buffer.byteLength(stateText) > MAX_BYTES) throw new Error("Dolt CLI state is too large");
	const state = parseJson(stateText, "Dolt CLI state");
	const cliRemote = record(state) && record(state.remotes) ? state.remotes[input.remote] : undefined;
	if (!record(state) || state.head !== `refs/heads/${status.branch}` || !record(cliRemote) || cliRemote.url !== remoteUrl) throw new Error("SQL and CLI Dolt remote/branch identities disagree; automatic remote repair is not permitted");
	let transportUrl = remoteUrl;
	if (url.protocol.startsWith("git+")) {
		transportUrl = (await run(dependencies, "Git transport URL inspection", {
			command: await dependencies.resolveExecutable("git"), args: ["-C", directory, "ls-remote", "--get-url", remoteUrl.replace(/^git\+/, "")],
			cwd: directory, env: environment(dependencies, beadsDir), signal, timeoutMs: 5000,
		})).trim();
		checkedUrl(transportUrl);
	}
	const connectionSettings = [...config].filter(([key]) => /^dolt[_.-]/.test(key) && !/password|token|secret/i.test(key)).sort(([a], [b]) => a.localeCompare(b));
	let connection = `embedded:${databasePath}/${databaseName}`;
	if (mode === "server") {
		const endpoint = parseJson(await bd(base, ["dolt", "show", "--json", "--readonly"], "Dolt endpoint inspection", dependencies, signal), "Dolt endpoint inspection");
		if (!record(endpoint) || endpoint.connection_ok !== true || endpoint.embedded !== false || endpoint.database !== databaseName
			|| typeof endpoint.host !== "string" || !/^[A-Za-z0-9._:-]+$/.test(endpoint.host)
			|| !Number.isSafeInteger(endpoint.port) || Number(endpoint.port) < 1 || Number(endpoint.port) > 65535
			|| typeof endpoint.user !== "string" || !/^[A-Za-z0-9_.@-]+$/.test(endpoint.user)) throw new Error("Dolt server endpoint is unavailable or unsupported");
		connection = JSON.stringify({ host: endpoint.host, port: endpoint.port, database: databaseName, user: endpoint.user });
	}
	const entry: TrustEntry = { ...base, databasePath, databaseName, mode, remote: input.remote, remoteUrl, remotePath, branch: status.branch,
		bdVersion: bdVersion.version, doltPath: doltVersion.path, doltVersion: doltVersion.version, schemaVersion: SUPPORTED_SCHEMA,
		connectionRevision: createHash("sha256").update(JSON.stringify(connectionSettings)).digest("hex"), connection, transportUrl,
		transportRevision: createHash("sha256").update(JSON.stringify(cliRemote)).digest("hex") };
	await probeCapabilities(entry, status.commit, dependencies, signal);
	return { entry, config, head: status.commit };
}
export async function inspectBeadsSyncTrust(input: { directory: string; remote: string }, dependencies: BeadsSyncDependencies, signal?: AbortSignal): Promise<PreparedBeadsSyncTrust> {
	const { entry } = await inspectStore(input, dependencies, signal);
	return { revision: revision(entry), display: { ...entry }, entry };
}
async function configPath(dependencies: BeadsSyncDependencies): Promise<string> { return join(await dependencies.canonicalize(dependencies.agentDir), BEADS_SYNC_CONFIG_NAME); }
async function readTrustConfig(path: string, missingAllowed = false): Promise<TrustConfig> {
	let status;
	try { status = await lstat(path); } catch (error) {
		if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, stores: [] };
		throw new Error("Beads sync trust is not configured");
	}
	if (!status.isFile() || status.nlink !== 1 || status.uid !== process.getuid?.() || (status.mode & 0o077) !== 0) throw new Error("Beads sync trust ownership or permissions are unsafe");
	if (status.size > MAX_BYTES) throw new Error("Beads sync trust file is too large");
	const text = await readFile(path, "utf8");
	if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Beads sync trust file is too large");
	const value = parseJson(text, "Trust file");
	if (!record(value) || value.version !== 1 || !Array.isArray(value.stores) || value.stores.length > 32) throw new Error("Beads sync trust file has an unsupported schema");
	const stores = value.stores.map((row): TrustEntry => {
		if (!record(row) || Object.keys(row).length !== ENTRY_FIELDS.length || ENTRY_FIELDS.some((key) => typeof row[key] !== "string" || (key !== "remotePath" && !row[key]))) throw new Error("Beads sync trust entry is invalid");
		return Object.fromEntries(ENTRY_FIELDS.map((key) => [key, row[key]])) as unknown as TrustEntry;
	});
	if (new Set(stores.map((entry) => `${entry.directory}\0${entry.remote}`)).size !== stores.length) throw new Error("Duplicate Beads sync authority");
	return { version: 1, stores };
}
async function configLease(dependencies: BeadsSyncDependencies, options: BeadsSyncOptions): Promise<Extract<FileLeaseResult, { kind: "held" }>> {
	options.signal?.throwIfAborted();
	const path = await configPath(dependencies);
	const result = await dependencies.acquireConfigLease(path, { sessionId: options.sessionId, expectedFile: path, signal: options.signal });
	if (result.kind === "contended") throw new Error("Another Beads sync or trust update is running");
	if (result.kind !== "held") throw new Error(`Beads sync trust lock is unavailable (${result.reason})`);
	return result;
}
function live(lease: Extract<FileLeaseResult, { kind: "held" }>, options: BeadsSyncOptions): void {
	options.signal?.throwIfAborted();
	options.beforeLaunch?.();
	if (!lease.alive) throw new Error("Beads sync trust lock was lost");
}
export async function persistBeadsSyncTrust(prepared: PreparedBeadsSyncTrust, dependencies: BeadsSyncDependencies, options: BeadsSyncOptions): Promise<void> {
	const lease = await configLease(dependencies, options);
	const temporary = join(dependencies.agentDir, `.${BEADS_SYNC_CONFIG_NAME}.${randomUUID()}.tmp`);
	try {
		live(lease, options);
		const guarded = { ...dependencies, run: async (value: BeadsSyncCommand) => { live(lease, options); return dependencies.run(value); } };
		const fresh = await inspectBeadsSyncTrust(prepared.entry, guarded, options.signal);
		if (fresh.revision !== prepared.revision) throw new Error("Beads sync trust evidence changed after confirmation");
		const path = await configPath(dependencies);
		const config = await readTrustConfig(path, true);
		const stores = config.stores.filter((entry) => entry.directory !== fresh.entry.directory || entry.remote !== fresh.entry.remote);
		stores.push(fresh.entry);
		if (stores.length > 32) throw new Error("Beads sync trust limit is 32 entries");
		const text = `${JSON.stringify({ version: 1, stores }, null, 2)}\n`;
		if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Beads sync trust file is too large");
		live(lease, options);
		await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
		live(lease, options);
		await rename(temporary, path);
	} finally { try { await rm(temporary, { force: true }); } finally { await lease.release(); } }
}
async function sql(entry: TrustEntry, query: string, dependencies: BeadsSyncDependencies, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
	const text = entry.mode === "server"
		? await bd(entry, ["sql", query, "--json", "--readonly"], "Dolt SQL inspection", dependencies, signal)
		: await run(dependencies, "Dolt SQL inspection", { command: entry.doltPath,
			args: ["--data-dir", entry.databasePath, "--use-db", entry.databaseName, "sql", "--disable-auto-gc", "-r", "json", "-q", query],
			cwd: entry.directory, env: environment(dependencies, entry.beadsDir), signal, timeoutMs: 60_000 });
	const parsed = parseJson(text, "Dolt SQL inspection");
	const rows = record(parsed) ? parsed.rows : parsed;
	if (!Array.isArray(rows) || !rows.every(record)) throw new Error("Dolt SQL returned an unsupported result");
	return rows;
}
async function oneRow(entry: TrustEntry, query: string, dependencies: BeadsSyncDependencies, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const rows = await sql(entry, query, dependencies, signal);
	if (rows.length !== 1) throw new Error("Dolt inspection did not return one evidence row");
	return rows[0]!;
}
async function probeCapabilities(entry: TrustEntry, head: string, dependencies: BeadsSyncDependencies, signal?: AbortSignal): Promise<void> {
	const fetchHelp = await run(dependencies, "Dolt fetch capability", { command: entry.doltPath, args: ["fetch", "--help"],
		cwd: entry.directory, env: environment(dependencies, entry.beadsDir), signal, timeoutMs: 5000 });
	if (!/dolt fetch\s+\[<remote>\]\s+\[<refspec> \.\.\.\]/.test(fetchHelp)) throw new Error("Dolt fetch refspec capability is unavailable");
	for (const [args, syntax, flag] of [
		[["vc", "merge", "--help"], /bd vc merge <branch> \[flags\]/, "--json"],
		[["dolt", "push", "--help"], /bd dolt push \[flags\]/, "--remote"],
	] as const) {
		const help = await bd(entry, [...args], "Beads command capability", dependencies, signal);
		if (!syntax.test(help) || [flag, "--sandbox", "--dolt-auto-commit"].some((option) => !new RegExp(`${option}(?=[\\s=]|$)`).test(help))) {
			throw new Error("Required Beads command capability is unavailable");
		}
	}
	const row = await oneRow(entry, `SELECT DOLT_VERSION() AS version, DOLT_HASHOF('HEAD') AS head,
DOLT_MERGE_BASE('${head}', '${head}') AS base,
(SELECT COUNT(*) FROM dolt_schema_diff('${head}', '${head}')) AS schema_changes,
(SELECT COUNT(*) FROM dolt_diff('${head}', '${head}', 'schema_migrations')) AS migrations,
(SELECT COUNT(*) FROM DOLT_PREVIEW_MERGE_CONFLICTS_SUMMARY('${head}', '${head}')) AS conflicts /*capabilities*/`, dependencies, signal);
	if (!supportedDoltVersion(row.version) || row.head !== head || row.base !== head || row.schema_changes !== 0 || row.migrations !== 0 || row.conflicts !== 0) {
		throw new Error("Dolt SQL capabilities returned incompatible evidence");
	}
}
async function workingHead(entry: TrustEntry, dependencies: BeadsSyncDependencies, signal?: AbortSignal): Promise<string> {
	const state = await oneRow(entry, `SELECT active_branch() AS branch, DOLT_HASHOF('HEAD') AS head,
(SELECT COUNT(*) FROM dolt_status) AS dirty,
(SELECT COUNT(*) FROM dolt_conflicts) AS conflicts,
(SELECT COUNT(*) FROM dolt_schema_conflicts) AS schema_conflicts,
(SELECT COUNT(*) FROM dolt_constraint_violations) AS violations,
(SELECT COUNT(*) FROM dolt_merge_status WHERE is_merging = true) AS merging,
(SELECT MAX(version) FROM schema_migrations) AS schema_version,
(SELECT COUNT(*) FROM schema_migrations) AS schema_count /*working*/`, dependencies, signal);
	if (state.branch !== entry.branch || typeof state.head !== "string" || !COMMIT.test(state.head)) throw new Error("Dolt branch identity changed or is uncertain");
	for (const key of ["dirty", "conflicts", "schema_conflicts", "violations", "merging"]) if (state[key] !== 0) throw new Error("Pending local changes, conflicts or uncertain working state prevent routine sync");
	if (state.schema_version !== 53 || state.schema_count !== 53) throw new Error("Schema migration state is incompatible with Beads 1.2.2");
	return state.head;
}
async function remoteHead(entry: TrustEntry, dependencies: BeadsSyncDependencies, signal?: AbortSignal): Promise<string> {
	const row = await oneRow(entry, `SELECT DOLT_HASHOF('${entry.remote}/${entry.branch}') AS hash /*remote*/`, dependencies, signal);
	if (typeof row.hash !== "string" || !COMMIT.test(row.hash)) throw new Error("Fetched remote commit is unavailable");
	return row.hash;
}
async function mergeBase(entry: TrustEntry, a: string, b: string, dependencies: BeadsSyncDependencies, signal?: AbortSignal): Promise<string> {
	const row = await oneRow(entry, `SELECT DOLT_MERGE_BASE('${a}', '${b}') AS base /*ancestry*/`, dependencies, signal);
	if (typeof row.base !== "string" || !COMMIT.test(row.base)) throw new Error("History is unrelated or uncertain");
	return row.base;
}
async function preview(entry: TrustEntry, local: string, remote: string, dependencies: BeadsSyncDependencies, signal?: AbortSignal): Promise<void> {
	for (const [label, source] of [
		["schema", `dolt_schema_diff('${local}', '${remote}')`],
		["migrations", `dolt_diff('${local}', '${remote}', 'schema_migrations')`],
		["preview", `DOLT_PREVIEW_MERGE_CONFLICTS_SUMMARY('${local}', '${remote}')`],
	]) {
		const row = await oneRow(entry, `SELECT COUNT(*) AS count FROM ${source} /*${label}*/`, dependencies, signal);
		if (row.count !== 0) throw new Error("Schema drift or prospective merge conflicts prevent routine pull");
	}
}
function safeConfig(config: Map<string, string>): void {
	for (const key of ["backup.enabled", "backup.git-push", "export.auto", "export.git-add", "events-export"]) {
		if (booleanConfig(config, key)) throw new Error(`Automatic ${key} side effects require separate review`);
	}
	if (!booleanConfig(config, "no-hooks") || config.get("dolt.auto-commit") !== "off") throw new Error("Beads hooks or auto-commit suppression could not be verified");
}
async function fetchRemote(entry: TrustEntry, dependencies: BeadsSyncDependencies, signal?: AbortSignal): Promise<void> {
	await run(dependencies, "Dolt fetch", { command: entry.doltPath,
		args: ["fetch", entry.remote, `refs/heads/${entry.branch}:refs/remotes/${entry.remote}/${entry.branch}`],
		cwd: join(entry.databasePath, entry.databaseName), env: environment(dependencies, entry.beadsDir), signal, timeoutMs: 60_000 });
}
export async function executeBeadsSync(input: BeadsSyncRequest, dependencies: BeadsSyncDependencies, options: BeadsSyncOptions): Promise<BeadsSyncEvidence> {
	if (!record(input) || !["fetch", "pull", "push"].includes(input.action) || typeof input.directory !== "string" || !REMOTE_NAME.test(input.remote)) throw new Error("Invalid Beads sync request");
	options.signal?.throwIfAborted(); options.beforeLaunch?.();
	const path = await configPath(dependencies), directory = await dependencies.canonicalize(input.directory);
	const expected = (await readTrustConfig(path)).stores.find((entry) => entry.directory === directory && entry.remote === input.remote);
	if (!expected) throw new Error("This store and remote are not trusted");
	const lease = await configLease(dependencies, options);
	let phase = "preflight";
	try {
		const authority = async () => {
			live(lease, options);
			const binding = (await readTrustConfig(path)).stores.find((entry) => entry.directory === directory && entry.remote === input.remote);
			if (!binding || revision(binding) !== revision(expected)) throw new Error("Beads sync trust was revoked or changed");
			live(lease, options);
		};
		const guarded: BeadsSyncDependencies = { ...dependencies, run: async (value) => {
			await authority();
			const result = await dependencies.run(value);
			await authority();
			return result;
		} };
		const revalidate = async (head?: string) => {
			const inspected = await inspectStore(input, guarded, options.signal);
			if (revision(inspected.entry) !== revision(expected)) throw new Error("Store, destination, branch, schema or executable evidence changed after enrollment");
			safeConfig(inspected.config);
			const actual = await workingHead(expected, guarded, options.signal);
			if (actual !== inspected.head || (head !== undefined && actual !== head)) throw new Error("Local Dolt history changed during synchronization");
			return { head: actual, config: inspected.config };
		};
		const initial = await revalidate();
		const evidence = { action: input.action, directory, remote: input.remote, branch: expected.branch, before: initial.head };
		if (input.action === "push" && booleanConfig(initial.config, "no-push")) return { ...evidence, status: "skipped", reason: "no-push is enabled", verified: false };
		phase = "fetch";
		await fetchRemote(expected, guarded, options.signal);
		await revalidate(initial.head);
		const fetchedHead = await remoteHead(expected, guarded, options.signal);
		if (input.action === "fetch") return { ...evidence, status: "fetched", after: initial.head, remoteHead: fetchedHead, verified: true };
		const base = await mergeBase(expected, initial.head, fetchedHead, guarded, options.signal);
		if (input.action === "push") {
			if (base !== fetchedHead) throw new Error("Remote is ahead or diverged; non-force push refused");
			if (initial.head === fetchedHead) return { ...evidence, status: "up-to-date", after: initial.head, remoteHead: fetchedHead, verified: true };
			const fresh = await revalidate(initial.head);
			if (booleanConfig(fresh.config, "no-push")) return { ...evidence, status: "skipped", reason: "no-push became enabled", verified: false };
			phase = "push (remote state may have changed)";
			const output = await bd(expected, ["dolt", "push", "--remote", input.remote], "Beads push", guarded, options.signal);
			if (/skipping push/i.test(output)) return { ...evidence, status: "skipped", reason: "Beads declined the push", verified: false };
			phase = "push verification (push was attempted)";
			await revalidate(initial.head);
			await fetchRemote(expected, guarded, options.signal);
			await revalidate(initial.head);
			const remote = await remoteHead(expected, guarded, options.signal);
			if (remote !== initial.head) throw new Error("Remote commit does not equal the intended pushed commit");
			return { ...evidence, status: "pushed", after: initial.head, remoteHead: remote, localAhead: 0, localBehind: 0, verified: true };
		}
		if (base === fetchedHead) return { ...evidence, status: "up-to-date", after: initial.head, remoteHead: fetchedHead, verified: true };
		phase = "pull preview (fetch completed; merge not attempted)";
		await preview(expected, initial.head, fetchedHead, guarded, options.signal);
		await revalidate(initial.head);
		phase = "merge (local state may have changed)";
		const merged = parseJson(await bd(expected, ["vc", "merge", fetchedHead, "--json"], "Beads pull merge", guarded, options.signal), "Beads pull merge");
		if (!record(merged) || merged.conflicts !== 0 || merged.merged !== fetchedHead) throw new Error("Beads merge did not report a conflict-free result");
		phase = "pull verification (merge was attempted)";
		const after = (await revalidate()).head;
		if (await mergeBase(expected, after, fetchedHead, guarded, options.signal) !== fetchedHead || await mergeBase(expected, after, initial.head, guarded, options.signal) !== initial.head) throw new Error("Merge ancestry did not preserve both commits");
		return { ...evidence, status: "pulled", after, remoteHead: fetchedHead, verified: true };
	} catch (error) {
		throw new Error(`Beads sync stopped during ${phase}: ${error instanceof Error ? error.message : "unknown failure"}. Inspect state before retrying; no automatic recovery ran.`);
	} finally { await lease.release(); }
}
async function findExecutable(name: string): Promise<string> {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!isAbsolute(directory)) continue;
		const path = join(directory, name);
		try { await access(path, constants.X_OK); return await realpath(path); } catch { /* Try the next absolute PATH entry. */ }
	}
	throw new Error(`Required executable '${name}' is unavailable`);
}
function defaultRun(value: BeadsSyncCommand): Promise<BeadsSyncCommandResult> {
	value.signal?.throwIfAborted();
	return new Promise((done) => {
		const child = execFile(value.command, value.args, { cwd: value.cwd, env: value.env, encoding: "utf8", maxBuffer: MAX_BYTES,
			timeout: value.timeoutMs, windowsHide: true, signal: value.signal }, (error, stdout, stderr) => {
			done({ code: typeof error?.code === "number" ? error.code : error ? -1 : 0, stdout, stderr });
		});
		child.stdin?.end();
	});
}
export function defaultBeadsSyncDependencies(): BeadsSyncDependencies {
	return { agentDir: getAgentDir(), run: defaultRun, resolveExecutable: findExecutable, canonicalize: realpath, acquireConfigLease: acquireFileLease };
}
export function createBeadsSyncAdapter(dependencies: BeadsSyncDependencies = defaultBeadsSyncDependencies()): BeadsSyncAdapter {
	return { inspectTrust: (input, signal) => inspectBeadsSyncTrust(input, dependencies, signal), persistTrust: (prepared, options) => persistBeadsSyncTrust(prepared, dependencies, options), execute: (input, options) => executeBeadsSync(input, dependencies, options) };
}
