import assert from "node:assert/strict";
import test from "node:test";
import { restoreSelection, selectionEntries } from "./selection.ts";

const entry = (data: unknown) => ({ type: "custom", customType: "session-mode", data });
test("restores legacy modes and defaults a fresh session to cwd implementation", () => {
	assert.deepEqual(restoreSelection([]).selection, { mode: "implement", scope: { kind: "cwd" } });
	assert.deepEqual(restoreSelection([entry({ version: 1, mode: "plan" })]).selection, { mode: "plan" });
	assert.deepEqual(restoreSelection([entry({ version: 1, mode: "implement" })]).selection, { mode: "implement", scope: { kind: "cwd" } });
});
test("scoped checkpoints restore on new versions and safely appear as plan to v1", () => {
	const selection = { mode: "implement", scope: { kind: "roots", roots: ["/api", "/web"], originCwd: "/workspace" } } as const;
	const records = selectionEntries(selection);
	assert.deepEqual(records[0], { version: 1, mode: "plan" });
	assert.deepEqual(restoreSelection(records.map(entry)).selection, selection);
	assert.equal(records.filter((value) => value.version === 1).at(-1)?.mode, "plan");
	assert.deepEqual(restoreSelection([...records.map(entry), ...selectionEntries({ mode: "plan" }).map(entry)]).selection, { mode: "plan" });
});
test("malformed newest scope never revives an older implement entry", () => {
	for (const data of [
		{ version: 99, mode: "implement" },
		{ version: 2, mode: "implement", scope: { kind: "roots", roots: [], originCwd: "/workspace" } },
		{ version: 2, mode: "implement", scope: { kind: "roots", roots: ["relative"], originCwd: "/workspace" } },
		{ version: 2, mode: "implement", scope: { kind: "roots", roots: ["/api", "/api"], originCwd: "/workspace" } },
		{ version: 2, mode: "implement", scope: { kind: "cwd", roots: ["/api"] } },
		null,
	]) {
		const restored = restoreSelection([entry({ version: 1, mode: "implement" }), entry(data)]);
		assert.equal(restored.invalid, true);
		assert.deepEqual(restored.selection, { mode: "plan" });
	}
});
