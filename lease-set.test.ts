import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFileLease, acquireFolderLease, acquireWorktreeLease } from "./lease.ts";
import { LeaseSet } from "./lease-set.ts";
import type { FileLeaseResult, HeldFileLease, HeldFolderLease, HeldWorktreeLease, WorktreeLeaseResult } from "./lease.ts";

function handle(root: string, released: string[]) {
	let lose!: () => void;
	let alive = true;
	const lease: HeldWorktreeLease = {
		kind: "held", root, holderPid: 123,
		get alive() { return alive; },
		lost: new Promise<void>((resolve) => { lose = () => { alive = false; resolve(); }; }),
		async release() { alive = false; released.push(root); },
	};
	return { lease, lose };
}
function fileHandle(file: string, released: string[]) {
	let lose!: () => void;
	let alive = true;
	const lease: HeldFileLease = {
		kind: "held", file, holderPid: 124,
		get alive() { return alive; },
		lost: new Promise<void>((resolve) => { lose = () => { alive = false; resolve(); }; }),
		async release() { alive = false; released.push(file); },
	};
	return { lease, lose };
}
function folderHandle(dir: string, released: string[]) {
	let lose!: () => void;
	let alive = true;
	const lease: HeldFolderLease = {
		kind: "held", dir, holderPid: 125,
		get alive() { return alive; },
		lost: new Promise<void>((resolve) => { lose = () => { alive = false; resolve(); }; }),
		async release() { alive = false; released.push(dir); },
	};
	return { lease, lose };
}
const resolveRoots = async (paths: string[]) => [...new Set(paths)].sort();
const resolveFiles = async (paths: string[]) => [...new Set(paths)].sort();
const resolveFolders = async (paths: string[]) => [...new Set(paths)].sort();
function grantSet(released: string[], acquired: string[] = [], lost: Map<string, () => void> = new Map()) {
	return new LeaseSet(async (root) => handle(root, released).lease, resolveRoots, () => {}, {
		resolveFiles, resolveFolders,
		acquireFile: async (file) => { acquired.push(file); return fileHandle(file, released).lease; },
		acquireFolder: async (dir) => { acquired.push(dir); const value = folderHandle(dir, released); lost.set(dir, value.lose); return value.lease; },
	});
}

