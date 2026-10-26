import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireWorktreeLease, lockIdentity } from "./lease.ts";
import { inventoryHeldLeases, MAX_INVENTORY_LOCKS, type LeaseInventoryOptions, type ParentObservation } from "./lease-inventory.ts";

async function fixture(): Promise<{ root: string; runtimeDir: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "pi-lease-inventory-"));
	const runtimeDir = join(root, "runtime");
	await mkdir(runtimeDir, { mode: 0o700 });
	return { root, runtimeDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function scripted(root: string, body: string): Promise<string> {
	const command = join(root, "scripted-lslocks");
	await writeFile(command, "#!" + process.execPath + "\n" + body + "\n", { mode: 0o700 });
	return command;
}

function row(runtimeDir: string, name: string, pid: unknown, mode = "WRITE", type = "FLOCK") {
	return { path: join(runtimeDir, name), type, mode, pid };
}

async function scan(runtimeDir: string, locks: unknown[], parents: Record<number, ParentObservation>, options: LeaseInventoryOptions = {}) {
	const command = await scripted(runtimeDir, "console.log(" + JSON.stringify(JSON.stringify({ locks })) + ");");
	return inventoryHeldLeases({
		runtimeDir,
		lslocksCommand: command,
		selfPid: 500,
		ownerUid: process.getuid?.(),
		readParent: async (pid) => parents[pid] ?? { kind: "unavailable", detail: "unexpected pid " + pid },
		...options,
	});
}

const metadata = (identity: "root" | "file" | "dir", path: string, pid: number, parentPid: number, sessionId = "session-" + pid) =>
	JSON.stringify({ [identity]: path, pid, parentPid, sessionId, startedAt: "2026-01-01T00:00:00.000Z" }) + "\n";

test("missing runtime directory is an empty inventory; a non-private one is unavailable", async () => {
	const { root, runtimeDir, cleanup } = await fixture();
	try {
		assert.deepEqual(await inventoryHeldLeases({ runtimeDir: join(root, "absent") }), { kind: "inventory", runtimeDir: join(root, "absent"), sessions: [], truncated: false });
		await chmod(runtimeDir, 0o755);
		const result = await scan(runtimeDir, [], {});
		assert.equal(result.kind, "unavailable");
		if (result.kind === "unavailable") assert.match(result.reason, /not private/);
		const other = await scan(runtimeDir, [], {}, { ownerUid: 0 });
		await chmod(runtimeDir, 0o700);
		assert.equal(other.kind, "unavailable");
	} finally { await cleanup(); }
});

test("groups held locks by live parent process and binds only fully matching metadata", async () => {
	const { runtimeDir, cleanup } = await fixture();
	try {
		const a = "/work/repo-a", b = "/work/repo-b", f = "/home/user/settings.json";
		await writeFile(join(runtimeDir, lockIdentity(a) + ".json"), metadata("root", a, 101, 500, "self-session"));
		await writeFile(join(runtimeDir, lockIdentity(b) + ".json"), metadata("root", b, 999, 600));
		const result = await scan(runtimeDir, [
			row(runtimeDir, lockIdentity(a) + ".lock", 101),
			row(runtimeDir, lockIdentity(a) + ".lock", 777, "READ"),
			row(runtimeDir, lockIdentity(b) + ".lock", 102),
			row(runtimeDir, "file-" + lockIdentity(f) + ".lock", 103),
			row(runtimeDir, "unrelated.lock", 104),
			{ path: "/elsewhere/" + lockIdentity(a) + ".lock", type: "FLOCK", mode: "WRITE", pid: 105 },
			"garbage",
		], { 101: { kind: "live", parentPid: 500 }, 102: { kind: "live", parentPid: 600 }, 103: { kind: "live", parentPid: 600 } });
		assert.equal(result.kind, "inventory");
		if (result.kind !== "inventory") return;
		assert.equal(result.truncated, false);
		assert.deepEqual(result.sessions, [
			{ parentPid: 500, self: true, sessionIds: ["self-session"], files: [], folders: [], worktrees: [
				{ kind: "worktree", identity: lockIdentity(a), holderPid: 101, parent: "live", parentPid: 500, self: true, binding: "bound", path: a, sessionId: "self-session", startedAt: "2026-01-01T00:00:00.000Z" },
			] },
			{ parentPid: 600, self: false, sessionIds: [], folders: [], worktrees: [
				{ kind: "worktree", identity: lockIdentity(b), holderPid: 102, parent: "live", parentPid: 600, self: false, binding: "mismatch" },
			], files: [
				{ kind: "file", identity: lockIdentity(f), holderPid: 103, parent: "live", parentPid: 600, self: false, binding: "missing" },
			] },
		]);
	} finally { await cleanup(); }
});

test("gone, unreadable and ambiguous holders stay visible without becoming proof", async () => {
	const { runtimeDir, cleanup } = await fixture();
	try {
		const c = "/work/c", d = "/work/d", e = "/work/e", g = "/work/g";
		await writeFile(join(runtimeDir, lockIdentity(c) + ".json"), metadata("root", c, 201, 900));
		const result = await scan(runtimeDir, [
			row(runtimeDir, lockIdentity(c) + ".lock", 201),
			row(runtimeDir, lockIdentity(d) + ".lock", 202),
			row(runtimeDir, lockIdentity(e) + ".lock", 203),
			row(runtimeDir, lockIdentity(e) + ".lock", 204),
			row(runtimeDir, lockIdentity(g) + ".lock", "bad"),
		], { 201: { kind: "gone" }, 202: { kind: "unavailable", detail: "holder belongs to another user" } });
		assert.equal(result.kind, "inventory");
		if (result.kind !== "inventory") return;
		assert.equal(result.sessions.length, 1);
		const [session] = result.sessions;
		assert.deepEqual({ ...session, worktrees: undefined }, { self: false, sessionIds: [], files: [], folders: [], worktrees: undefined });
		const byIdentity = new Map(session!.worktrees.map((entry) => [entry.identity, entry]));
		assert.deepEqual(byIdentity.get(lockIdentity(c)), { kind: "worktree", identity: lockIdentity(c), holderPid: 201, parent: "gone", self: false, binding: "mismatch" });
		assert.deepEqual(byIdentity.get(lockIdentity(d)), { kind: "worktree", identity: lockIdentity(d), holderPid: 202, parent: "unavailable", self: false, binding: "missing", detail: "holder belongs to another user" });
		assert.deepEqual(byIdentity.get(lockIdentity(e)), { kind: "worktree", identity: lockIdentity(e), parent: "unavailable", self: false, binding: "mismatch", detail: "lock scan reports several holder pids" });
		assert.deepEqual(byIdentity.get(lockIdentity(g)), { kind: "worktree", identity: lockIdentity(g), parent: "unavailable", self: false, binding: "mismatch", detail: "lock scan reports no valid holder pid" });
	} finally { await cleanup(); }
});

test("exclusive folder locks bind dir metadata while shared intents stay invisible", async () => {
	const { runtimeDir, cleanup } = await fixture();
	try {
		const d = "/home/user/.agents/handoffs";
		await writeFile(join(runtimeDir, "dir-" + lockIdentity(d) + ".json"), metadata("dir", d, 401, 500, "folder-session"));
		const result = await scan(runtimeDir, [
			row(runtimeDir, "dir-" + lockIdentity(d) + ".lock", 401),
			row(runtimeDir, "dir-" + lockIdentity("/home/user/.agents") + ".lock", 402, "READ"),
		], { 401: { kind: "live", parentPid: 500 } });
		assert.equal(result.kind, "inventory");
		if (result.kind !== "inventory") return;
		assert.deepEqual(result.sessions, [{ parentPid: 500, self: true, sessionIds: ["folder-session"], worktrees: [], files: [], folders: [
			{ kind: "folder", identity: lockIdentity(d), holderPid: 401, parent: "live", parentPid: 500, self: true, binding: "bound", path: d, sessionId: "folder-session", startedAt: "2026-01-01T00:00:00.000Z" },
		] }]);
	} finally { await cleanup(); }
});

test("metadata is read defensively: exact names, bounded size, valid shape, matching namespace", async () => {
	const { runtimeDir, cleanup } = await fixture();
	try {
		const roots = ["/work/tmp-only", "/work/oversized", "/work/not-json", "/work/other-hash", "/work/wrong-namespace", "/work/fifo"];
		const [tmpOnly, oversized, notJson, otherHash, wrongNamespace, fifo] = roots.map(lockIdentity);
		await writeFile(join(runtimeDir, tmpOnly + ".json.0000-tmp.tmp"), metadata("root", roots[0]!, 301, 500));
		await writeFile(join(runtimeDir, oversized + ".json"), " ".repeat(5000) + metadata("root", roots[1]!, 302, 500));
		await writeFile(join(runtimeDir, notJson + ".json"), "{not json\n");
		await writeFile(join(runtimeDir, otherHash + ".json"), metadata("root", "/work/different", 304, 500));
		await writeFile(join(runtimeDir, "file-" + wrongNamespace + ".json"), metadata("file", roots[4]!, 305, 500));
		execFileSync("mkfifo", [join(runtimeDir, fifo + ".json")]);
		const parents = Object.fromEntries([301, 302, 303, 304, 305, 306].map((pid) => [pid, { kind: "live", parentPid: 500 }])) as Record<number, ParentObservation>;
		const result = await scan(runtimeDir, roots.map((root, index) => row(runtimeDir, lockIdentity(root) + ".lock", 301 + index)), parents);
		assert.equal(result.kind, "inventory");
		if (result.kind !== "inventory") return;
		const bindings = Object.fromEntries(result.sessions[0]!.worktrees.map((entry) => [entry.identity, entry.binding]));
		assert.deepEqual(bindings, { [tmpOnly]: "missing", [oversized]: "invalid", [notJson]: "invalid", [otherHash]: "mismatch", [wrongNamespace]: "missing", [fifo]: "invalid" });
		assert.ok(result.sessions[0]!.worktrees.every((entry) => entry.path === undefined && entry.sessionId === undefined));
	} finally { await cleanup(); }
});

test("bounds the inventory and reports truncation", async () => {
	const { runtimeDir, cleanup } = await fixture();
	try {
		const locks = Array.from({ length: MAX_INVENTORY_LOCKS + 2 }, (_, index) => row(runtimeDir, lockIdentity("/work/" + index) + ".lock", 1000 + index));
		const result = await scan(runtimeDir, locks, {}, { readParent: async () => ({ kind: "live", parentPid: 700 }) });
		assert.equal(result.kind, "inventory");
		if (result.kind !== "inventory") return;
		assert.equal(result.truncated, true);
		assert.equal(result.sessions.length, 1);
		assert.equal(result.sessions[0]!.worktrees.length, MAX_INVENTORY_LOCKS);
	} finally { await cleanup(); }
});

test("scan failures and cancellation are unavailable, never an empty inventory", async () => {
	const { runtimeDir, cleanup } = await fixture();
	try {
		for (const body of ["console.log('not json');", "console.log('{\"locks\":{}}');", "process.exit(2);", "console.log('{\"locks\":[]}'); process.exitCode = 2;"]) {
			const result = await inventoryHeldLeases({ runtimeDir, lslocksCommand: await scripted(runtimeDir, body) });
			assert.equal(result.kind, "unavailable", body);
		}
		const slow = await inventoryHeldLeases({ runtimeDir, lslocksCommand: await scripted(runtimeDir, "setTimeout(() => console.log('{\"locks\":[]}'), 3000);"), timeoutMs: 100 });
		assert.equal(slow.kind, "unavailable");
		if (slow.kind === "unavailable") assert.match(slow.reason, /timed out after 100ms$/);
		const controller = new AbortController();
		controller.abort();
		assert.equal((await inventoryHeldLeases({ runtimeDir, signal: controller.signal })).kind, "unavailable");
		assert.equal((await inventoryHeldLeases({ runtimeDir, lslocksCommand: "/nonexistent/pi-test-lslocks" })).kind, "unavailable");
	} finally { await cleanup(); }
});

test("observes real kernel holders across distinct parent processes without acquiring anything", async () => {
	const { root, runtimeDir, cleanup } = await fixture();
	const repo = join(root, "repo");
	await mkdir(repo);
	execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
	const foreignLock = join(runtimeDir, lockIdentity("/work/foreign") + ".lock");
	// The trailing command stops the shell exec-optimising, so the holder's parent is this sh, not the test process.
	const foreign = spawn("sh", ["-c", 'flock -n -F "$0" sh -c "echo ready; exec cat"; exit $?', foreignLock], { stdio: ["pipe", "pipe", "pipe"] });
	const lease = await acquireWorktreeLease(repo, { runtimeDir, sessionId: "self-session" });
	try {
		assert.equal(lease.kind, "held");
		if (lease.kind !== "held") return;
		await new Promise<void>((resolve, reject) => {
			foreign.stdout.once("data", () => resolve());
			foreign.once("exit", () => reject(new Error("foreign holder exited early")));
		});
		const before = (await readdir(runtimeDir)).sort();
		const result = await inventoryHeldLeases({ runtimeDir, timeoutMs: 10_000 });
		assert.deepEqual((await readdir(runtimeDir)).sort(), before);
		assert.equal(result.kind, "inventory");
		if (result.kind !== "inventory") return;
		const self = result.sessions.find((session) => session.self);
		const other = result.sessions.find((session) => !session.self && session.parentPid === foreign.pid);
		assert.ok(self && other, JSON.stringify(result));
		assert.equal(self!.parentPid, process.pid);
		assert.deepEqual(self!.sessionIds, ["self-session"]);
		assert.deepEqual(self!.worktrees.map((entry) => [entry.binding, entry.path, entry.holderPid]), [["bound", lease.root, lease.holderPid]]);
		assert.deepEqual(other!.worktrees.map((entry) => [entry.binding, entry.identity, entry.parent]), [["missing", lockIdentity("/work/foreign"), "live"]]);
		assert.equal(lease.alive, true);
	} finally {
		foreign.stdin.end();
		await new Promise<void>((resolve) => foreign.once("close", () => resolve()));
		if (lease.kind === "held") await lease.release();
		await cleanup();
	}
});
