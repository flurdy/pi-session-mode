// v0.2.1 selection parser, retained to test downgrade behavior. Its scope bound is inlined.
import { isAbsolute } from "node:path";

const MAX_LEASE_ROOTS = 32;
type Selection =
	| { mode: "plan" }
	| { mode: "implement"; scope: { kind: "cwd" } | { kind: "roots"; roots: readonly string[]; originCwd: string } };

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function absolute(value: unknown): value is string { return typeof value === "string" && value.length <= 4096 && !value.includes("\0") && isAbsolute(value); }

export function restoreSelectionV2(entries: readonly unknown[]): { selection: Selection; invalid?: boolean } {
	for (const entry of [...entries].reverse()) {
		if (!record(entry) || entry.type !== "custom" || entry.customType !== "session-mode") continue;
		const data = entry.data;
		if (record(data)) {
			if (data.version === 1 && keys(data, ["version", "mode"])) {
				if (data.mode === "plan") return { selection: { mode: "plan" } };
				if (data.mode === "implement") return { selection: { mode: "implement", scope: { kind: "cwd" } } };
			}
			if (data.version === 2) {
				if (data.mode === "plan" && keys(data, ["version", "mode"])) return { selection: { mode: "plan" } };
				if (data.mode === "implement" && keys(data, ["version", "mode", "scope"]) && record(data.scope)) {
					const scope = data.scope;
					if (scope.kind === "cwd" && keys(scope, ["kind"])) return { selection: { mode: "implement", scope: { kind: "cwd" } } };
					if (scope.kind === "roots" && keys(scope, ["kind", "roots", "originCwd"]) && absolute(scope.originCwd) && Array.isArray(scope.roots) && scope.roots.length > 0 && scope.roots.length <= MAX_LEASE_ROOTS && scope.roots.every(absolute) && new Set(scope.roots).size === scope.roots.length) {
						return { selection: { mode: "implement", scope: { kind: "roots", roots: [...scope.roots], originCwd: scope.originCwd } } };
					}
				}
			}
		}
		return { selection: { mode: "plan" }, invalid: true };
	}
	return { selection: { mode: "implement", scope: { kind: "cwd" } } };
}
