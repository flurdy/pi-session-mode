import { pathToFileURL } from "node:url";
import { MAX_PARALLEL_DEPTH, SAFE_PARALLEL_TOOL_NAMES } from "./policy.ts";
import { normalizeToolPath, resolveWriteRoot } from "./scope.ts";

interface ScopePolicyOptions {
	resolveRoot?: typeof resolveWriteRoot;
	isCurrent?: () => boolean;
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export async function scopedWriteBlockReason(
	tool: string,
	input: unknown,
	cwd: string,
	roots: readonly string[],
	options: ScopePolicyOptions = {},
	depth = 0,
): Promise<string | undefined> {
	if (tool === "multi_tool_use.parallel") {
		if (!record(input) || !Array.isArray(input.tool_uses) || input.tool_uses.length === 0 || depth >= MAX_PARALLEL_DEPTH) return "Malformed or excessively nested parallel call blocked";
		for (const nested of input.tool_uses) {
			if (!record(nested) || typeof nested.recipient_name !== "string" || !record(nested.parameters)) return "Malformed parallel call blocked";
			const name = nested.recipient_name.replace(/^functions\./, "");
			if (name !== "edit" && name !== "write" && !SAFE_PARALLEL_TOOL_NAMES.has(name)) return "Unknown parallel tool blocked";
			const reason = await scopedWriteBlockReason(name, nested.parameters, cwd, roots, options, depth + 1);
			if (reason) return reason;
		}
		return options.isCurrent?.() === false ? "Lease scope changed during tool validation" : undefined;
	}
	if (tool !== "edit" && tool !== "write") return undefined;
	try {
		const root = await (options.resolveRoot ?? resolveWriteRoot)(record(input) ? input.path : undefined, cwd);
		if (options.isCurrent?.() === false) return "Lease scope changed during tool validation";
		if (!roots.includes(root)) {
			const argument = /[\u0000-\u001f\u007f-\u009f]/.test(root) || normalizeToolPath(root, cwd) !== root ? pathToFileURL(root).href : root;
			return `Worktree is not leased. Ask the user to run /implement ${JSON.stringify(argument)} while idle.`;
		}
	} catch {
		return "Cannot establish this file's worktree ownership; write blocked. Select a valid scope with /implement.";
	}
	return undefined;
}
