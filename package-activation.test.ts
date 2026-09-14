import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";
import {
	activatePreparedPackage,
	defaultPackageActivationDependencies,
	preparePackageActivation,
	type ActivationCommand,
	type PackageActivationDependencies,
} from "./package-activation.ts";

const execFileAsync = promisify(execFile);
const OLD_SHA = "1".repeat(40);
const NEW_SHA = "2".repeat(40);
const REPOSITORY = "github.com/flurdy/pi-session-mode";
const AT = String.fromCharCode(64);
const PACKAGE_NAME = `${AT}flurdy/pi-session-mode`;
const OTHER_PACKAGE = `npm:other${AT}1.0.0`;
const packageSourceFor = (version: string) => `git:${REPOSITORY}${AT}${version}`;
const SOURCE = packageSourceFor("v0.3.0");
const fixtureDirs: string[] = [];
after(async () => { for (const path of fixtureDirs) await rm(path, { recursive: true, force: true }); });

async function fixture() {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-package-activation-"));
	fixtureDirs.push(agentDir);
	const packageDir = join(agentDir, "pi-runtime");
	const checkout = join(agentDir, "git", "github.com", "flurdy", "pi-session-mode");
	await mkdir(join(packageDir, "dist", "bundle"), { recursive: true });
	await mkdir(checkout, { recursive: true });
	await writeFile(join(packageDir, "package.json"), `${JSON.stringify({ bin: { pi: "dist/bundle/cli.js" } })}\n`);
	await writeFile(join(packageDir, "dist", "bundle", "cli.js"), "export {};\n");
	await writeFile(join(agentDir, "package-activation.json"), `${JSON.stringify({
		version: 1,
		packages: [{
			key: "session-mode",
			repository: REPOSITORY,
			manifestName: PACKAGE_NAME,
			mutableExtensionPaths: ["extensions/flurdy-session-mode"],
		}],
	})}\n`);
	await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ theme: "dark", packages: [SOURCE, OTHER_PACKAGE] })}\n`);
	await writeFile(join(checkout, "package.json"), `${JSON.stringify({ name: PACKAGE_NAME, version: "0.3.0" })}\n`);
	let head = OLD_SHA;
	const commands: ActivationCommand[] = [];
	const run = async (command: ActivationCommand) => {
		commands.push(command);
		if (command.args[0] === "ls-remote") return { code: 0, stdout: `${"a".repeat(40)}\trefs/tags/v0.4.0\n${NEW_SHA}\trefs/tags/v0.4.0^{}\n`, stderr: "" };
		if (command.args.includes("status")) return { code: 0, stdout: "", stderr: "" };
		if (command.args.includes("config")) return { code: 0, stdout: "https://github.com/flurdy/pi-session-mode.git\n", stderr: "" };
		if (command.args.includes("rev-parse")) return { code: 0, stdout: `${head}\n`, stderr: "" };
		throw new Error(`Unexpected command: ${JSON.stringify(command)}`);
	};
	const dependencies: PackageActivationDependencies = {
		agentDir,
		packageDir,
		run,
		runInstaller: async (command) => {
			commands.push(command);
			head = NEW_SHA;
			await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ theme: "dark", packages: [packageSourceFor("v0.4.0"), OTHER_PACKAGE] })}\n`);
			await writeFile(join(checkout, "package.json"), `${JSON.stringify({ name: PACKAGE_NAME, version: "0.4.0" })}\n`);
			return { code: 0, stdout: "Installed", stderr: "" };
		},
	};
	return { agentDir, checkout, packageDir, dependencies, commands };
}

test("prepares an allowlisted installed package and binds its tag to the expected commit", async () => {
	const { agentDir, checkout, dependencies, commands } = await fixture();
	const prepared = await preparePackageActivation({ package: "session-mode", version: "v0.4.0", expectedCommit: NEW_SHA }, dependencies);
	assert.deepEqual(prepared.display, {
		package: "session-mode",
		currentSource: SOURCE,
		requestedSource: packageSourceFor("v0.4.0"),
		currentCommit: OLD_SHA,
		expectedCommit: NEW_SHA,
		settingsPath: join(agentDir, "settings.json"),
		checkoutPath: checkout,
	});
	assert.match(prepared.revision, /^[a-f0-9]{64}$/);
	assert.deepEqual(commands.at(-1)?.args, ["ls-remote", "https://github.com/flurdy/pi-session-mode.git", "refs/tags/v0.4.0", "refs/tags/v0.4.0^{}"]);
});

test("installer ignores stdin and drains large output without termination", async () => {
	const { runInstaller } = defaultPackageActivationDependencies();
	const code = 'process.stdin.on("end", () => process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 65), () => process.exit(0))); process.stdin.resume(); setTimeout(() => process.exit(7), 2500).unref();';
	const result = await runInstaller({ command: process.execPath, args: ["-e", code], cwd: process.cwd() });
	assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
});

