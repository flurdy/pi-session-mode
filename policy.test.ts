import assert from "node:assert/strict";
import test from "node:test";
import { guardedToolBlockReason, isObviousMutation } from "./policy.ts";

test("blocks direct writes while leaving reads available", () => {
	assert.match(guardedToolBlockReason("edit") ?? "", /guarded session/i);
	assert.match(guardedToolBlockReason("write") ?? "", /guarded session/i);
	assert.match(guardedToolBlockReason("powershell") ?? "", /guarded session/i);
	assert.match(guardedToolBlockReason("activate_pi_package") ?? "", /guarded session/i);
	assert.equal(guardedToolBlockReason("read"), undefined);
	assert.equal(guardedToolBlockReason("jira_issue"), undefined);
});

test("permits read-only subagent management and cancellation", () => {
	for (const action of [
		"list",
		"get",
		"models",
		"children.list",
		"guide",
		"validate",
		"status",
		"debug.run",
		"doctor",
		"interrupt",
		"stop",
		"dismiss",
	]) {
		assert.equal(guardedToolBlockReason("subagent", { action }), undefined, action);
	}
});

test("permits only verified direct read-only subagents", () => {
	const options = { readOnlySubagents: new Set(["reviewer", "claude-code"]) };
	assert.equal(guardedToolBlockReason("subagent", { agent: "reviewer", task: "Review" }, options), undefined);
	assert.equal(guardedToolBlockReason("subagent", { agent: "claude-code", task: "Challenge" }, options), undefined);
	assert.match(guardedToolBlockReason("subagent", { agent: "worker", task: "Review" }, options) ?? "", /not verified read-only/i);
	assert.match(guardedToolBlockReason("subagent", { agent: "reviewer", gate: "git status" }, options) ?? "", /host gate/i);
	assert.match(guardedToolBlockReason("subagent", { agent: "reviewer", output: "report.md" }, options) ?? "", /output path/i);
	assert.match(guardedToolBlockReason("subagent", { agent: "reviewer", worktree: true }, options) ?? "", /worktree/i);
	assert.match(guardedToolBlockReason("subagent", { agent: "reviewer", share: true }, options) ?? "", /remote sharing/i);
	assert.match(guardedToolBlockReason("subagent", { agent: "reviewer", cwd: "../other" }, options) ?? "", /cwd/i);
	assert.match(guardedToolBlockReason("subagent", { agent: "reviewer", agentScope: "user" }, options) ?? "", /agent scope/i);
});

test("permits read-only supervisor inspection but blocks messages to children", () => {
	assert.equal(guardedToolBlockReason("subagent_supervisor", { action: "status" }), undefined);
	assert.match(guardedToolBlockReason("subagent_supervisor", { action: "reply", to: "worker", message: "continue" }) ?? "", /guarded session/i);
});

test("blocks writable subagent controls and dynamic workflows", () => {
	for (const input of [
		{ action: "create", agent: "reviewer" },
		{ action: "resume", id: "run-1", message: "continue" },
		{ action: "steer", id: "run-1", message: "edit it" },
		{ workflowScript: "return runs.run('review', { agent: 'reviewer', task: 'Review' })" },
		{ workflowScriptPath: "review.js" },
	]) {
		assert.match(guardedToolBlockReason("subagent", input, { readOnlySubagents: new Set(["reviewer"]) }) ?? "", /guarded session/i);
	}
});

test("permits parallel composites only when every nested call is safe", () => {
	const options = { readOnlySubagents: new Set(["reviewer"]) };
	const safe = {
		tool_uses: [
			{ recipient_name: "functions.read", parameters: { path: "README.md" } },
			{ recipient_name: "functions.web_search", parameters: { query: "Pi extensions" } },
			{ recipient_name: "functions.subagent", parameters: { action: "status", id: "run-1" } },
		],
	};
	assert.equal(guardedToolBlockReason("multi_tool_use.parallel", safe, options), undefined);

	const blocked = {
		tool_uses: [
			...safe.tool_uses,
			{ recipient_name: "functions.subagent", parameters: { agent: "worker", task: "Review" } },
		],
	};
	assert.match(guardedToolBlockReason("multi_tool_use.parallel", blocked, options) ?? "", /nested call 4/i);
	assert.match(guardedToolBlockReason("multi_tool_use.parallel", { tool_uses: "invalid" }, options) ?? "", /malformed/i);
	assert.match(
		guardedToolBlockReason("multi_tool_use.parallel", { tool_uses: [{ recipient_name: "functions.unknown_writer", parameters: {} }] }, options) ?? "",
		/unknown nested tool/i,
	);
});