test("loss revokes authority at once but keeps remaining holders locked until the loss hold settles", async () => {
	const released: string[] = [];
	let finishHold!: () => void;
	const hold = new Promise<void>((resolve) => { finishHold = resolve; });
	const lostRoot = handle("lost", released);
	const set = new LeaseSet(async (root) => root === "lost" ? lostRoot.lease : handle(root, released).lease, resolveRoots, () => {}, { holdReleaseOnLoss: () => hold });
	assert.equal((await set.add(["kept", "lost"], "/cwd", "session")).kind, "held");
	lostRoot.lose();
	for (let tick = 0; tick < 3; tick++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(set.live, false, "authority is revoked immediately");
	assert.deepEqual(released, [], "remaining holders stay locked while the hold is pending");
	finishHold();
	for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(released.sort(), ["kept", "lost"]);
	assert.deepEqual(set.roots, []);
});

test("held folders cover contained grants; a folder containing a held grant is refused before acquisition", async () => {
	const released: string[] = [], acquired: string[] = [];
	const set = grantSet(released, acquired);
	assert.equal((await set.addScopes({ worktrees: { kind: "none" }, files: ["/s/a/x", "/t/y"], folders: ["/s/a", "/s/a/b"] }, "/cwd", "session")).kind, "held");
	assert.deepEqual(acquired, ["/t/y", "/s/a"], "contained file and folder requests are covered, not acquired");
	assert.deepEqual(set.folders, ["/s/a"]);
	assert.deepEqual(set.files, ["/t/y"]);
	acquired.length = 0;
	assert.equal((await set.addScopes({ worktrees: { kind: "none" }, files: ["/s/a/z"], folders: ["/s/a/c"] }, "/cwd", "session")).kind, "held");
	assert.deepEqual(acquired, []);
	for (const folder of ["/t", "/s"]) {
		const refused = await set.addScopes({ worktrees: { kind: "none" }, files: [], folders: [folder] }, "/cwd", "session");
		assert.equal(refused.kind, "invalid");
		if (refused.kind === "invalid") assert.match(refused.detail, /revoke/i);
	}
	assert.deepEqual(acquired, []);
	const bounded = await set.addScopes({ worktrees: { kind: "none" }, files: [], folders: Array.from({ length: 16 }, (_, index) => `/f${index}`) }, "/cwd", "session");
	assert.equal(bounded.kind, "invalid", "held plus requested folders exceed the folder bound");
	await set.releaseAll();
});

test("selective grant release keeps remaining grants and worktrees, and folder loss revokes the set", async () => {
	const released: string[] = [], lost = new Map<string, () => void>();
	const set = grantSet(released, [], lost);
	assert.equal((await set.addScopes({ worktrees: { kind: "paths", paths: ["repo"] }, files: ["/x", "/y"], folders: ["/d", "/e"] }, "/cwd", "session")).kind, "held");
	const revision = set.revision;
	await set.releaseGrants(["/x", "/d"]);
	assert.ok(set.revision > revision);
	assert.deepEqual(released.sort(), ["/d", "/x"]);
	assert.deepEqual([set.roots, set.files, set.folders], [["repo"], ["/y"], ["/e"]]);
	assert.equal(set.live, true);
	await set.releaseGrants();
	assert.deepEqual([set.roots, set.files, set.folders], [["repo"], [], []]);
	assert.equal((await set.addScopes({ worktrees: { kind: "none" }, files: [], folders: ["/g"] }, "/cwd", "session")).kind, "held");
	lost.get("/g")!();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(set.live, false);
	assert.deepEqual([set.roots, set.files, set.folders], [[], [], []]);
	await set.releaseAll();
});

test("real sessions: contained grants block covering folders across sessions, and folders reacquire after revocation", async () => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "lease-set-folders-")));
	const root = join(base, "tree"), runtimeDir = join(base, "runtime");
	const options = {
		acquireFile: (file: string, value: { sessionId: string; signal: AbortSignal; expectedFile?: string }) => acquireFileLease(file, { ...value, runtimeDir }),
		acquireFolder: (dir: string, value: { sessionId: string; signal: AbortSignal; expectedDir?: string }) => acquireFolderLease(dir, { ...value, runtimeDir }),
		resolveFolders,
	};
	const a = new LeaseSet(undefined, undefined, undefined, options), b = new LeaseSet(undefined, undefined, undefined, options);
	try {
		await mkdir(join(root, "store", "inner"), { recursive: true });
		assert.equal((await a.addScopes({ worktrees: { kind: "none" }, files: [join(root, "store", "inner", "x.json")], folders: [] }, root, "a")).kind, "held");
		assert.equal((await b.addScopes({ worktrees: { kind: "none" }, files: [], folders: [join(root, "store")] }, root, "b")).kind, "contended");
		assert.equal((await b.addScopes({ worktrees: { kind: "none" }, files: [], folders: [join(root, "other")] }, root, "b")).kind, "held");
		assert.equal((await a.addScopes({ worktrees: { kind: "none" }, files: [], folders: [join(root, "store")] }, root, "a")).kind, "invalid");
		await a.releaseGrants();
		assert.equal((await b.addScopes({ worktrees: { kind: "none" }, files: [], folders: [join(root, "store")] }, root, "b")).kind, "held");
		assert.equal((await a.addScopes({ worktrees: { kind: "none" }, files: [join(root, "store", "inner", "x.json")], folders: [] }, root, "a")).kind, "contended");
	} finally { await a.releaseAll(); await b.releaseAll(); await rm(base, { recursive: true, force: true }); }
});

