import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { guardedToolBlockReason } from "./policy.ts";
import { join } from "node:path";
import test from "node:test";
import { scopedWriteBlockReason } from "./scoped-policy.ts";
import { parseRootArguments, normalizeToolPath } from "./scope.ts";

const resolveRoot = async (path: unknown) => String(path);

test("native writes require exact root membership while reads and shell remain outside this checker", async () => {
	assert.equal(await scopedWriteBlockReason("write", { path: "/api" }, "/cwd", ["/api"], { resolveRoot }), undefined);
	assert.match(await scopedWriteBlockReason("edit", { path: "/api/nested" }, "/cwd", ["/api"], { resolveRoot }) ?? "", /\/implement/);
	assert.ok(await scopedWriteBlockReason("write", { path: "/api" }, "/cwd", [], { resolveRoot }));
	assert.equal(await scopedWriteBlockReason("read", { path: "/outside" }, "/cwd", []), undefined);
	assert.equal(await scopedWriteBlockReason("bash", { command: "arbitrary-script" }, "/cwd", []), undefined);
});

test("missing-scope guidance round-trips unusual literal roots", async () => {
	for (const root of ["/repo\r", "/repo\u009b", "/repo\u00a0", "/repo\u202f", "/repo"]) {
		const reason = await scopedWriteBlockReason("write", { path: root }, "/cwd", [], { resolveRoot });
		const argument = reason!.split("/implement ")[1]!.split(" while idle")[0]!;
		assert.equal(normalizeToolPath(parseRootArguments(argument)[0], "/cwd"), root);
	}
});

test("exact file grants canonicalize native paths and reject ungranted non-repository writes", async () => {
	const granted = { path: "/alias", content: "value" };
	const fileOptions = {
		resolveRoot: async () => { throw new Error("not a worktree"); },
		resolveFile: async (path: unknown) => path === "/alias" ? "/config/settings.json" : String(path),
		files: ["/config/settings.json"],
	};
	assert.equal(await scopedWriteBlockReason("write", granted, "/cwd", [], fileOptions), undefined);
	assert.equal(granted.path, "/config/settings.json");
	assert.match(await scopedWriteBlockReason("edit", { path: "/other" }, "/cwd", [], fileOptions) ?? "", /\/grant-file/);
});