test("file-only policy permits prevalidated native writes but retains guarded nested mutations", () => {
	const write = { recipient_name: "functions.write", parameters: { path: "/config", content: "value" } };
	assert.equal(guardedToolBlockReason("write", write.parameters, { allowNativeWrites: true }), undefined);
	assert.equal(guardedToolBlockReason("multi_tool_use.parallel", { tool_uses: [write] }, { allowNativeWrites: true }), undefined);
	assert.ok(guardedToolBlockReason("multi_tool_use.parallel", {
		tool_uses: [write, { recipient_name: "functions.bash", parameters: { command: "touch /tmp/outside" } }],
	}, { allowNativeWrites: true }));
});

test("fails closed at the parallel nesting limit", () => {
	let nested: unknown = { recipient_name: "functions.read", parameters: { path: "README.md" } };
	for (let depth = 0; depth < 5; depth += 1) nested = { recipient_name: "multi_tool_use.parallel", parameters: { tool_uses: [nested] } };
	assert.match(
		guardedToolBlockReason("multi_tool_use.parallel", { tool_uses: [nested] }) ?? "",
		/excessively nested/i,
	);
});

test("blocks obvious file, package, Git, and remote Beads mutations", () => {
	for (const command of [
		"rm -f result.txt",
		"printf done > result.txt",
		"cat input >> result.txt",
		"npm install lodash",
		"cargo add serde",
		"sed -i 's/old/new/' file.ts",
		"perl -pi -e 's/old/new/' file.ts",
		"git commit -m done",
		"git switch main",
		"git remote set-url origin elsewhere",
		"git --git-dir=.git --work-tree=. add file.ts",
		"git --git-dir='.git' --work-tree '.' add file.ts",
		"git --no-optional-locks commit -m done",
		"bash -c 'printf owned > tracked.txt'",
		"sh -c \"git commit -m nope\"",
		"bash -lc 'rm -f tracked.txt'",
		"env bash -c 'npm install lodash'",
		"bash --rcfile /tmp/empty -c 'rm -f tracked.txt'",
		"exec 3<>tracked.txt",
		"bd delete ai-tools-1",
		"bd dolt push",
		"bd -C \"/a b\" --json dolt push --remote origin",
		"bd --db=/x dolt pull",
		"bd dolt fetch",
	]) {
		assert.equal(isObviousMutation(command), true, command);
	}
});

test("permits reads and ordinary local Beads triage", () => {
	for (const command of [
		"git status --short",
		"git diff --check",
		"rg session-mode pi",
		"bd -C /tmp/repo show ai-tools-1 --json --readonly",
		"bd -C /tmp/repo create 'Clarify guard' --type task",
		"bd -C /tmp/repo update ai-tools-1 --append-notes note",
		"bd -C /tmp/repo close ai-tools-1",
	]) {
		assert.equal(isObviousMutation(command), false, command);
	}
});

test("permits cross-store local triage with mutation words in quoted prose", () => {
	for (const command of [
		"bd -C /abs/other-store comments add fixture-1 'rm file; git push > out && npm install; delete purge migrate cleanup'",
		"bd -C /abs/other-store create 'Clarify delete and purge' --type task",
		'bd -C /abs/other-store update fixture-1 --append-notes "git commit | tee file; cleanup"',
		"bd -C /abs/other-store close fixture-1 --reason 'Document bash -c commands and source writes'",
	]) {
		assert.equal(guardedToolBlockReason("bash", { command }), undefined, command);
	}
});

test("local triage does not exempt chained or shell-wrapped source and destructive commands", () => {
	for (const command of [
		"bd -C /abs/other-store comments add fixture-1 'note' && git -C /abs/other-store commit -m no",
		"bd -C /abs/other-store update fixture-1 --append-notes 'note'; rm -f tracked.txt",
		"bd -C /abs/other-store close fixture-1; bd -C /abs/other-store delete fixture-2",
		"bd -C /abs/other-store comments add fixture-1 'note' > tracked.txt",
		"bash -c 'bd -C /abs/other-store comments add fixture-1 note && npm install lodash'",
		'sh -lc "bd -C /abs/other-store update fixture-1 --append-notes note; bd purge"',
	]) {
		assert.match(guardedToolBlockReason("bash", { command }) ?? "", /blocked/, command);
	}
});