test("mixed additions publish atomically and retain prior scopes on failure", async () => {
	const released: string[] = [];
	const set = new LeaseSet(
		async (root) => handle(root, released).lease,
		resolveRoots,
		() => {},
		{
			acquireFile: async (file): Promise<FileLeaseResult> => file === "/blocked" ? { kind: "contended", file } : fileHandle(file, released).lease,
			resolveFiles,
		},
	);
	assert.equal((await set.addFiles(["/kept"], "/cwd", "session")).kind, "held");
	let published = false;
	const failed = await set.addScopes(
		{ worktrees: { kind: "paths", paths: ["repo"] }, files: ["/blocked"] },
		"/cwd", "session", () => { published = true; },
	);
	assert.equal(failed.kind, "contended");
	assert.equal(published, false);
	assert.deepEqual(set.roots, []);
	assert.deepEqual(set.files, ["/kept"]);
	assert.deepEqual(released, ["repo"]);
	await set.releaseAll();
});

test("file loss revokes mixed authority and each scope kind has an independent bound", async () => {
	const released: string[] = [];
	const lostFile = fileHandle("file-0", released);
	const set = new LeaseSet(
		async (root) => handle(root, released).lease,
		resolveRoots,
		() => {},
		{
			acquireFile: async (file) => file === "file-0" ? lostFile.lease : fileHandle(file, released).lease,
			resolveFiles,
		},
	);
	assert.equal((await set.addScopes(
		{ worktrees: { kind: "paths", paths: Array.from({ length: 32 }, (_, index) => `root-${index}`) }, files: Array.from({ length: 32 }, (_, index) => `file-${index}`) },
		"/cwd", "session",
	)).kind, "held");
	assert.equal((await set.add(["root-32"], "/cwd", "session")).kind, "invalid");
	assert.equal((await set.addFiles(["file-32"], "/cwd", "session")).kind, "invalid");
	lostFile.lose();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(set.live, false);
	assert.deepEqual(set.roots, []);
	assert.deepEqual(set.files, []);
	await set.releaseAll();
});

test("changed restored file identities are rejected before acquisition", async () => {
	let acquired = 0;
	const set = new LeaseSet(
		async (root) => handle(root, []).lease,
		resolveRoots,
		() => {},
		{ acquireFile: async (file) => { acquired++; return fileHandle(file, []).lease; }, resolveFiles: async () => ["changed"] },
	);
	const result = await set.addScopes(
		{ worktrees: { kind: "none" }, files: ["saved"] },
		"/cwd", "session", undefined, { roots: [], files: ["saved"] },
	);
	assert.equal(result.kind, "invalid");
	assert.equal(acquired, 0);
	await set.releaseAll();
});

test("cancellation drains a late file acquisition without publishing it", async () => {
	const released: string[] = [];
	let finish!: (result: FileLeaseResult) => void;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	const set = new LeaseSet(async (root) => handle(root, released).lease, resolveRoots, () => {}, {
		resolveFiles,
		acquireFile: () => { started(); return new Promise((resolve) => { finish = resolve; }); },
	});
	const adding = set.addFiles(["/file"], "/cwd", "session");
	await ready;
	const drain = set.releaseAll();
	finish(fileHandle("/file", released).lease);
	assert.equal((await adding).kind, "cancelled");
	await drain;
	assert.deepEqual(set.files, []);
	assert.deepEqual(released, ["/file"]);
});

test("failed mixed checkpoint releases only the new file and root handles", async () => {
	const released: string[] = [];
	const set = new LeaseSet(async (root) => handle(root, released).lease, resolveRoots, () => {}, {
		resolveFiles, acquireFile: async (file) => fileHandle(file, released).lease,
	});
	await set.addFiles(["/kept"], "/cwd", "session");
	const result = await set.addScopes({ worktrees: { kind: "paths", paths: ["/root"] }, files: ["/new"] }, "/cwd", "session", () => { throw new Error("checkpoint failed"); });
	assert.equal(result.kind, "invalid");
	assert.deepEqual(set.roots, []);
	assert.deepEqual(set.files, ["/kept"]);
	assert.deepEqual(released.sort(), ["/new", "/root"]);
	await set.releaseAll();
});