test("granted files are revalidated against later hardlinks and Git markers", async () => {
	const root = await mkdtemp(join(tmpdir(), "grant-policy-"));
	const file = join(root, "settings.json");
	try {
		await writeFile(file, "{}\n");
		assert.equal(await scopedWriteBlockReason("write", { path: file }, root, [], { files: [file] }), undefined);
		await link(file, join(root, "hardlink"));
		assert.ok(await scopedWriteBlockReason("write", { path: file }, root, [], { files: [file] }));
		await rm(join(root, "hardlink"));
		await writeFile(join(root, ".git"), "gitdir: unavailable\n");
		assert.ok(await scopedWriteBlockReason("write", { path: file }, root, [], { files: [file] }));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("canonical grant arguments preserve unusual whitespace through the real native write tool", async () => {
	const root = await mkdtemp(join(tmpdir(), "grant-native-path-"));
	try {
		const file = join(root, "settings\u00a0.json");
		const input = { path: pathToFileURL(file).href, content: "value" };
		assert.equal(await scopedWriteBlockReason("write", input, root, [], { files: [file] }), undefined);
		let written = "";
		const tool = createWriteToolDefinition(root, { operations: {
			mkdir: async () => {}, writeFile: async (path) => { written = path; },
		} });
		await tool.execute("write-unusual", input, undefined, undefined, { cwd: root } as never);
		assert.equal(written, file);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("the supported parallel wrapper contract dispatches canonical file writes through real Pi tools", async () => {
	const root = await mkdtemp(join(tmpdir(), "grant-native-parallel-"));
	try {
		await mkdir(join(root, "config"));
		await symlink(join(root, "config"), join(root, "alias"));
		const file = join(root, "config", "new.json");
		const first = { recipient_name: "functions.write", parameters: { path: join(root, "alias", "new.json"), content: "first" } };
		const second = { recipient_name: "functions.write", parameters: { path: file, content: "second" } };
		const input = { tool_uses: [first, second] };
		assert.equal(await scopedWriteBlockReason("multi_tool_use.parallel", input, root, [], { files: [file] }), undefined);
		assert.equal(guardedToolBlockReason("multi_tool_use.parallel", input, { allowNativeWrites: true }), undefined);
		assert.equal(first.parameters.path, second.parameters.path);
		const write = createWriteToolDefinition(root);
		await Promise.all(input.tool_uses.map((call, index) => write.execute(`write-${index}`, call.parameters, undefined, undefined, { cwd: root } as never)));
		assert.equal(await readFile(file, "utf8"), "second");
		const edit = { path: join(root, "alias", "new.json"), edits: [{ oldText: "second", newText: "edited" }] };
		assert.equal(await scopedWriteBlockReason("edit", edit, root, [], { files: [file] }), undefined);
		await createEditToolDefinition(root).execute("edit", edit, undefined, undefined, { cwd: root } as never);
		assert.equal(await readFile(file, "utf8"), "edited");
		second.parameters.path = join(root, "ungranted");
		assert.ok(await scopedWriteBlockReason("multi_tool_use.parallel", input, root, [], { files: [file] }));
		assert.equal(await readFile(file, "utf8"), "edited");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("failed lookups and lease changes block the write", async () => {
	assert.ok(await scopedWriteBlockReason("edit", {}, "/cwd", ["/api"]));
	assert.ok(await scopedWriteBlockReason("write", { path: "/api" }, "/cwd", ["/api"], { resolveRoot: async () => { throw new Error("unavailable"); } }));
	assert.match(await scopedWriteBlockReason("write", { path: "/api" }, "/cwd", ["/api"], { resolveRoot, isCurrent: () => false }) ?? "", /changed/);
	assert.match(await scopedWriteBlockReason("write", { path: "/config" }, "/cwd", [], {
		resolveRoot: async () => { throw new Error("not a worktree"); },
		resolveFile: async () => "/config",
		files: ["/config"],
		isCurrent: () => false,
	}) ?? "", /changed/);
});

test("parallel writes are checked recursively without widening guarded-mode permissions", async () => {
	const call = (name: string, parameters: unknown) => ({ recipient_name: name, parameters });
	const input = { tool_uses: [call("functions.write", { path: "/api" }), call("functions.read", { path: "/other" })] };
	assert.equal(await scopedWriteBlockReason("multi_tool_use.parallel", input, "/cwd", ["/api"], { resolveRoot }), undefined);
	input.tool_uses.push(call("functions.edit", { path: "/other" }));
	assert.ok(await scopedWriteBlockReason("multi_tool_use.parallel", input, "/cwd", ["/api"], { resolveRoot }));
	for (const invalid of [{}, { tool_uses: [] }, { tool_uses: [call("unknown-wrapper", {})] }]) {
		assert.ok(await scopedWriteBlockReason("multi_tool_use.parallel", invalid, "/cwd", ["/api"]));
	}
	const fileInput = { tool_uses: [call("functions.write", { path: "/alias" }), call("functions.write", { path: "/api" })] };
	assert.equal(await scopedWriteBlockReason("multi_tool_use.parallel", fileInput, "/cwd", ["/api"], {
		resolveRoot: async (path) => { if (path === "/api") return "/api"; throw new Error("not a worktree"); },
		resolveFile: async () => "/config",
		files: ["/config"],
	}), undefined);
	assert.equal((fileInput.tool_uses[0]!.parameters as { path: string }).path, "/config");
	let nested: unknown = { tool_uses: [call("functions.write", { path: "/api" })] };
	for (let i = 0; i < 5; i++) nested = { tool_uses: [call("multi_tool_use.parallel", nested)] };
	assert.ok(await scopedWriteBlockReason("multi_tool_use.parallel", nested, "/cwd", ["/api"], { resolveRoot }));
});
