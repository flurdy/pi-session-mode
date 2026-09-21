import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import type { FileLeaseResult } from "./lease.ts";
import {
	BEADS_SYNC_CONFIG_NAME,
	executeBeadsSync,
	inspectBeadsSyncTrust,
	persistBeadsSyncTrust,
	type BeadsSyncCommand,
	type BeadsSyncDependencies,
} from "./beads-sync.ts";

interface FixtureOptions {
	doltVersion?: string;
	bdVersion?: string;
	capabilities?: Record<string, unknown>;
	help?: Partial<Record<"fetch" | "merge" | "push", string>>;
	mode?: "embedded" | "server";
	remoteUrl?: string;
	transportUrl?: string;
	pending?: number;
	ahead?: number;
	behind?: number;
	config?: Record<string, string>;
	queryRows?: Record<string, readonly unknown[]>;
	changeDuringEnrollment?: boolean;
	changedRemoteUrl?: string;
	pushOutput?: string;
	fail?: RegExp;
	onCommand?: (command: BeadsSyncCommand) => Promise<void> | void;
}

const DIRECTORY = "/store";
const BEADS_DIR = "/store/.beads";
const DATABASE_PATH = "/store/.beads/embeddeddolt";
const REMOTE_URL = "file:///trusted/remote";
const LOCAL_HEAD = "a".repeat(32);
const REMOTE_HEAD = "b".repeat(32);
const BD_PATH = "/opt/bin/bd";
const DOLT_PATH = "/opt/bin/dolt";
const fixtureDirs: string[] = [];
after(async () => { for (const path of fixtureDirs) await rm(path, { recursive: true, force: true }); });
const SAFETY_FLAGS = ["--sandbox", "--dolt-auto-commit=off"];

function result(stdout: string, code = 0) { return { code, stdout, stderr: code ? "fixture failure" : "" }; }
function json(value: unknown) { return result(`${JSON.stringify(value)}\n`); }
function isOperation(command: BeadsSyncCommand, name: string): boolean { return command.args.includes(name) && !command.args.includes("--help"); }
function isFetch(command: BeadsSyncCommand): boolean { return command.command === DOLT_PATH && isOperation(command, "fetch"); }
function commandKey(command: BeadsSyncCommand): string { return `${command.command} ${command.args.join(" ")}`; }

