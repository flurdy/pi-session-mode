import assert from "node:assert/strict";
import test from "node:test";
import { guardedToolBlockReason } from "./policy.ts";

const helper = "~/.agents/skills/release-manager/scripts/release-state";
const hash = "9aab34e3d6ed461b27917d486369768102c33605ee18b4575b10196d39d2c206";
const update = (owner = "manager", expect = hash, patch = '{"rolloutWatch":{"admin":null,"registration":null}}') =>
	`${helper} update --owner ${owner} --expect ${expect} --patch '${patch}'`;
const blocked = (command: string) => guardedToolBlockReason("bash", { command }) ?? "";

test("exact release-state updates need no source lease in guarded states", () => {
	for (const command of [
		update(),
		update("manager", hash, '{"quietStreak":0}'),
		update("maintenance", hash, '{"rolloutWatch":{"admin":null}}'),
		update("manager", "missing", '{"deferred":{"admin":{"note":"rm, git push and npm install are text; it\\u0027s data"}}}'),
		update("manager", hash, '{"note":"$(touch x) `id` ; > /tmp/x"}'),
	]) {
		for (const allowNativeWrites of [false, true]) {
			assert.equal(guardedToolBlockReason("bash", { command }, { allowNativeWrites }), undefined, command);
		}
		assert.equal(guardedToolBlockReason("multi_tool_use.parallel", {
			tool_uses: [{ recipient_name: "functions.bash", parameters: { command } }],
		}), undefined, command);
	}
});

test("other release-state verbs keep the generic bounded check", () => {
	assert.equal(blocked(`${helper} read`), "");
	assert.equal(blocked(`${helper} begin-publication --service admin --sha ${"0".repeat(40)} --session s1 --deploying --expect ${hash}`), "");
	assert.match(blocked(`${helper} read; touch source.ts`), /obvious source, Git, package/);
	assert.match(blocked("patch -p1 < fix.diff"), /obvious source, Git, package/);
});

test("non-exact release-state updates are refused with the exact shape", () => {
	for (const command of [
		update().replace(helper, "/home/user/.agents/skills/release-manager/scripts/release-state"),
		update().replace(helper, "/tmp/release-state"),
		`PYTHONDONTWRITEBYTECODE=1 ${update()}`,
		`env ${update()}`,
		`python3 ${update()}`,
		`bash -lc "${update().replaceAll("'", "\\'")}"`,
		update("admin"),
		update("manager", "abc123"),
		update().replace("--patch '", "--patch='"),
		update().replace(/'(.*)'$/, '"$1"'),
		update("manager", hash, `{"note":"it's"}`),
		update("manager", hash, '{"a":1}\n{"b":2}'),
		update("manager", hash, '{"a":"\x01"}'),
		update("manager", hash, '{"a":"\x1f"}'),
		update("manager", hash, '{"a":"\x7f"}'),
		`${update()};`,
		`${update()} &`,
		`${update()} --output /tmp/state`,
		`${update()} > /tmp/state`,
		`${update()}; touch source.ts`,
		`${update()} && git push`,
		`${update()} | tee /tmp/state`,
		`${update()}\ntouch source.ts`,
		update().replace(" --owner", "  --owner"),
	]) {
		const reason = blocked(command);
		assert.match(reason, /release-state updates are eligible only as the exact documented command/, command);
		assert.doesNotMatch(reason, /use \/implement|need \/implement/i, command);
	}
});

test("an exact update does not exempt a blocked parallel sibling", () => {
	const reason = guardedToolBlockReason("multi_tool_use.parallel", {
		tool_uses: [
			{ recipient_name: "functions.bash", parameters: { command: update() } },
			{ recipient_name: "functions.bash", parameters: { command: "touch source.ts" } },
		],
	}) ?? "";
	assert.match(reason, /nested call 2 blocked/);
	assert.match(reason, /obvious source, Git, package/);
});

test("parallel wrappers report a nested non-exact release-state update", () => {
	const reason = guardedToolBlockReason("multi_tool_use.parallel", {
		tool_uses: [{ recipient_name: "functions.bash", parameters: { command: `${update()}; touch source.ts` } }],
	}) ?? "";
	assert.match(reason, /nested call 1/);
	assert.match(reason, /release-state updates are eligible only/);
});
