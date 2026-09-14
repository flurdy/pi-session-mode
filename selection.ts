import { isAbsolute } from "node:path";
import { MAX_FILE_GRANTS } from "./file-scope.ts";
import { MAX_LEASE_ROOTS } from "./scope.ts";

export type WorktreeSelection =
	| { kind: "none" | "cwd" }
	| { kind: "roots"; roots: readonly string[]; originCwd: string };
export type Selection =
	| { mode: "plan" }
	| { mode: "implement"; scope: WorktreeSelection; files?: readonly string[] };
export type SelectionEntry =
	| { version: 1; mode: "plan" }
	| ({ version: 2 } & Exclude<Selection, { mode: "implement"; scope: { kind: "none" } }>)
	| ({ version: 3 } & Selection);

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function absolute(value: unknown): value is string { return typeof value === "string" && value.length <= 4096 && !value.includes("\0") && isAbsolute(value); }
function absoluteSet(value: unknown, maximum: number, empty = false): value is string[] {
	return Array.isArray(value) && (empty || value.length > 0) && value.length <= maximum && value.every(absolute) && new Set(value).size === value.length;
}
function parseScope(value: unknown, allowNone: boolean): WorktreeSelection | undefined {
	if (!record(value)) return undefined;
	if (value.kind === "cwd" && keys(value, ["kind"])) return { kind: "cwd" };
	if (allowNone && value.kind === "none" && keys(value, ["kind"])) return { kind: "none" };
	if (value.kind === "roots" && keys(value, ["kind", "roots", "originCwd"]) && absolute(value.originCwd) && absoluteSet(value.roots, MAX_LEASE_ROOTS)) {
		return { kind: "roots", roots: [...value.roots], originCwd: value.originCwd };
	}
	return undefined;
}

export function selectionFiles(selection: Selection): readonly string[] {
	return selection.mode === "implement" ? selection.files ?? [] : [];
}

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
		}
		return { selection: { mode: "plan" }, invalid: true };
	}
	return { selection: { mode: "implement", scope: { kind: "cwd" } } };
}

export function selectionEntries(selection: Selection): SelectionEntry[] {
	if (selection.mode === "plan") return [{ version: 1, mode: "plan" }, { version: 2, mode: "plan" }];
	const scope: WorktreeSelection = selection.scope.kind === "roots"
		? { ...selection.scope, roots: [...selection.scope.roots] }
		: selection.scope;
	const files = [...selectionFiles(selection)];
	if (files.length) return [{ version: 1, mode: "plan" }, { version: 3, mode: "implement", scope, files }];
	if (scope.kind === "none") return [{ version: 1, mode: "plan" }, { version: 2, mode: "plan" }];
	return [{ version: 1, mode: "plan" }, { version: 2, mode: "implement", scope }];
}