test("preflight ignores ambient Git redirects", async () => {
	const { dependencies, commands } = await fixture();
	const originalGitDir = process.env.GIT_DIR;
	process.env.GIT_DIR = "/hostile/git-dir";
	try { await preparePackageActivation({ package: "session-mode", version: "v0.4.0", expectedCommit: NEW_SHA }, dependencies); }
	finally {
		if (originalGitDir === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = originalGitDir;
	}
	for (const command of commands) {
		assert.equal(command.env?.GIT_DIR, undefined);
		assert.equal(command.env?.GIT_TERMINAL_PROMPT, "0");
	}
});

test("native Pi activates an existing package through a loopback Git fixture", async (t) => {
	const remoteRoot = await mkdtemp(join(tmpdir(), "pi-package-remote-"));
	const bare = join(remoteRoot, "pi-session-mode.git");
	const work = join(remoteRoot, "work");
	await mkdir(work);
	execFileSync("git", ["init", "--bare", "-q", bare]);
	execFileSync("git", ["-C", work, "init", "-q", "-b", "main"]);
	const commitEnv = { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: ["fixture", "example.test"].join(AT), GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: ["fixture", "example.test"].join(AT) };
	for (const version of ["0.3.0", "0.4.0"]) {
		await writeFile(join(work, "package.json"), `${JSON.stringify({ name: PACKAGE_NAME, version, private: true })}\n`);
		execFileSync("git", ["-C", work, "add", "package.json"]);
		execFileSync("git", ["-C", work, "commit", "-q", "-m", "fixture"], { env: commitEnv });
		execFileSync("git", ["-C", work, "tag", "-a", `v${version}`, "-m", "fixture"], { env: commitEnv });
	}
	execFileSync("git", ["-C", work, "push", "-q", bare, "main", "v0.3.0", "v0.4.0"]);
	execFileSync("git", ["--git-dir", bare, "update-server-info"]);
	const server = createServer(async (request, response) => {
		const relative = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname)).replace(/^\/+/, "");
		if (relative.startsWith("..")) { response.writeHead(404).end(); return; }
		try { response.end(await readFile(join(remoteRoot, relative))); }
		catch { response.writeHead(404).end(); }
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(remoteRoot, { recursive: true, force: true }); });
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const expectedCommit = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const loopback = `http://127.0.0.1:${address.port}/pi-session-mode.git`;
	const { agentDir, checkout } = await fixture();
	await rm(checkout, { recursive: true, force: true });
	await execFileAsync("git", ["clone", "-q", "--branch", "v0.3.0", bare, checkout]);
	execFileSync("git", ["-C", checkout, "remote", "set-url", "origin", `https://${REPOSITORY}.git`]);
	await writeFile(join(agentDir, ".gitconfig"), `[url "${loopback}"]\n\tinsteadOf = https://${REPOSITORY}.git\n`);
	const settings = { theme: "dark", defaultProjectTrust: "never", packages: [{ source: SOURCE, extensions: [] }] };
	await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
	const native = defaultPackageActivationDependencies();
	const isolated = (command: ActivationCommand): ActivationCommand => ({ ...command, env: {
		...command.env, HOME: agentDir, XDG_CONFIG_HOME: join(agentDir, "config"), PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
		npm_config_userconfig: join(agentDir, ".npmrc"), npm_config_cache: join(agentDir, "npm-cache"),
		npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false", npm_config_package_lock: "false",
	} });
	const dependencies: PackageActivationDependencies = {
		...native, agentDir,
		run: (command) => native.run(isolated(command)),
		runInstaller: (command) => native.runInstaller(isolated(command)),
	};
	const request = { package: "session-mode", version: "v0.4.0", expectedCommit };
	const prepared = await preparePackageActivation(request, dependencies);
	const result = await activatePreparedPackage(request, prepared, dependencies);
	assert.equal(result.verified, true);
	assert.equal(result.commit, expectedCommit);
	assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")), {
		...settings, packages: [{ source: packageSourceFor("v0.4.0"), extensions: [] }],
	});
	assert.equal(execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), expectedCommit);
});

