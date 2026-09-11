import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGitRoot } from "./lease.ts";

export const MAX_LEASE_ROOTS = 32;
export const ADDITION_TIMEOUT_MS = 10_000;

function checkedPaths(value: unknown, emptyAllowed = false): string[] {
	if (!Array.isArray(value) || (!emptyAllowed && value.length === 0) || value.length > MAX_LEASE_ROOTS || value.some((path) => typeof path !== "string" || !path || path.length > 4096 || path.includes("\0"))) {
		throw new Error(`Expected 1–${MAX_LEASE_ROOTS} nonempty literal worktree paths`);
	}
	return value;
}

export function parseRootFlag(value: string): string[] {
	if (value.length > 140_000) throw new Error("Scope argument is too large");
	return checkedPaths(JSON.parse(value));
}

export function parseRootArguments(input: string): string[] {
	if (input.length > 140_000) throw new Error("Scope argument is too large");
	const paths: string[] = [];
	let word = "", quote = "", escaped = false, started = false;
	for (const char of input) {
		if (escaped) { word += char; escaped = false; started = true; }
		else if (char === "\\" && quote !== "'") { escaped = true; started = true; }
		else if (quote) { if (char === quote) quote = ""; else word += char; }
		else if (char === '"' || char === "'") { quote = char; started = true; }
		else if (/\s/.test(char)) {
			if (started) paths.push(word);
			word = ""; started = false;
		} else { word += char; started = true; }
	}
	if (quote || escaped) throw new Error("Unterminated quote or escape in scope arguments");
	if (started) paths.push(word);
	return checkedPaths(paths, true);
}

export function normalizeToolPath(value: unknown, cwd: string): string {
	if (typeof value !== "string" || !value || value.includes("\0")) throw new Error("Invalid file path");
	let path = value.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (!path) throw new Error("Invalid file path");
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = resolve(homedir(), path.slice(2));
	if (path.startsWith("file://")) path = fileURLToPath(path);
	if (path.includes("\0")) throw new Error("Invalid file path");
	return resolve(cwd, path);
}

export async function resolveExplicitRoots(paths: string[], cwd: string, signal?: AbortSignal): Promise<string[]> {
	checkedPaths(paths);
	const roots = new Set<string>();
	for (const path of paths) {
		signal?.throwIfAborted();
		const requested = await realpath(normalizeToolPath(path, cwd));
		const result = await resolveGitRoot(requested, { signal });
		signal?.throwIfAborted();
		if (!("root" in result) || result.root !== requested) throw new Error(`Expected an existing Git worktree root: ${JSON.stringify(path)}`);
		roots.add(result.root);
	}
	return [...roots].sort();
}

export async function resolveWriteRoot(value: unknown, cwd: string, signal?: AbortSignal): Promise<string> {
	let candidate = normalizeToolPath(value, cwd);
	let missing = false;
	while (true) {
		signal?.throwIfAborted();
		try { await lstat(candidate); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(candidate) === candidate) throw error;
			candidate = dirname(candidate); missing = true;
			continue;
		}
		const canonical = await realpath(candidate);
		const info = await stat(canonical);
		if (missing && !info.isDirectory()) throw new Error("File parent is not a directory");
		const result = await resolveGitRoot(info.isDirectory() ? canonical : dirname(canonical), { signal });
		signal?.throwIfAborted();
		if (!("root" in result)) throw new Error("File has no resolvable Git worktree owner");
		return result.root;
	}
}

export function safeDisplay(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function scopeStatus(roots: readonly string[]): string {
	const names = roots.map((root) => safeDisplay(JSON.stringify(basename(root)).slice(1, -1)));
	return `leases:${roots.length}${names.length ? ` ${names.join(", ").slice(0, 100)}` : ""}`;
}
