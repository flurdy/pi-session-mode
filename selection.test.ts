import assert from "node:assert/strict";
import test from "node:test";
import { restoreSelection, selectionEntries } from "./selection.ts";
import { restoreSelectionV2 } from "./fixtures/selection-v2.ts";
import { restoreSelectionV3 } from "./fixtures/selection-v3.ts";

const entry = (data: unknown) => ({ type: "custom", customType: "session-mode", data });
test("restores legacy modes and leaves the fresh default to the caller", () => {
	assert.equal(restoreSelection([]), undefined);
	assert.equal(restoreSelection([{ type: "custom", customType: "other", data: {} }]), undefined);
	assert.deepEqual(restoreSelection([entry({ version: 1, mode: "plan" })])?.selection, { mode: "plan" });
	assert.deepEqual(restoreSelection([entry({ version: 1, mode: "implement" })])?.selection, { mode: "implement", scope: { kind: "cwd" } });
});
test("lazy v4 selections restore with and without exact files after a v1 plan checkpoint", () => {
	for (const selection of [
		{ mode: "implement", scope: { kind: "lazy", originCwd: "/workspace" } },
		{ mode: "implement", scope: { kind: "lazy", originCwd: "/workspace" }, files: ["/home/user/a", "/home/user/b"] },
	] as const) {
		const records = selectionEntries(selection);
		assert.deepEqual(records[0], { version: 1, mode: "plan" });
		assert.equal(records[1]?.version, 4);
		assert.equal(records.length, 2);
		assert.deepEqual(restoreSelection(records.map(entry))?.selection, selection);
	}
	assert.equal("files" in selectionEntries({ mode: "implement", scope: { kind: "lazy", originCwd: "/w" }, files: [] })[1]!, false);
});
test("actual v0.5.0 and v0.2.1 readers fail closed to plan on a newest v4 selection", () => {
	for (const selection of [
		{ mode: "implement", scope: { kind: "lazy", originCwd: "/workspace" } },
		{ mode: "implement", scope: { kind: "lazy", originCwd: "/workspace" }, files: ["/home/user/config.json"] },
	] as const) {
		const records = [entry({ version: 2, mode: "implement", scope: { kind: "cwd" } }), ...selectionEntries(selection).map(entry)];
		assert.deepEqual(restoreSelectionV3(records), { selection: { mode: "plan" }, invalid: true });
		assert.deepEqual(restoreSelectionV2(records), { selection: { mode: "plan" }, invalid: true });
		assert.deepEqual(restoreSelectionV3(records.slice(0, 2)).selection, { mode: "plan" }, "the v1 checkpoint precedes the v4 record");
	}
});
test("scoped checkpoints restore on new versions and safely appear as plan to v1", () => {
	const selection = { mode: "implement", scope: { kind: "roots", roots: ["/api", "/web"], originCwd: "/workspace" } } as const;
	const records = selectionEntries(selection);
	assert.deepEqual(records[0], { version: 1, mode: "plan" });
	assert.deepEqual(restoreSelection(records.map(entry))?.selection, selection);
	assert.equal(records.filter((value) => value.version === 1).at(-1)?.mode, "plan");
	assert.deepEqual(restoreSelection([...records.map(entry), ...selectionEntries({ mode: "plan" }).map(entry)])?.selection, { mode: "plan" });
});
test("combined v3 selections restore exact files and remain guarded to v2 readers", () => {
	for (const selection of [
		{ mode: "implement", scope: { kind: "none" }, files: ["/home/user/config.json"] },
		{ mode: "implement", scope: { kind: "cwd" }, files: ["/home/user/config.json"] },
		{ mode: "implement", scope: { kind: "roots", roots: ["/api"], originCwd: "/workspace" }, files: ["/home/user/a", "/home/user/b"] },
	] as const) {
		const records = selectionEntries(selection);
		assert.deepEqual(records[0], { version: 1, mode: "plan" });
		assert.equal(records[1]?.version, 3);
		assert.deepEqual(restoreSelection(records.map(entry))?.selection, selection);
		assert.equal(records.some((record) => record.version === 2), false);
	}
});

test("a frozen v2 reader treats a newest v3 selection as guarded plan", () => {
	const selection = { mode: "implement", scope: { kind: "none" }, files: ["/home/user/config.json"] } as const;
	const records = selectionEntries(selection).map(entry);
	assert.deepEqual(restoreSelectionV2(records), { selection: { mode: "plan" }, invalid: true });
	assert.deepEqual(restoreSelectionV2([entry({ version: 2, mode: "implement", scope: { kind: "cwd" } })]).selection, { mode: "implement", scope: { kind: "cwd" } });
	assert.deepEqual(restoreSelectionV2(selectionEntries({ mode: "implement", scope: { kind: "roots", roots: ["/repo"], originCwd: "/workspace" }, files: ["/file"] }).map(entry)), { selection: { mode: "plan" }, invalid: true });
});

test("malformed newest scope never revives an older implement entry", () => {
	for (const data of [
		{ version: 99, mode: "implement" },
		{ version: 2, mode: "implement", scope: { kind: "roots", roots: [], originCwd: "/workspace" } },
		{ version: 2, mode: "implement", scope: { kind: "roots", roots: ["relative"], originCwd: "/workspace" } },
		{ version: 2, mode: "implement", scope: { kind: "roots", roots: ["/api", "/api"], originCwd: "/workspace" } },
		{ version: 2, mode: "implement", scope: { kind: "cwd", roots: ["/api"] } },
		{ version: 3, mode: "implement", scope: { kind: "none" }, files: [] },
		{ version: 3, mode: "implement", scope: { kind: "none" }, files: ["relative"] },
		{ version: 3, mode: "implement", scope: { kind: "none" }, files: ["/a", "/a"] },
		{ version: 3, mode: "implement", scope: { kind: "none" }, files: Array.from({ length: 33 }, (_, index) => `/file-${index}`) },
		{ version: 3, mode: "implement", scope: { kind: "roots", roots: [], originCwd: "/workspace" }, files: ["/a"] },
		{ version: 3, mode: "implement", scope: { kind: "lazy", originCwd: "/workspace" }, files: ["/a"] },
		{ version: 2, mode: "implement", scope: { kind: "lazy", originCwd: "/workspace" } },
		{ version: 4, mode: "plan" },
		{ version: 4, mode: "implement", scope: { kind: "lazy" } },
		{ version: 4, mode: "implement", scope: { kind: "lazy", originCwd: "relative" } },
		{ version: 4, mode: "implement", scope: { kind: "lazy", originCwd: "/w", roots: ["/a"] } },
		{ version: 4, mode: "implement", scope: { kind: "cwd" } },
		{ version: 4, mode: "implement", scope: { kind: "lazy", originCwd: "/w" }, files: [] },
		{ version: 4, mode: "implement", scope: { kind: "lazy", originCwd: "/w" }, files: ["/a", "/a"] },
		{ version: 4, mode: "implement", scope: { kind: "lazy", originCwd: "/w" }, extra: true },
		null,
	]) {
		const restored = restoreSelection([entry({ version: 1, mode: "implement" }), entry(data)]);
		assert.equal(restored?.invalid, true);
		assert.deepEqual(restored?.selection, { mode: "plan" });
	}
});