test("an external tool abort cancels acquisition while retaining prior scopes", async () => {
	const released: string[] = [];
	let start!: () => void, finish!: (value: WorktreeLeaseResult) => void;
	let received: AbortSignal | undefined;
	const ready = new Promise<void>((resolve) => { start = resolve; });
	const set = new LeaseSet(async (root, options) => {
		if (root === "old") return handle(root, released).lease;
		received = options.signal; start();
		return new Promise((resolve) => { finish = resolve; });
	}, resolveRoots);
	await set.add(["old"], "/cwd", "session");
	const abort = new AbortController();
	const pending = set.addScopes({ worktrees: { kind: "paths", paths: ["new"] }, files: [] }, "/cwd", "session", undefined, undefined, abort.signal);
	await ready;
	abort.abort();
	try { assert.equal(received?.aborted, true); }
	finally { finish(handle("new", released).lease); await pending; await set.releaseAll(); }
	assert.equal((await pending).kind, "cancelled");
	assert.deepEqual(released, ["new", "old"]);
});

test("an obsolete rejected loss notification cannot invalidate a later held set", async () => {
	const released: string[] = [];
	let rejectOld!: (error: Error) => void;
	const old = handle("a", released).lease;
	old.lost = new Promise<void>((_, reject) => { rejectOld = reject; });
	const set = new LeaseSet(async (root) => root === "a" ? old : handle(root, released).lease, resolveRoots);
	await set.add(["a"], "/cwd", "session");
	await set.releaseAll();
	await set.add(["b"], "/cwd", "session");
	rejectOld(new Error("obsolete observer"));
	await new Promise((resolve) => setImmediate(resolve));
	try { assert.deepEqual(set.roots, ["b"]); }
	finally { await set.releaseAll(); }
});

test("real disjoint sessions and canonical aliases preserve cross-frame exclusion", async () => {
	const root = await mkdtemp(join(tmpdir(), "lease-set-real-"));
	const runtimeDir = join(root, "runtime");
	const acquire = (path: string, options: { sessionId: string; signal: AbortSignal }) => acquireWorktreeLease(path, { ...options, runtimeDir });
	const a = new LeaseSet(acquire), b = new LeaseSet(acquire);
	try {
		for (const name of ["api", "web"]) {
			await mkdir(join(root, name));
			execFileSync("git", ["-C", join(root, name), "init", "-q", "-b", "main"]);
		}
		await symlink(join(root, "api"), join(root, "alias"));
		assert.equal((await a.add(["api", "alias"], root, "a")).kind, "held");
		assert.equal((await b.add(["web"], root, "b")).kind, "held");
		assert.equal((await a.add(["web"], root, "a")).kind, "contended");
		assert.equal((await b.add(["alias"], root, "b")).kind, "contended");
		assert.deepEqual(a.roots, [join(root, "api")]);
		assert.deepEqual(b.roots, [join(root, "web")]);
		assert.equal((await acquireWorktreeLease(join(root, "api"), { runtimeDir })).kind, "contended");
	} finally { await a.releaseAll(); await b.releaseAll(); await rm(root, { recursive: true, force: true }); }
});

test("failed rollback cleanup revokes prior authority and blocks new acquisitions", async () => {
	let acquired = 0;
	const set = new LeaseSet(async (root) => {
		acquired++;
		if (root === "c") return { kind: "contended", root };
		const value = handle(root, []).lease;
		if (root === "b") value.release = async () => { throw new Error("rollback failed"); };
		return value;
	}, resolveRoots);
	await set.add(["a"], "/cwd", "session");
	await assert.rejects(set.add(["b", "c"], "/cwd", "session"), /rollback failed/);
	assert.equal(set.live, false);
	assert.equal((await set.add(["d"], "/cwd", "session")).kind, "invalid");
	assert.equal(acquired, 3);
	await assert.rejects(set.releaseAll(), /rollback failed/);
});

