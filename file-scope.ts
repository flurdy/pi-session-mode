import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalHome, isWithin, normalizeToolPath, worktreeLeaseRuntimeDir } from "./path.ts";

export const MAX_FILE_GRANTS = 32;
export const MAX_FOLDER_GRANTS = 16;
export const MAX_FOLDER_SCAN_ENTRIES = 20_000;

export interface FolderScopeOptions {
	signal?: AbortSignal;
	runtimeDir?: string;
	home?: string;
	maxEntries?: number;
}

async function pathExists(path: string): Promise<boolean> {
	try { await lstat(path); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function assertOutsideGitAdministration(start: string, signal?: AbortSignal): Promise<void> {
	let directory = start;
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
	await assertOutsideGitAdministration(dirname(canonical), signal);
	signal?.throwIfAborted();
	return canonical;
}

async function assertNoNestedGit(folder: string, maxEntries: number, signal?: AbortSignal): Promise<void> {
	const pending = [folder];
	let entries = 0;
	while (pending.length) {
		signal?.throwIfAborted();
		const directory = pending.pop()!;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (++entries > maxEntries) throw new Error(`Folder has more than ${maxEntries} entries and is too large to verify; grant a narrower folder`);
			if (entry.name === ".git") throw new Error("Folder contains a Git repository");
			if (entry.isDirectory()) pending.push(join(directory, entry.name));
		}
	}
}

/** Canonical non-repository folder scope: an existing directory or one missing leaf beneath an existing canonical directory. */
export async function resolveGrantFolder(value: unknown, cwd: string, options: FolderScopeOptions = {}): Promise<string> {
	const { signal } = options;
	const requested = normalizeToolPath(value, cwd);
	let existing = true;
	try { await lstat(requested); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		existing = false;
	}
	let canonical: string;
	if (existing) {
		canonical = await realpath(requested);
		if (!(await stat(canonical)).isDirectory()) throw new Error("Expected a directory");
	} else {
		const parent = await realpath(dirname(requested));
		if (!(await stat(parent)).isDirectory()) throw new Error("Folder parent is not a directory");
		canonical = join(parent, basename(requested));
	}
	const home = options.home ?? await canonicalHome();
	if (dirname(canonical) === canonical || isWithin(home, canonical)) throw new Error("Folder scope is too broad: root, home and home ancestors cannot be granted");
	const runtimeDir = options.runtimeDir ?? worktreeLeaseRuntimeDir();
	const runtime = await realpath(runtimeDir).catch(() => resolve(runtimeDir));
	if (isWithin(canonical, runtime) || isWithin(runtime, canonical)) throw new Error("Folder scope overlaps the private lease runtime directory");
	if (basename(canonical) === ".git") throw new Error("Folder name overlaps Git administration");
	await assertOutsideGitAdministration(existing ? canonical : dirname(canonical), signal);
	if (existing) await assertNoNestedGit(canonical, options.maxEntries ?? MAX_FOLDER_SCAN_ENTRIES, signal);
	signal?.throwIfAborted();
	return canonical;
}

export async function resolveExplicitFolders(paths: string[], cwd: string, options: FolderScopeOptions = {}): Promise<string[]> {
	if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FOLDER_GRANTS) throw new Error(`Expected 1–${MAX_FOLDER_GRANTS} folder paths`);
	const folders = new Set<string>();
	for (const path of paths) folders.add(await resolveGrantFolder(path, cwd, options));
	return [...folders].sort();
}

export async function resolveExplicitFiles(paths: string[], cwd: string, signal?: AbortSignal): Promise<string[]> {
	if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FILE_GRANTS) throw new Error(`Expected 1–${MAX_FILE_GRANTS} exact file paths`);
	const files = new Set<string>();
	for (const path of paths) files.add(await resolveGrantFile(path, cwd, signal));
	return [...files].sort();
}
