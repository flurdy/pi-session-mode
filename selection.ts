import { isAbsolute } from "node:path";
import { MAX_LEASE_ROOTS } from "./scope.ts";

export type Selection =
	| { mode: "plan" }
	| { mode: "implement"; scope: { kind: "cwd" } | { kind: "roots"; roots: readonly string[]; originCwd: string } };
export type SelectionEntry = { version: 1; mode: "plan" } | ({ version: 2 } & Selection);

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function absolute(value: unknown): value is string { return typeof value === "string" && value.length <= 4096 && !value.includes("\0") && isAbsolute(value); }

export function restoreSelection(entries: readonly unknown[]): { selection: Selection; invalid?: boolean } {
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

export function selectionEntries(selection: Selection): SelectionEntry[] {
	const snapshot: Selection = selection.mode === "implement" && selection.scope.kind === "roots"
		? { mode: "implement", scope: { ...selection.scope, roots: [...selection.scope.roots] } }
		: selection;
	return [{ version: 1, mode: "plan" }, { version: 2, ...snapshot }];
}
