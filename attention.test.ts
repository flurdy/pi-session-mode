import assert from "node:assert/strict";
import test from "node:test";
import { APPROVAL_WAIT_MS, attendedConfirm, ringTerminalBell } from "./attention.ts";

type ConfirmOptions = { timeout?: number; signal?: AbortSignal };
function dialogContext(answer: (options: ConfirmOptions) => Promise<boolean>, mode = "tui") {
	const calls: ConfirmOptions[] = [];
	const ctx = { mode, ui: { confirm: async (_title: string, _message: string, options: ConfirmOptions = {}) => { calls.push(options); return answer(options); } } };
	return { ctx, calls };
}
const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("the shared approval wait is bounded and longer than the former one-minute dialogs", () => {
	assert.equal(APPROVAL_WAIT_MS, 10 * 60_000);
});

test("approval passes the bounded countdown and caller signal and signals attention once", async () => {
	const turn = new AbortController();
	const { ctx, calls } = dialogContext(async () => true);
	let bells = 0;
	assert.equal(await attendedConfirm(ctx, "Title", "Body", { signal: turn.signal, attention: () => { bells++; } }), "approved");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.timeout, APPROVAL_WAIT_MS);
	assert.equal(calls[0]!.signal, turn.signal);
	await settle(5);
	assert.equal(bells, 1, "one attention signal per dialog and none after it closes");
});

test("an explicit decline before the bound is declined, not expired", async () => {
	const { ctx } = dialogContext(async () => false);
	assert.equal(await attendedConfirm(ctx, "Title", "Body", { waitMs: 1_000, attention: () => undefined }), "declined");
});

test("no answer within the bound is expired and approves nothing", async () => {
	const { ctx } = dialogContext(async (options) => { await settle(options.timeout! + 5); return false; });
	assert.equal(await attendedConfirm(ctx, "Title", "Body", { waitMs: 20, attention: () => undefined }), "expired");
});

test("turn cancellation is reported as cancelled and never approves", async () => {
	const turn = new AbortController();
	const { ctx } = dialogContext(async () => { turn.abort(); return true; });
	assert.equal(await attendedConfirm(ctx, "Title", "Body", { signal: turn.signal, attention: () => undefined }), "cancelled");
	let shown = false;
	const closed = dialogContext(async () => { shown = true; return true; });
	assert.equal(await attendedConfirm(closed.ctx, "Title", "Body", { signal: turn.signal, attention: () => undefined }), "cancelled");
	assert.equal(shown, false, "an already-cancelled turn shows no dialog");
});

test("the terminal bell is content-free and only written to an interactive TUI", () => {
	const writes: string[] = [];
	const original = { write: process.stdout.write, isTTY: process.stdout.isTTY };
	try {
		process.stdout.write = ((chunk: string) => { writes.push(chunk); return true; }) as typeof process.stdout.write;
		process.stdout.isTTY = true;
		ringTerminalBell({ mode: "rpc" });
		ringTerminalBell({ mode: "json" });
		assert.deepEqual(writes, [], "RPC and JSON stdout carry the protocol");
		ringTerminalBell({ mode: "tui" });
		assert.deepEqual(writes, ["\x07"]);
		process.stdout.isTTY = false;
		ringTerminalBell({ mode: "tui" });
		assert.deepEqual(writes, ["\x07"], "no bell into a redirected stream");
	} finally {
		process.stdout.write = original.write;
		process.stdout.isTTY = original.isTTY;
	}
});