test("a failed drain is not treated as permission for a new acquisition", async () => {
	let acquired = 0;
	const set = new LeaseSet(async (root) => {
		acquired++;
		return { ...handle(root, []).lease, release: async () => { throw new Error("release failed"); } };
	}, resolveRoots);
	await set.add(["a"], "/cwd", "session");
	await assert.rejects(set.releaseAll(), /release failed/);
	assert.equal((await set.add(["b"], "/cwd", "session")).kind, "invalid");
	assert.equal(acquired, 1);
	await assert.rejects(set.releaseAll(), /release failed/);
});

test("changed restored roots are rejected before any acquisition", async () => {
	let acquired = 0;
	const set = new LeaseSet(async (root) => { acquired++; return handle(root, []).lease; }, async () => ["other"]);
	const result = await set.add(["original"], "/cwd", "session", undefined, ["original"]);
	try { assert.equal(result.kind, "invalid"); assert.equal(acquired, 0); }
	finally { await set.releaseAll(); }
});

test("a failed pre-publication checkpoint rolls back only new acquisitions", async () => {
	const released: string[] = [];
	const set = new LeaseSet(async (root) => handle(root, released).lease, resolveRoots);
	await set.add(["a"], "/cwd", "session");
	const result = await set.add(["b"], "/cwd", "session", () => { throw new Error("checkpoint failed"); });
	try {
		assert.equal(result.kind, "invalid");
		assert.deepEqual(set.roots, ["a"]);
		assert.deepEqual(released, ["b"]);
	} finally { await set.releaseAll(); }
});

test("additions are atomic and failed additions retain prior roots", async () => {
	const released: string[] = [], requested: string[] = [];
	const set = new LeaseSet(async (root) => {
		requested.push(root);
		return root === "c" ? { kind: "contended", root } : handle(root, released).lease;
	}, resolveRoots);
	assert.equal((await set.add(["a"], "/cwd", "session")).kind, "held");
	assert.equal((await set.add(["c", "b", "a"], "/cwd", "session")).kind, "contended");
	assert.deepEqual(requested, ["a", "b", "c"]);
	assert.deepEqual(set.roots, ["a"]);
	assert.deepEqual(released, ["b"]);
	await set.releaseAll();
	assert.deepEqual(released, ["b", "a"]);
});

test("release-all drains a late successful acquisition without publishing it", async () => {
	const released: string[] = [];
	let resolveAcquire!: (result: WorktreeLeaseResult) => void;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	const set = new LeaseSet(async () => { started(); return new Promise((resolve) => { resolveAcquire = resolve; }); }, resolveRoots);
	const adding = set.add(["a"], "/cwd", "session");
	await ready;
	const drain = set.releaseAll();
	resolveAcquire(handle("a", released).lease);
	assert.equal((await adding).kind, "cancelled");
	await drain;
	assert.deepEqual(set.roots, []);
	assert.deepEqual(released, ["a"]);
});

test("loss of a prior root cancels an addition and drains the entire set", async () => {
	const released: string[] = [];
	const first = handle("a", released);
	let resolveAcquire!: (result: WorktreeLeaseResult) => void;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	let losses = 0;
	const set = new LeaseSet(async (root) => {
		if (root === "a") return first.lease;
		started(); return new Promise((resolve) => { resolveAcquire = resolve; });
	}, resolveRoots, () => { losses++; });
	await set.add(["a"], "/cwd", "session");
	const adding = set.add(["b"], "/cwd", "session");
	await ready;
	first.lose();
	await Promise.resolve();
	assert.equal(losses, 1);
	assert.deepEqual(set.roots, []);
	resolveAcquire(handle("b", released).lease);
	assert.equal((await adding).kind, "cancelled");
	await set.releaseAll();
	assert.deepEqual(released.sort(), ["a", "b"]);
});