async function fixture(options: FixtureOptions = {}) {
	const agentDir = await mkdtemp(join(tmpdir(), "beads-sync-test-"));
	fixtureDirs.push(agentDir);
	const commands: BeadsSyncCommand[] = [];
	let remoteListReads = 0;
	let merged = false;
	let pushed = false;
	const mode = options.mode ?? "embedded";
	const baseConfig: Record<string, string> = {
		"backup.enabled": "false",
		"backup.git-push": "false",
		"events-export": "false",
		"no-hooks": "true",
		"dolt.auto-commit": "off",
		"dolt_database": "beads",
		"dolt_mode": mode,
		"export.auto": "false",
		"export.git-add": "false",
		"no-push": "false",
		...options.config,
	};
	const configRows = () => Object.entries(baseConfig).map(([key, value]) => ({ key, value, source: "fixture" }));
	const queryRows: Record<string, readonly unknown[]> = {
		guard: [],
		preview: [], schema: [], working: [], conflicts: [], constraints: [], merge: [{ is_merging: false }],
		...options.queryRows,
	};
	const run = async (command: BeadsSyncCommand) => {
		commands.push(command);
		await options.onCommand?.(command);
		const key = commandKey(command);
		if (options.fail?.test(key)) return result("", 1);
		if (key === `${BD_PATH} --version`) return result(`bd version ${options.bdVersion ?? "1.2.2"} (fixture)\n`);
		if (key === `${DOLT_PATH} version`) return result(`dolt version ${options.doltVersion ?? "2.3.1"}\n`);
		if (command.args.includes("--help")) {
			if (command.command === DOLT_PATH && command.args.includes("fetch")) return result(options.help?.fetch ?? "dolt fetch [<remote>] [<refspec> ...]\n");
			if (command.args.includes("merge")) return result(options.help?.merge ?? "bd vc merge <branch> [flags]\n--json --sandbox --dolt-auto-commit\n");
			if (command.args.includes("push")) return result(options.help?.push ?? "bd dolt push [flags]\n--remote --sandbox --dolt-auto-commit\n");
		}
		if (key.includes("/*capabilities*/")) return json({ rows: [{ version: options.doltVersion ?? "2.3.1", head: merged ? REMOTE_HEAD : LOCAL_HEAD, base: merged ? REMOTE_HEAD : LOCAL_HEAD, schema_changes: 0, migrations: 0, conflicts: 0, ...options.capabilities }] });
		if (command.command === "/opt/bin/git" && command.args.includes("--get-url")) return result(`${options.transportUrl ?? options.remoteUrl?.replace(/^git\+/, "")}\n`);
		if (key.includes(" where --json --readonly")) return json({ database_path: mode === "embedded" ? DATABASE_PATH : "/store/.beads/dolt", path: BEADS_DIR, prefix: "beads", schema_version: 1 });
		if (key.includes(" dolt remote list --json --readonly")) {
			remoteListReads++;
			const changed = options.changedRemoteUrl && (options.changeDuringEnrollment ? remoteListReads > 1 : remoteListReads > 2);
			return json([{ name: "origin", url: changed ? options.changedRemoteUrl : options.remoteUrl ?? REMOTE_URL, status: "ok" }]);
		}
		if (key.includes(" dolt show --json --readonly")) return json({ connection_ok: true, embedded: false, host: "127.0.0.1", port: 3307, database: "beads", user: "root" });
		if (key.includes(" vc status --json --readonly")) return json({ branch: "main", commit: merged ? REMOTE_HEAD : LOCAL_HEAD, schema_version: 1 });
		if (key.includes(" config show --json --readonly")) return json(configRows());
		if (key.includes(" migrate --dry-run --readonly")) return result("Dolt database version: 1.2.2\n✓ Version matches\n✓ All metadata fields present\n");
		if (isFetch(command)) return result("");
		if (key.includes(" dolt push --remote origin")) { pushed = true; return result(options.pushOutput ?? "Pushing to Dolt remote \"origin\"...\nPush complete.\n"); }
		if (key.includes(` vc merge ${REMOTE_HEAD} --json`)) { merged = true; return json({ merged: REMOTE_HEAD, conflicts: 0 }); }
		if (key.includes("/*working*/")) return json({ rows: [{ branch: "main", head: merged ? REMOTE_HEAD : LOCAL_HEAD, dirty: queryRows.working.length + (options.pending ?? 0),
			conflicts: queryRows.conflicts.length, schema_conflicts: 0, violations: queryRows.constraints.length, merging: 0, schema_version: 53, schema_count: 53 }] });
		if (key.includes("/*remote*/")) return json({ rows: [{ hash: pushed ? LOCAL_HEAD : options.behind === 0 ? "c".repeat(32) : REMOTE_HEAD }] });
		if (key.includes("/*ancestry*/")) {
			const hashes = [...key.matchAll(/'([0-9a-v]{32})'/g)].map((match) => match[1]);
			return json({ rows: [{ base: merged || pushed || options.behind === 0 ? hashes[1] : options.ahead ? "c".repeat(32) : LOCAL_HEAD }] });
		}
		if (key.includes("/*migrations*/")) return json({ rows: [{ count: 0 }] });
		for (const name of ["schema", "preview"]) if (key.includes(`/*${name}*/`)) return json({ rows: [{ count: queryRows[name]!.length }] });
		throw new Error(`Unexpected fixture command: ${key}`);
	};
	const held: Extract<FileLeaseResult, { kind: "held" }> = {
		kind: "held", file: join(agentDir, BEADS_SYNC_CONFIG_NAME), holderPid: 1,
		alive: true, lost: new Promise(() => undefined), async release() {},
	};
	const dependencies: BeadsSyncDependencies = {
		agentDir,
		canonicalize: async (path) => path === DIRECTORY ? DIRECTORY : resolve(path),
		resolveExecutable: async (name) => name === "bd" ? BD_PATH : name === "git" ? "/opt/bin/git" : DOLT_PATH,
		readState: async () => JSON.stringify({ head: "refs/heads/main", remotes: { origin: { url: options.changedRemoteUrl && remoteListReads > (options.changeDuringEnrollment ? 1 : 2) ? options.changedRemoteUrl : options.remoteUrl ?? REMOTE_URL } } }),
		acquireConfigLease: async () => held,
		run,
	};
	return { agentDir, commands, dependencies };
}

