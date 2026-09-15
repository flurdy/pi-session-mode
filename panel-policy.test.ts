import assert from "node:assert/strict";
import test from "node:test";
import { guardedToolBlockReason, isObviousMutation } from "./policy.ts";

const panelCommands = [
	"review-panel.sh check --prompt-file existing.md",
	"~/.agents/skills/second-opinion/scripts/review-panel.sh run-local --prompt-file existing.md",
	"'/skill with spaces/review-panel.sh' evaluate --check-file existing.json",
	"bash /skills/review-panel.sh run-local --prompt-file existing.md",
	"/bin/bash --noprofile --norc '/skill with spaces/review-panel.sh' check",
	"env -i HOME=/home/reviewer bash /skills/review-panel.sh run-local",
	"command -- ./review-panel.sh check",
	"exec ./review-panel.sh run-openrouter --configured-consent",
	"openrouter-panel.sh run --confirmed --prompt-file existing.md",
	"env REVIEW_PANEL_CONFIG=/config ./openrouter-panel.sh check",
	"bash -lc 'review-panel.sh run-local --prompt-file existing.md'",
	"printf ready; ./review-panel.sh check",
	"printf ready\n./review-panel.sh check",
	"(./review-panel.sh check)",
];

test("guarded panels fail before dispatch, even with pre-existing prompt files", () => {
	for (const command of panelCommands) {
		for (const allowNativeWrites of [false, true]) {
			const reason = guardedToolBlockReason("bash", { command }, { allowNativeWrites }) ?? "";
			assert.match(reason, /named second-opinion panels are unsupported/i, command);
			assert.doesNotMatch(reason, /switch to \/implement|use \/implement/i);
		}
	}
});

test("panel artifact preparation remains a mutation rather than a temporary-directory exception", () => {
	for (const command of ["mktemp", "mktemp -d", "prompt=$(mktemp)", "chmod 600 /tmp/prompt", "printf prompt > /tmp/prompt", "rm -f /tmp/prompt"]) {
		assert.equal(isObviousMutation(command), true, command);
	}
	assert.ok(guardedToolBlockReason("write", { path: "/tmp/prompt", content: "review" }));
});

test("guarded panel denial preserves direct peer commands and literal discussion", () => {
	for (const command of [
		"claude -p --model opus --permission-mode plan --tools '' 'Read-only question'",
		"claude -p --model fable --permission-mode plan --tools '' 'Read-only question'",
		"codex exec --sandbox read-only 'Read-only question'",
		"rg 'review-panel.sh' skills/second-opinion",
		"head /skills/review-panel.sh",
		"printf '%s' 'review-panel.sh run-local'",
		"bash -lc 'rg review-panel.sh skills'",
	]) assert.equal(guardedToolBlockReason("bash", { command }), undefined, command);
	for (const agent of ["claude-code", "codex-exec", "cursor-agent"]) {
		const options = { readOnlySubagents: new Set([agent]) };
		assert.equal(guardedToolBlockReason("subagent", { agent, task: "Read-only question", async: true }, options), undefined);
		for (const override of [{ cwd: "/other" }, { output: "/tmp/result" }, { worktree: true }, { share: true }, { sessionDir: "/tmp/session" }]) {
			assert.ok(guardedToolBlockReason("subagent", { agent, task: "Read-only question", ...override }, options));
		}
	}
});

test("parallel wrappers cannot hide a panel invocation", () => {
	const reason = guardedToolBlockReason("multi_tool_use.parallel", {
		tool_uses: [{ recipient_name: "functions.bash", parameters: { command: panelCommands[0] } }],
	}) ?? "";
	assert.match(reason, /nested call 1/);
	assert.match(reason, /named second-opinion panels are unsupported/i);
});