test("same requests share an operation, different concurrent requests do not", async () => {
	const released: string[] = [];
	let resolveAcquire!: (result: WorktreeLeaseResult) => void;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	const set = new LeaseSet(async () => { started(); return new Promise((resolve) => { resolveAcquire = resolve; }); }, resolveRoots);
	const first = set.add(["a"], "/cwd", "session");
	assert.equal(set.add(["a"], "/cwd", "session"), first);
	assert.equal((await set.add(["b"], "/cwd", "session")).kind, "busy");
	await ready;
	resolveAcquire(handle("a", released).lease);
	await first;
	await set.releaseAll();
});

test("acquisition deadline cancels the operation and retains old roots", async () => {
	const released: string[] = [];
	const set = new LeaseSet(async (root, options) => {
		if (root === "a") return handle(root, released).lease;
		return new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve({ kind: "unguarded", reason: "lease-error" }), { once: true }));
	}, resolveRoots, () => {}, { timeoutMs: 20 });
	await set.add(["a"], "/cwd", "session");
	assert.equal((await set.add(["b"], "/cwd", "session")).kind, "cancelled");
	assert.deepEqual(set.roots, ["a"]);
	await set.releaseAll();
});

test("rejects the whole oversized set and already-dead handles", async () => {
	const released: string[] = [];
	let calls = 0;
	const set = new LeaseSet(async (root) => { calls++; return handle(root, released).lease; }, resolveRoots);
	assert.equal((await set.add(Array.from({ length: 33 }, (_, i) => `root-${i}`), "/cwd", "session")).kind, "invalid");
	assert.equal(calls, 0);
	const dead = handle("dead", released); dead.lose();
	const other = new LeaseSet(async () => dead.lease, resolveRoots);
	assert.equal((await other.add(["dead"], "/cwd", "session")).kind, "cancelled");
	assert.deepEqual(other.roots, []);
	await other.releaseAll();
});

test("worktree-only release keeps file leases, bumps the revision and drains a pending addition", async () => {
	const released: string[] = [];
	let lostCalls = 0;
	let finishLate!: (result: WorktreeLeaseResult) => void;
	const set = new LeaseSet(
		async (root) => root === "late" ? new Promise<WorktreeLeaseResult>((resolve) => { finishLate = resolve; }) : handle(root, released).lease,
		resolveRoots,
		() => { lostCalls++; },
		{ acquireFile: async (file) => fileHandle(file, released).lease, resolveFiles },
	);
	assert.equal((await set.addScopes({ worktrees: { kind: "paths", paths: ["api", "web"] }, files: ["/config"] }, "/cwd", "session")).kind, "held");
	const revision = set.revision;
	const pending = set.add(["late"], "/cwd", "session");
	await new Promise((resolve) => setImmediate(resolve));
	const draining = set.releaseWorktrees();
	assert.deepEqual(set.roots, []);
	assert.deepEqual(set.files, ["/config"]);
	assert.ok(set.revision > revision);
	finishLate(handle("late", released).lease);
	assert.equal((await pending).kind, "cancelled");
	await draining;
	assert.deepEqual(released.sort(), ["api", "late", "web"]);
	assert.equal(set.live, true, "the remaining file lease keeps the set live");
	assert.equal(lostCalls, 0, "intentional release is not loss");
	assert.equal((await set.add(["api"], "/cwd", "session")).kind, "held", "released roots can be reacquired");
	await set.releaseAll();
	assert.deepEqual(released.filter((value) => value === "/config"), ["/config"]);
});

test("worktree-only release of a root-only set leaves no live authority", async () => {
	const released: string[] = [];
	const set = new LeaseSet(async (root) => handle(root, released).lease, resolveRoots);
	assert.equal((await set.add(["api"], "/cwd", "session")).kind, "held");
	await set.releaseWorktrees();
	assert.equal(set.live, false);
	assert.equal(set.lost, false);
	assert.deepEqual(released, ["api"]);
});