async function enrolled(options: FixtureOptions = {}) {
	const value = await fixture(options);
	const prepared = await inspectBeadsSyncTrust({ directory: DIRECTORY, remote: "origin" }, value.dependencies);
	await persistBeadsSyncTrust(prepared, value.dependencies, { sessionId: "fixture-session" });
	value.commands.length = 0;
	return value;
}

test("trust enrollment persists a private exact store, remote, URL, branch and executable binding", async () => {
	const { agentDir, dependencies } = await fixture();
	const prepared = await inspectBeadsSyncTrust({ directory: DIRECTORY, remote: "origin" }, dependencies);
	assert.equal(prepared.display.directory, DIRECTORY);
	assert.equal(prepared.display.remoteUrl, REMOTE_URL);
	assert.equal(prepared.display.databasePath, DATABASE_PATH);
	assert.equal(prepared.display.databaseName, "beads");
	assert.equal(prepared.display.mode, "embedded");
	assert.equal(prepared.display.branch, "main");
	assert.match(prepared.display.connectionRevision, /^[a-f0-9]{64}$/);
	await persistBeadsSyncTrust(prepared, dependencies, { sessionId: "fixture-session" });
	const path = join(agentDir, BEADS_SYNC_CONFIG_NAME);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	const config = JSON.parse(await readFile(path, "utf8"));
	assert.equal(config.version, 1);
	assert.equal(config.stores[0].directory, DIRECTORY);
	assert.equal(config.stores[0].remoteUrl, REMOTE_URL);
});

test("trust enrollment fails closed when evidence changes after confirmation", async () => {
	const value = await fixture({ changedRemoteUrl: "file:///changed", changeDuringEnrollment: true });
	const prepared = await inspectBeadsSyncTrust({ directory: DIRECTORY, remote: "origin" }, value.dependencies);
	await assert.rejects(persistBeadsSyncTrust(prepared, value.dependencies, { sessionId: "fixture-session" }), /evidence changed/i);
});

test("missing or unsafe trust files never authorize synchronization", async (t) => {
	await t.test("unknown store", async () => {
		const { dependencies, commands } = await fixture();
		await assert.rejects(executeBeadsSync({ action: "fetch", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }), /not configured|not trusted/i);
		assert.equal(commands.some(isFetch), false);
	});
	await t.test("unsafe permissions", async () => {
		const { agentDir, dependencies, commands } = await enrolled();
		await chmod(join(agentDir, BEADS_SYNC_CONFIG_NAME), 0o666);
		await assert.rejects(executeBeadsSync({ action: "fetch", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }), /permissions are unsafe/i);
		assert.equal(commands.some(isFetch), false);
	});
});

