import assert from "node:assert/strict";
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

test("failed lookups and lease changes block the write", async () => {
	assert.ok(await scopedWriteBlockReason("edit", {}, "/cwd", ["/api"]));
	assert.ok(await scopedWriteBlockReason("write", { path: "/api" }, "/cwd", ["/api"], { resolveRoot: async () => { throw new Error("unavailable"); } }));
	assert.match(await scopedWriteBlockReason("write", { path: "/api" }, "/cwd", ["/api"], { resolveRoot, isCurrent: () => false }) ?? "", /changed/);
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
	let nested: unknown = { tool_uses: [call("functions.write", { path: "/api" })] };
	for (let i = 0; i < 5; i++) nested = { tool_uses: [call("multi_tool_use.parallel", nested)] };
	assert.ok(await scopedWriteBlockReason("multi_tool_use.parallel", nested, "/cwd", ["/api"], { resolveRoot }));
});
