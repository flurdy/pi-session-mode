import { isAbsolute } from "node:path";
import { MAX_FILE_GRANTS } from "./file-scope.ts";
import { MAX_LEASE_ROOTS } from "./scope.ts";

export type WorktreeSelection =
	| { kind: "none" | "cwd" }
	| { kind: "roots"; roots: readonly string[]; originCwd: string }
	| { kind: "lazy"; originCwd: string };
type EagerScope = Exclude<WorktreeSelection, { kind: "lazy" }>;
export type Selection =
	| { mode: "plan" }
	| { mode: "implement"; scope: WorktreeSelection; files?: readonly string[] };
export type SelectionEntry =
	| { version: 1; mode: "plan" }
	| { version: 2; mode: "plan" }
	| { version: 2; mode: "implement"; scope: Exclude<EagerScope, { kind: "none" }> }
	| { version: 3; mode: "implement"; scope: EagerScope; files: readonly string[] }
	| { version: 4; mode: "implement"; scope: { kind: "lazy"; originCwd: string }; files?: readonly string[] };

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function absolute(value: unknown): value is string { return typeof value === "string" && value.length <= 4096 && !value.includes("\0") && isAbsolute(value); }
function absoluteSet(value: unknown, maximum: number, empty = false): value is string[] {
	return Array.isArray(value) && (empty || value.length > 0) && value.length <= maximum && value.every(absolute) && new Set(value).size === value.length;
}
function parseScope(value: unknown, allowNone: boolean): EagerScope | undefined {
	if (!record(value)) return undefined;
	if (value.kind === "cwd" && keys(value, ["kind"])) return { kind: "cwd" };
	if (allowNone && value.kind === "none" && keys(value, ["kind"])) return { kind: "none" };
	if (value.kind === "roots" && keys(value, ["kind", "roots", "originCwd"]) && absolute(value.originCwd) && absoluteSet(value.roots, MAX_LEASE_ROOTS)) {
		return { kind: "roots", roots: [...value.roots], originCwd: value.originCwd };
	}
	return undefined;
}
function parseLazy(data: Record<string, unknown>): Selection | undefined {
	if (data.mode !== "implement" || !keys(data, ["version", "mode", "scope", "files"])) return undefined;
	const scope = data.scope;
	if (!record(scope) || scope.kind !== "lazy" || !keys(scope, ["kind", "originCwd"]) || !absolute(scope.originCwd)) return undefined;
	if (data.files === undefined) return { mode: "implement", scope: { kind: "lazy", originCwd: scope.originCwd } };
	return absoluteSet(data.files, MAX_FILE_GRANTS) ? { mode: "implement", scope: { kind: "lazy", originCwd: scope.originCwd }, files: [...data.files] } : undefined;
}

export function selectionFiles(selection: Selection): readonly string[] {
	return selection.mode === "implement" ? selection.files ?? [] : [];
}

/** Returns undefined when the branch has no session-mode entry; the caller chooses the fresh default. */
export function restoreSelection(entries: readonly unknown[]): { selection: Selection; invalid?: boolean } | undefined {
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
				if (data.mode === "implement" && keys(data, ["version", "mode", "scope"])) {
					const scope = parseScope(data.scope, false);
					if (scope) return { selection: { mode: "implement", scope } };
				}
			}
			if (data.version === 3) {
				if (data.mode === "plan" && keys(data, ["version", "mode"])) return { selection: { mode: "plan" } };
				if (data.mode === "implement" && keys(data, ["version", "mode", "scope", "files"]) && absoluteSet(data.files, MAX_FILE_GRANTS)) {
					const scope = parseScope(data.scope, true);
					if (scope) return { selection: { mode: "implement", scope, files: [...data.files] } };
				}
			}
			if (data.version === 4) {
				const selection = parseLazy(data);
				if (selection) return { selection };
			}
		}
		return { selection: { mode: "plan" }, invalid: true };
	}
	return undefined;
}

export function selectionEntries(selection: Selection): SelectionEntry[] {
	if (selection.mode === "plan") return [{ version: 1, mode: "plan" }, { version: 2, mode: "plan" }];
	const files = [...selectionFiles(selection)];
	const scope = selection.scope;
	if (scope.kind === "lazy") {
		const lazy = { kind: "lazy" as const, originCwd: scope.originCwd };
		return [{ version: 1, mode: "plan" }, files.length ? { version: 4, mode: "implement", scope: lazy, files } : { version: 4, mode: "implement", scope: lazy }];
	}
	const eager: EagerScope = scope.kind === "roots" ? { ...scope, roots: [...scope.roots] } : scope;
	if (files.length) return [{ version: 1, mode: "plan" }, { version: 3, mode: "implement", scope: eager, files }];
	if (eager.kind === "none") return [{ version: 1, mode: "plan" }, { version: 2, mode: "plan" }];
	return [{ version: 1, mode: "plan" }, { version: 2, mode: "implement", scope: eager }];
}