test("fetch uses the enrolled remote explicitly and returns bounded status", async () => {
	const { dependencies, commands } = await enrolled({ ahead: 2, behind: 3 });
	const evidence = await executeBeadsSync({ action: "fetch", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" });
	assert.equal(evidence.status, "fetched");
	assert.equal(evidence.before, LOCAL_HEAD);
	assert.equal(evidence.after, LOCAL_HEAD);
	assert.equal(evidence.remoteHead, REMOTE_HEAD);
	const fetch = commands.find(isFetch)!;
	assert.ok(fetch);
	assert.deepEqual(fetch.args, ["fetch", "origin", "refs/heads/main:refs/remotes/origin/main"]);
	assert.equal(fetch.cwd, `${DATABASE_PATH}/beads`);
	assert.equal(fetch.env?.BEADS_DIR, BEADS_DIR);
	assert.equal(fetch.env?.BD_DOLT_AUTO_COMMIT, "off");
	assert.equal(fetch.env?.BD_NO_HOOKS, "true");
});

test("pull previews the fixed fetched commit then merges that commit through Beads", async () => {
	const { dependencies, commands } = await enrolled({ behind: 1, ahead: 1 });
	const evidence = await executeBeadsSync({ action: "pull", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" });
	assert.equal(evidence.status, "pulled");
	assert.equal(evidence.before, LOCAL_HEAD);
	assert.equal(evidence.remoteHead, REMOTE_HEAD);
	const merge = commands.find((command) => isOperation(command, "merge"))!;
	assert.deepEqual(merge.args, ["-C", DIRECTORY, "vc", "merge", REMOTE_HEAD, "--json", ...SAFETY_FLAGS]);
	assert.ok(commands.some((command) => commandKey(command).includes("/*preview*/")));
	assert.ok(commands.some((command) => commandKey(command).includes("/*schema*/")));
	assert.equal(commands.some((command) => command.args.includes("pull")), false);
});

test("pull refuses pending work, schema changes, conflicts and changed destinations before merge", async (t) => {
	for (const [name, options, pattern] of [
		["pending work", { pending: 1 }, /pending local changes/i],
		["schema change", { queryRows: { schema: [{ table_name: "issues" }] } }, /schema/i],
		["prospective conflict", { queryRows: { preview: [{ table: "issues", num_data_conflicts: 1 }] } }, /conflict/i],
		["changed destination", { changedRemoteUrl: "file:///changed" }, /destination.*changed|evidence changed/i],
	] as const) {
		await t.test(name, async () => {
			const { dependencies, commands } = await enrolled(options);
			await assert.rejects(executeBeadsSync({ action: "pull", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }), pattern);
			assert.equal(commands.some((command) => isOperation(command, "merge")), false);
		});
	}
});

test("push respects no-push, refuses remote-ahead state and never uses force", async (t) => {
	await t.test("no-push", async () => {
		const { dependencies, commands } = await enrolled({ config: { "no-push": "true" } });
		const evidence = await executeBeadsSync({ action: "push", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" });
		assert.equal(evidence.status, "skipped");
		assert.equal(commands.some((command) => isOperation(command, "push")), false);
	});
	await t.test("remote ahead", async () => {
		const { dependencies, commands } = await enrolled({ behind: 1, ahead: 1 });
		await assert.rejects(executeBeadsSync({ action: "push", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }), /remote is ahead/i);
		assert.equal(commands.some((command) => isOperation(command, "push")), false);
	});
	await t.test("ordinary push", async () => {
		const { dependencies, commands } = await enrolled({ behind: 0, ahead: 1 });
		const evidence = await executeBeadsSync({ action: "push", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" });
		assert.equal(evidence.status, "pushed");
		const push = commands.find((command) => isOperation(command, "push"))!;
		assert.deepEqual(push.args, ["-C", DIRECTORY, "dolt", "push", "--remote", "origin", ...SAFETY_FLAGS]);
		assert.equal(push.args.includes("--force"), false);
	});
});

test("a failed operation is not retried", async () => {
	const { dependencies, commands } = await enrolled({ behind: 0, ahead: 1, fail: /dolt push --remote/ });
	await assert.rejects(executeBeadsSync({ action: "push", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }), /failed/i);
	assert.equal(commands.filter((command) => isOperation(command, "push")).length, 1);
});

test("authorization revoked after fetch prevents push", async () => {
	let revoked = false;
	const options: FixtureOptions = { behind: 0, ahead: 1 };
	const { dependencies, commands } = await enrolled(options);
	options.onCommand = (command) => { if (isFetch(command)) revoked = true; };
	await assert.rejects(executeBeadsSync({ action: "push", directory: DIRECTORY, remote: "origin" }, dependencies, {
		sessionId: "fixture-session", beforeLaunch() { if (revoked) throw new Error("session revoked"); },
	}), /revoked/);
	assert.equal(commands.some((command) => isOperation(command, "push")), false);
});

test("removing trust during fetch prevents the following push", async () => {
	const options: FixtureOptions = { behind: 0, ahead: 1 };
	const { agentDir, dependencies, commands } = await enrolled(options);
	options.onCommand = async (command) => {
		if (isFetch(command)) await writeFile(join(agentDir, BEADS_SYNC_CONFIG_NAME), '{"version":1,"stores":[]}');
	};
	await assert.rejects(executeBeadsSync({ action: "push", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }), /trust|revoked/);
	assert.equal(commands.some((command) => isOperation(command, "push")), false);
});

test("pre-cancelled sync launches no command", async () => {
	const { dependencies, commands } = await enrolled();
	await assert.rejects(executeBeadsSync({ action: "fetch", directory: DIRECTORY, remote: "origin" }, dependencies, {
		sessionId: "fixture-session", signal: AbortSignal.abort(),
	}));
	assert.deepEqual(commands, []);
});

test("schema and conflict preview use immutable local and remote hashes", async () => {
	const { dependencies, commands } = await enrolled();
	await executeBeadsSync({ action: "pull", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" });
	for (const command of commands.filter((item) => /\/\*(?:preview|schema)\*\//.test(commandKey(item)))) {
		assert.doesNotMatch(commandKey(command), /'HEAD'|'origin\/main'/);
	}
});

test("CLI error output is not copied to model-visible errors", async () => {
	const { dependencies } = await enrolled({ behind: 0, ahead: 1 });
	const run = dependencies.run;
	dependencies.run = async (command) => isOperation(command, "push")
		? { code: 1, stdout: "sensitive fixture text", stderr: "https://user:fixture-secret@host/remote" }
		: run(command);
	await assert.rejects(executeBeadsSync({ action: "push", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }), (error: Error) => {
		assert.doesNotMatch(error.message, /fixture-secret|sensitive fixture/);
		return true;
	});
});

test("enrollment rejects credentials embedded in remote URLs", async () => {
	const { dependencies } = await fixture({ remoteUrl: "https://user:private-password@host/repo" });
	await assert.rejects(inspectBeadsSyncTrust({ directory: DIRECTORY, remote: "origin" }, dependencies), (error: Error) => {
		assert.doesNotMatch(error.message, /private-password/);
		assert.match(error.message, /credential|URL/);
		return true;
	});
});

test("dirty SQL state prevents even the first fetch", async () => {
	const { dependencies, commands } = await enrolled({ queryRows: { working: [{ table_name: "issues" }] } });
	await assert.rejects(executeBeadsSync({ action: "fetch", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }), /pending|dirty/i);
	assert.equal(commands.some(isFetch), false);
});

test("export side effects are rejected for fetch as well as pull", async () => {
	const { dependencies, commands } = await enrolled({ config: { "export.auto": "true" } });
	await assert.rejects(executeBeadsSync({ action: "fetch", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }), /export/);
	assert.equal(commands.some(isFetch), false);
});

test("malformed count evidence never proves a conflict-free preview", async () => {
	const { dependencies, commands } = await enrolled();
	const original = dependencies.run;
	dependencies.run = (command) => commandKey(command).includes("/*preview*/") ? Promise.resolve(json({})) : original(command);
	await assert.rejects(executeBeadsSync({ action: "pull", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }), /unsupported result/);
	assert.equal(commands.some((command) => isOperation(command, "merge")), false);
});

test("post-merge ancestry must include both original commits", async () => {
	const { dependencies } = await enrolled();
	const original = dependencies.run;
	let merged = false;
	dependencies.run = async (command) => {
		if (isOperation(command, "merge")) merged = true;
		if (merged && commandKey(command).includes("/*ancestry*/")) return json({ rows: [{ base: "d".repeat(32) }] });
		return original(command);
	};
	await assert.rejects(executeBeadsSync({ action: "pull", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }), /pull verification.*ancestry/);
});

test("an offline Dolt update-check warning is not part of the executable version", async () => {
	for (const doltVersion of ["2.3.0", "2.3.1"]) {
		const { dependencies } = await fixture({ doltVersion });
		const original = dependencies.run;
		dependencies.run = (command) => command.command === DOLT_PATH && command.args[0] === "version"
			? Promise.resolve(result(`dolt version ${doltVersion}\nWarning: unable to query latest released Dolt version\n`)) : original(command);
		const prepared = await inspectBeadsSyncTrust({ directory: DIRECTORY, remote: "origin" }, dependencies);
		assert.equal(prepared.display.doltVersion, `dolt version ${doltVersion}`);
	}
});

test("a mismatched on-disk remote is never silently repaired", async () => {
	const { dependencies, commands } = await enrolled();
	dependencies.readState = async () => JSON.stringify({ head: "refs/heads/main", remotes: { origin: { url: "file:///elsewhere" } } });
	await assert.rejects(executeBeadsSync({ action: "fetch", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }), /identities disagree/);
	assert.equal(commands.some(isFetch), false);
});

test("changed effective server port revokes routine sync before transfer", async () => {
	const { dependencies, commands } = await enrolled({ mode: "server" });
	const original = dependencies.run;
	dependencies.run = (command) => commandKey(command).includes(" dolt show ")
		? Promise.resolve(json({ connection_ok: true, embedded: false, host: "127.0.0.1", port: 9999, database: "beads", user: "root" })) : original(command);
	await assert.rejects(executeBeadsSync({ action: "fetch", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }), /evidence changed/);
	assert.equal(commands.some(isFetch), false);
});

test("changed Git URL expansion invalidates trusted publication authority", async () => {
	const options: FixtureOptions = { remoteUrl: "git+ssh://git@host.example/repo", transportUrl: "ssh://git@first.example/repo" };
	const { dependencies, commands } = await enrolled(options);
	options.transportUrl = "ssh://git@second.example/repo";
	await assert.rejects(executeBeadsSync({ action: "fetch", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }), /evidence changed/);
	assert.equal(commands.some(isFetch), false);
});

test("both tested Dolt patches support enrollment and all operations in both storage modes", async (t) => {
	for (const doltVersion of ["2.3.0", "2.3.1"]) for (const mode of ["embedded", "server"] as const) {
		for (const action of ["fetch", "pull", "push"] as const) await t.test(`${doltVersion} ${mode} ${action}`, async () => {
			const { dependencies, commands } = await enrolled({ doltVersion, mode, behind: action === "push" ? 0 : 1 });
			const evidence = await executeBeadsSync({ action, directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" });
			assert.equal(evidence.verified, true);
			const probes = commands.filter((command) => commandKey(command).includes("/*capabilities*/"));
			assert.ok(probes.length > 0);
			assert.ok(probes.every((command) => command.command === (mode === "server" ? BD_PATH : DOLT_PATH)));
			assert.ok(probes.every((command) => mode === "server" ? command.args.includes("--readonly") : command.args.includes("--disable-auto-gc")));
			const firstFetch = commands.findIndex(isFetch);
			for (const name of ["fetch", "merge", "push"]) assert.ok(commands.slice(0, firstFetch).some((command) => command.args.includes(name) && command.args.includes("--help")));
		});
	}
});

test("unsupported, ambiguous and prerelease versions fail closed", async (t) => {
	for (const doltVersion of ["2.2.9", "2.3.2", "2.3.5", "2.3.10", "2.4.0", "3.0.0", "2.3", "2.3.01", "2.3.1-dev", "2.3.1+build", "2.3.1\ndolt version 2.3.0"]) {
		await t.test(doltVersion, async () => {
			const { dependencies, commands } = await fixture({ doltVersion });
			await assert.rejects(inspectBeadsSyncTrust({ directory: DIRECTORY, remote: "origin" }, dependencies), /unsupported dolt version/i);
			assert.equal(commands.some(isFetch), false);
		});
	}
	for (const bdVersion of ["1.2.3", "1.2.20", "1.2.2-dev"]) {
		const { dependencies } = await fixture({ bdVersion });
		await assert.rejects(inspectBeadsSyncTrust({ directory: DIRECTORY, remote: "origin" }, dependencies), /unsupported bd version/i);
	}
});

test("supported patch changes still require exact re-enrollment", async () => {
	const options = { doltVersion: "2.3.0" };
	const { agentDir, dependencies, commands } = await enrolled(options);
	assert.equal(JSON.parse(await readFile(join(agentDir, BEADS_SYNC_CONFIG_NAME), "utf8")).stores[0].doltVersion, "dolt version 2.3.0");
	options.doltVersion = "2.3.1";
	await assert.rejects(executeBeadsSync({ action: "fetch", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }), /evidence changed/);
	assert.equal(commands.some(isFetch), false);
});

test("failed live capabilities refuse enrollment and every action before transfer", async (t) => {
	for (const failure of [
		{ fail: /\/\*capabilities\*\// },
		{ fail: /fetch --help/ },
		{ help: { fetch: "dolt fetch" } },
		{ help: { merge: "bd vc merge <branch> --json" } },
		{ help: { push: "bd dolt push --sandbox --dolt-auto-commit" } },
		{ capabilities: { version: "2.4.0" } },
		{ capabilities: { base: REMOTE_HEAD } },
		{ capabilities: { head: REMOTE_HEAD } },
		{ capabilities: { schema_changes: 1 } },
		{ capabilities: { migrations: "0" } },
		{ capabilities: { conflicts: null } },
	] satisfies FixtureOptions[]) await t.test(JSON.stringify(failure), async () => {
		const { dependencies } = await fixture(failure);
		await assert.rejects(inspectBeadsSyncTrust({ directory: DIRECTORY, remote: "origin" }, dependencies));
		for (const action of ["fetch", "pull", "push"] as const) {
			const options: FixtureOptions = {};
			const value = await enrolled(options);
			Object.assign(options, failure);
			await assert.rejects(executeBeadsSync({ action, directory: DIRECTORY, remote: "origin" }, value.dependencies, { sessionId: "fixture-session" }));
			assert.equal(value.commands.some((command) => ["fetch", "merge", "push"].some((name) => isOperation(command, name))), false);
		}
	});
});

test("capability probes require one well-formed evidence row", async () => {
	for (const output of ["not JSON", "{}", '{"rows":[]}', '{"rows":[{},{}]}', '{"rows":[{}]}']) {
		const { dependencies, commands } = await enrolled();
		const original = dependencies.run;
		dependencies.run = (command) => commandKey(command).includes("/*capabilities*/") ? Promise.resolve(result(output)) : original(command);
		await assert.rejects(executeBeadsSync({ action: "fetch", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }));
		assert.equal(commands.some(isFetch), false);
	}
});

test("admitted Dolt patches do not weaken the Beads schema contract", async () => {
	for (const doltVersion of ["2.3.0", "2.3.1"]) for (const column of ["schema_version", "schema_count"]) {
		const { dependencies, commands } = await enrolled({ doltVersion });
		const original = dependencies.run;
		dependencies.run = async (command) => {
			const output = await original(command);
			if (commandKey(command).includes("/*working*/")) {
				const parsed = JSON.parse(output.stdout);
				parsed.rows[0][column] = 54;
				return json(parsed);
			}
			return output;
		};
		await assert.rejects(executeBeadsSync({ action: "fetch", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }), /schema migration state/i);
		assert.equal(commands.some(isFetch), false);
	}
});

test("capabilities are rechecked after fetch before mutation", async () => {
	const options: FixtureOptions = { behind: 0 };
	const { dependencies, commands } = await enrolled(options);
	options.onCommand = (command) => { if (isFetch(command)) options.help = { push: "unavailable" }; };
	await assert.rejects(executeBeadsSync({ action: "push", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" }), /capabilit/i);
	assert.equal(commands.some((command) => isOperation(command, "push")), false);
});

test("server mode uses the owner-qualified Beads SQL boundary for pull preview", async () => {
	const { dependencies, commands } = await enrolled({ mode: "server", behind: 1 });
	await executeBeadsSync({ action: "pull", directory: DIRECTORY, remote: "origin" }, dependencies, { sessionId: "fixture-session" });
	const queries = commands.filter((command) => command.args.includes("sql"));
	assert.ok(queries.length >= 5);
	assert.ok(queries.every((command) => command.command === BD_PATH && command.args.includes("--readonly")));
});