test("preflight rejects unapproved, ambiguous, missing and stale package evidence", async (t) => {
	await t.test("unknown allowlist key", async () => {
		const { dependencies } = await fixture();
		await assert.rejects(preparePackageActivation({ package: "other", version: "v0.4.0", expectedCommit: NEW_SHA }, dependencies), /not allowlisted/);
	});
	await t.test("writable allowlist", async () => {
		const { agentDir, dependencies } = await fixture();
		await chmod(join(agentDir, "package-activation.json"), 0o666);
		await assert.rejects(preparePackageActivation({ package: "session-mode", version: "v0.4.0", expectedCommit: NEW_SHA }, dependencies), /allowlist.*permissions/i);
	});
	await t.test("non-version tag", async () => {
		const { dependencies } = await fixture();
		await assert.rejects(preparePackageActivation({ package: "session-mode", version: "main", expectedCommit: NEW_SHA }, dependencies), /version tag/);
	});
	await t.test("oversized policy", async () => {
		const { agentDir, dependencies } = await fixture();
		await writeFile(join(agentDir, "package-activation.json"), " ".repeat(1024 * 1024 + 1));
		await assert.rejects(preparePackageActivation({ package: "session-mode", version: "v0.4.0", expectedCommit: NEW_SHA }, dependencies), /too large/);
	});
	await t.test("malformed user settings", async () => {
		const { agentDir, dependencies } = await fixture();
		await writeFile(join(agentDir, "settings.json"), "{malformed");
		await assert.rejects(preparePackageActivation({ package: "session-mode", version: "v0.4.0", expectedCommit: NEW_SHA }, dependencies), /User settings is not valid JSON/);
	});
	await t.test("duplicate configured identities include unpinned and alternate refs", async () => {
		const { agentDir, dependencies } = await fixture();
		for (const source of [SOURCE, `https://${REPOSITORY}${AT}v0.3.0`, `git:github.com/flurdy/pi-session-mode`, `git:git${AT}github.com:flurdy/pi-session-mode.git${AT}topic/branch`, `ssh://git${AT}github.com/FLURDY/PI-SESSION-MODE${AT}v0.3.0`, "git:github.com/flurdy/pi-session-mode#v0.3.0"]) {
			await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [SOURCE, { source }] })}\n`);
			await assert.rejects(preparePackageActivation({ package: "session-mode", version: "v0.4.0", expectedCommit: NEW_SHA }, dependencies), /exactly one installed user package/, source);
		}
	});
	await t.test("dot-segment repository authority", async () => {
		const { agentDir, dependencies } = await fixture();
		await writeFile(join(agentDir, "package-activation.json"), `${JSON.stringify({ version: 1, packages: [{
			key: "session-mode", repository: "github.com/./pi-session-mode", manifestName: PACKAGE_NAME, mutableExtensionPaths: [],
		}] })}\n`);
		await assert.rejects(preparePackageActivation({ package: "session-mode", version: "v0.4.0", expectedCommit: NEW_SHA }, dependencies), /invalid package entry/);
	});
	await t.test("moved tag", async () => {
		const { dependencies } = await fixture();
		dependencies.run = async (command) => command.args[0] === "ls-remote"
			? { code: 0, stdout: `${"3".repeat(40)}\trefs/tags/v0.4.0\n`, stderr: "" }
			: command.args.includes("status") ? { code: 0, stdout: "", stderr: "" }
				: command.args.includes("config") ? { code: 0, stdout: "https://github.com/flurdy/pi-session-mode.git\n", stderr: "" }
					: { code: 0, stdout: `${OLD_SHA}\n`, stderr: "" };
		await assert.rejects(preparePackageActivation({ package: "session-mode", version: "v0.4.0", expectedCommit: NEW_SHA }, dependencies), /does not resolve to the expected commit/);
	});
	await t.test("dirty managed checkout", async () => {
		const { dependencies } = await fixture();
		const original = dependencies.run;
		dependencies.run = async (command) => command.args.includes("status")
			? { code: 0, stdout: command.args.includes("--untracked-files=all") ? "?? notes.txt\n" : "", stderr: "" }
			: original(command);
		await assert.rejects(preparePackageActivation({ package: "session-mode", version: "v0.4.0", expectedCommit: NEW_SHA }, dependencies), /uncommitted changes/);
	});
	await t.test("origin mismatch", async () => {
		const { dependencies } = await fixture();
		const original = dependencies.run;
		dependencies.run = async (command) => command.args.includes("config")
			? { code: 0, stdout: "https://github.com/attacker/pi-session-mode.git\n", stderr: "" }
			: original(command);
		await assert.rejects(preparePackageActivation({ package: "session-mode", version: "v0.4.0", expectedCommit: NEW_SHA }, dependencies), /origin does not match/);
	});
	await t.test("mutable duplicate extension", async () => {
		const { agentDir, dependencies } = await fixture();
		await mkdir(join(agentDir, "extensions", "flurdy-session-mode"), { recursive: true });
		await assert.rejects(preparePackageActivation({ package: "session-mode", version: "v0.4.0", expectedCommit: NEW_SHA }, dependencies), /duplicate extension source/);
	});
});

test("activation revalidates, invokes the trusted Pi CLI with fixed argv, and verifies the result", async () => {
	const { agentDir, packageDir, dependencies, commands } = await fixture();
	const request = { package: "session-mode", version: "v0.4.0", expectedCommit: NEW_SHA };
	const prepared = await preparePackageActivation(request, dependencies);
	const originalGitDir = process.env.GIT_DIR;
	process.env.GIT_DIR = "/hostile/git-dir";
	let result;
	let launchGuardCalled = false;
	try { result = await activatePreparedPackage(request, prepared, dependencies, { beforeLaunch: () => { launchGuardCalled = true; } }); }
	finally {
		if (originalGitDir === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = originalGitDir;
	}
	assert.equal(launchGuardCalled, true);
	assert.deepEqual(result, {
		package: "session-mode",
		source: packageSourceFor("v0.4.0"),
		commit: NEW_SHA,
		version: "0.4.0",
		verified: true,
	});
	const install = commands.find((command) => command.args.includes("install"));
	assert.ok(install);
	assert.equal(install.command, process.execPath);
	assert.deepEqual(install.args, [join(packageDir, "dist", "bundle", "cli.js"), "install", "git:github.com/flurdy/pi-session-mode\u0040v0.4.0"]);
	assert.equal(install.cwd, agentDir);
	assert.equal(install.env?.PI_CODING_AGENT_DIR, agentDir);
	assert.equal(install.env?.GIT_TERMINAL_PROMPT, "0");
	assert.match(install.env?.GIT_SSH_COMMAND ?? "", /BatchMode=yes/);
	assert.equal(install.env?.GIT_DIR, undefined);
	assert.equal(install.signal, undefined);
	assert.equal(install.timeoutMs, undefined);
	const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.packages, ["git:github.com/flurdy/pi-session-mode\u0040v0.4.0", OTHER_PACKAGE]);
});

test("activation cancels on changed preflight evidence and reports installer failures", async (t) => {
	await t.test("cancelled final preflight", async () => {
		const { dependencies, commands } = await fixture();
		const request = { package: "session-mode", version: "v0.4.0", expectedCommit: NEW_SHA };
		const prepared = await preparePackageActivation(request, dependencies);
		const abort = new AbortController();
		const original = dependencies.run;
		dependencies.run = async (command) => {
			const result = await original(command);
			if (command.args[0] === "ls-remote") abort.abort();
			return result;
		};
		await assert.rejects(activatePreparedPackage(request, prepared, dependencies, { signal: abort.signal }), /aborted/i);
		assert.equal(commands.some((command) => command.args.includes("install")), false);
	});
	await t.test("changed settings", async () => {
		const { agentDir, dependencies, commands } = await fixture();
		const request = { package: "session-mode", version: "v0.4.0", expectedCommit: NEW_SHA };
		const prepared = await preparePackageActivation(request, dependencies);
		await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ theme: "light", packages: [SOURCE, OTHER_PACKAGE] })}\n`);
		await assert.rejects(activatePreparedPackage(request, prepared, dependencies), /changed after confirmation/);
		assert.equal(commands.some((command) => command.args.includes("install")), false);
	});
	await t.test("native installer failure", async () => {
		const { dependencies } = await fixture();
		dependencies.runInstaller = async () => ({ code: 1, stdout: "private output", stderr: "secret path" });
		const request = { package: "session-mode", version: "v0.4.0", expectedCommit: NEW_SHA };
		const prepared = await preparePackageActivation(request, dependencies);
		await assert.rejects(activatePreparedPackage(request, prepared, dependencies), (error: Error) => {
			assert.match(error.message, /Pi package activation failed with exit code 1/);
			assert.doesNotMatch(error.message, /private output|secret path/);
			return true;
		});
	});
	await t.test("successful command with an unverified result", async () => {
		const { dependencies } = await fixture();
		dependencies.runInstaller = async () => ({ code: 0, stdout: "Installed", stderr: "" });
		const request = { package: "session-mode", version: "v0.4.0", expectedCommit: NEW_SHA };
		const prepared = await preparePackageActivation(request, dependencies);
		await assert.rejects(activatePreparedPackage(request, prepared, dependencies), /requested source and commit were not installed/);
	});
	await t.test("unrelated settings change", async () => {
		const { agentDir, dependencies } = await fixture();
		const installer = dependencies.runInstaller;
		dependencies.runInstaller = async (command) => {
			const result = await installer(command);
			const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
			settings.theme = "light";
			await writeFile(join(agentDir, "settings.json"), `${JSON.stringify(settings)}\n`);
			return result;
		};
		const request = { package: "session-mode", version: "v0.4.0", expectedCommit: NEW_SHA };
		const prepared = await preparePackageActivation(request, dependencies);
		await assert.rejects(activatePreparedPackage(request, prepared, dependencies), /changed unrelated user settings/);
	});
});
