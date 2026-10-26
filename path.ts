import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function worktreeLeaseRuntimeDir(): string {
	return join(process.env.XDG_RUNTIME_DIR || tmpdir(), `pi-session-guard-${process.getuid?.() ?? "user"}`);
}

/** True when `path` is `ancestor` itself or lies beneath it; both must be canonical absolute paths. */
export function isWithin(path: string, ancestor: string): boolean {
	return path === ancestor || path.startsWith(ancestor === sep ? sep : `${ancestor}${sep}`);
}

export async function canonicalHome(): Promise<string> {
	return realpath(homedir()).catch(() => homedir());
}

/** Canonical form of a possibly missing path: the nearest existing ancestor is resolved, missing components appended. */
export async function canonicalPossiblyMissing(path: string): Promise<string> {
	const missing: string[] = [];
	for (let current = resolve(path); ; current = dirname(current)) {
		try { return join(await realpath(current), ...missing); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) throw error;
			missing.unshift(basename(current));
		}
	}
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