test("guarded workspace synchronization blocks mutations but permits previews and prose", () => {
	for (const command of [
		"make beads-sync", "gmake -C /workspace beads-sync", "make 'beads-sync'",
		"project-workspace beads-sync --workspace /workspace",
		"env -C /workspace make beads-sync", "command make beads-sync", "exec project-workspace beads-sync",
		"bash -lc 'cd /workspace && make beads-sync'", "make beads-sync-check; make beads-sync",
		"project-workspace beads-sync; echo --dry-run",
	]) assert.match(guardedToolBlockReason("bash", { command }) ?? "", /blocked/, command);
	for (const command of [
		"make beads-sync-check", "project-workspace beads-sync --workspace /workspace --dry-run",
		"echo 'make beads-sync'", "bd -C /store comments add fixture-1 'make beads-sync'",
	]) assert.equal(guardedToolBlockReason("bash", { command }), undefined, command);
});

test("raw Beads remote and destructive commands remain guarded", () => {
	for (const command of [
		"bash -c 'bd -C /abs/other-store dolt fetch'",
		"bd -C /abs/other-store dolt remote add origin file:///tmp/other",
		"bd -C /abs/other-store dolt push --force",
		"bd -C /store federation status --peer origin --readonly",
		"bd --profile federation status --peer origin",
		"bd --json -C '/a b' federation sync --peer origin",
		"bd vc merge 'remote/main'",
		"bd sql \"CALL DOLT_PUSH('--force','origin','main')\"",
		"dolt --data-dir '/a b' push --force origin main",
		"dolt sql -q \"CALL DOLT_FETCH('origin')\"",
		"bash -lc 'bd federation status --peer origin'",
	]) assert.match(guardedToolBlockReason("bash", { command }) ?? "", /blocked/, command);
});

test("mutation diagnostics separate source authority from destructive and remote approval", () => {
	const reason = guardedToolBlockReason("bash", { command: "bd delete fixture-1" }) ?? "";
	assert.match(reason, /\/implement alone does not authorize destructive or remote actions/);
	assert.match(reason, /Local Beads triage needs no source lease/);
	assert.doesNotMatch(reason, /Use \/implement first/);
});

test("does not mistake comparison operators, quoted prose, or read-only shell payloads for mutations", () => {
	for (const command of [
		"test 3 -gt 2",
		"printf '%s\\n' 'render width > 80'",
		"printf '%s\\n' 'bash -c \"rm file\"'",
		"printf '%s\\n' 'git --git-dir=.git add file.ts'",
		"rg 'value >> 2' docs",
		"bash -c 'git status --short'",
		"bash --rcfile /tmp/empty -c 'git status --short'",
	]) {
		assert.equal(isObviousMutation(command), false, command);
	}
});

test("permits exact discard and file-descriptor redirects in read-only diagnostics", () => {
	for (const command of [
		"git worktree list --porcelain 2>/dev/null",
		"bd -C /tmp/repo show ai-tools-1 2> /dev/null",
		"find /tmp -type f 2>/dev/null | sort",
		"ls -ld /run/user/1000/pi-session-guard-1000/*.lock 2>/dev/null",
		"2>/dev/null rg session-mode pi",
		"command -v lslocks >/dev/null && lslocks",
		"printf done 1>/dev/null",
		"printf done &>/dev/null",
		"printf done 2>>/dev/null",
		"printf done 3>/dev/null",
		"printf done >/dev/null 2>&1",
		"printf done 2>&1",
	]) {
		assert.equal(isObviousMutation(command), false, command);
	}
});

test("continues to block real and dynamic redirect targets", () => {
	for (const command of [
		"printf done 2>/dev/null.bak",
		"printf done 2>/dev/null$TARGET",
		"printf done 2>/dev/null~",
		"printf done 2>/tmp/errors.log",
		"printf done &>output.log",
		"printf done 2>&$TARGET",
		"cat input 2>/dev/null > output.txt",
	]) {
		assert.equal(isObviousMutation(command), true, command);
	}
});

test("fails closed when shell payload inspection exceeds its nesting limit", () => {
	let command = "git status --short";
	for (let depth = 0; depth < 5; depth += 1) command = `bash -c ${JSON.stringify(command)}`;
	assert.equal(isObviousMutation(command), true);
});

test("leaves unknown commands outside the bounded policy", () => {
	assert.equal(isObviousMutation("custom-generator --apply"), false);
});
