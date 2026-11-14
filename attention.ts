/** How long an attended approval dialog waits for an answer. Expiry authorizes nothing. */
export const APPROVAL_WAIT_MS = 10 * 60_000;

export type ApprovalOutcome = "approved" | "declined" | "expired" | "cancelled";
/** Draws the user's attention to a dialog that is waiting for them; never carries dialog content. */
export type AttentionSignal = (ctx: { mode: string }) => void;

interface ConfirmContext {
	mode: string;
	ui: { confirm(title: string, message: string, options?: { timeout?: number; signal?: AbortSignal }): Promise<boolean> };
}

/**
 * One terminal bell for an interactive TUI. Terminals such as Orca turn it into a desktop
 * notification for an unfocused pane. In RPC and JSON modes stdout is the protocol channel,
 * so nothing is written there.
 */
export function ringTerminalBell(ctx: { mode: string }): void {
	if (ctx.mode !== "tui" || !process.stdout.isTTY) return;
	try { process.stdout.write("\x07"); } catch { /* Attention is advisory, never an authority boundary. */ }
}

/**
 * Show one bounded confirmation and say why it closed. Pi reports a timeout and a decline the
 * same way, so an unanswered dialog is recognised by having stayed open for the whole bound.
 * A cancelled turn never approves, even if the dialog answered first.
 */
export async function attendedConfirm(
	ctx: ConfirmContext, title: string, message: string,
	options: { signal?: AbortSignal; waitMs?: number; attention?: AttentionSignal } = {},
): Promise<ApprovalOutcome> {
	const { signal, waitMs = APPROVAL_WAIT_MS, attention = ringTerminalBell } = options;
	if (signal?.aborted) return "cancelled";
	attention(ctx);
	const started = Date.now();
	const confirmed = await ctx.ui.confirm(title, message, { timeout: waitMs, ...(signal ? { signal } : {}) });
	if (signal?.aborted) return "cancelled";
	if (confirmed) return "approved";
	return Date.now() - started >= waitMs ? "expired" : "declined";
}
