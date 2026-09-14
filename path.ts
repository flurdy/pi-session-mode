import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
