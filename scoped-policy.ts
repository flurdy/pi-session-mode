import { pathToFileURL } from "node:url";
import { resolveGrantFile } from "./file-scope.ts";
import { MAX_PARALLEL_DEPTH, SAFE_PARALLEL_TOOL_NAMES } from "./policy.ts";
import { normalizeToolPath, resolveWriteRoot } from "./scope.ts";

interface ScopePolicyOptions {
	resolveRoot?: typeof resolveWriteRoot;
	resolveFile?: typeof resolveGrantFile;
	files?: readonly string[];
	collectMissingRoots?: Set<string>;
	signal?: AbortSignal;
	isCurrent?: () => boolean;
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function pathArgument(path: string, cwd: string): string {
	return /[\u0000-\u001f\u007f-\u009f]/.test(path) || normalizeToolPath(path, cwd) !== path ? pathToFileURL(path).href : path;
}
export async function scopedWriteBlockReason(
	tool: string,
	input: unknown,
	cwd: string,
	roots: readonly string[],
	options: ScopePolicyOptions = {},
	depth = 0,
): Promise<string | undefined> {
	if (options.signal?.aborted) return "Tool validation cancelled";
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
	if (options.collectMissingRoots && (!record(input) || typeof input.path !== "string"
		|| (tool === "write" ? typeof input.content !== "string"
			: !Array.isArray(input.edits) || input.edits.length === 0 || input.edits.some((edit) => !record(edit) || typeof edit.oldText !== "string" || typeof edit.newText !== "string")))) {
		return "Malformed native write input; dynamic acquisition blocked.";
	}
	const target = record(input) ? input.path : undefined;
	try {
		const root = await (options.resolveRoot ?? resolveWriteRoot)(target, cwd, options.signal);
		if (options.isCurrent?.() === false) return "Lease scope changed during tool validation";
		if (!roots.includes(root)) {
			if (options.collectMissingRoots) { options.collectMissingRoots.add(root); return undefined; }
			const argument = pathArgument(root, cwd);
			return `Worktree is not leased. Ask the user to run /implement ${JSON.stringify(argument)} while idle.`;
		}
		return undefined;
	} catch {
		try {
			const file = await (options.resolveFile ?? resolveGrantFile)(target, cwd, options.signal);
			if (options.isCurrent?.() === false) return "Lease scope changed during tool validation";
			if (!options.files?.includes(file)) {
				return `Exact file is not granted. Ask the user to run /grant-file ${JSON.stringify(pathArgument(file, cwd))} while idle.`;
			}
			if (!record(input)) return "Malformed native write input blocked";
			input.path = pathArgument(file, cwd);
			return options.isCurrent?.() === false ? "Lease scope changed during tool validation" : undefined;
		} catch {
			return "Cannot establish this file's worktree or exact-file ownership; write blocked. Select a valid /implement or /grant-file scope.";
		}
	}
}
