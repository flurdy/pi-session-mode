import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { normalizeToolPath } from "./path.ts";

export const MAX_FILE_GRANTS = 32;

async function pathExists(path: string): Promise<boolean> {
	try { await lstat(path); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function assertOutsideGitAdministration(file: string, signal?: AbortSignal): Promise<void> {
	let directory = dirname(file);
	while (true) {
		signal?.throwIfAborted();
		if (basename(directory) === ".git" || await pathExists(join(directory, ".git"))) {
			throw new Error("File is owned by or ambiguously overlaps a Git repository");
		}
		for (const marker of ["HEAD", "objects", "refs"]) {
			if (await pathExists(join(directory, marker))) throw new Error("File ambiguously overlaps Git administration");
		}
		const parent = dirname(directory);
		if (parent === directory) return;
		directory = parent;
	}
}

export async function resolveGrantFile(value: unknown, cwd: string, signal?: AbortSignal): Promise<string> {
	const requested = normalizeToolPath(value, cwd);
	if ([".git", "HEAD", "objects", "refs"].includes(basename(requested))) throw new Error("File name ambiguously overlaps Git administration");
	let existing = true;
	try { await lstat(requested); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		existing = false;
	}
	let canonical: string;
	if (existing) {
		canonical = await realpath(requested);
		const info = await stat(canonical);
		if (!info.isFile() || info.nlink !== 1) throw new Error("Expected a regular file with one link");
	} else {
		const parent = await realpath(dirname(requested));
		if (!(await stat(parent)).isDirectory()) throw new Error("File parent is not a directory");
		canonical = join(parent, basename(requested));
	}
	await assertOutsideGitAdministration(canonical, signal);
	signal?.throwIfAborted();
	return canonical;
}

export async function resolveExplicitFiles(paths: string[], cwd: string, signal?: AbortSignal): Promise<string[]> {
	if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FILE_GRANTS) throw new Error(`Expected 1–${MAX_FILE_GRANTS} exact file paths`);
	const files = new Set<string>();
	for (const path of paths) files.add(await resolveGrantFile(path, cwd, signal));
	return [...files].sort();
}
