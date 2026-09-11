import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const runtimeFiles = ["README.md", "docs/guard.md", "index.ts", "lease-observer.ts", "lease-set.ts", "lease.ts", "policy.ts", "scope.ts", "scoped-policy.ts", "selection.ts", "session-mode.ts", "subagent-policy.ts"];

assert.ok(manifest.keywords?.includes("pi-package"), "package discovery metadata is required");
assert.deepEqual(manifest.pi, { extensions: ["./index.ts"] });
assert.deepEqual(manifest.exports, { "./lease-observer": "./lease-observer.ts" });
assert.deepEqual([...manifest.files].sort(), runtimeFiles, "runtime allowlist differs");
assert.equal(manifest.repository?.url, "git+https://github.com/flurdy/pi-session-mode.git");
assert.deepEqual(manifest.peerDependencies, { "@earendil-works/pi-coding-agent": "*" });
assert.equal(manifest.devDependencies["@earendil-works/pi-coding-agent"], "0.85.1");

const reports = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }));
assert.equal(reports.length, 1);
const files = reports[0].files.map((file) => file.path).sort();
assert.deepEqual(files, ["LICENSE", "package.json", ...runtimeFiles].sort(), "unexpected package content");
for (const file of files.filter((name) => name.endsWith(".md"))) {
	const markdown = readFileSync(resolve(root, file), "utf8");
	for (const [, link] of markdown.matchAll(/\]\(([^)]+)\)/g)) {
		if (/^[a-z][a-z0-9+.-]*:|^#/i.test(link)) continue;
		const target = posix.join(posix.dirname(file), link.split("#")[0]);
		assert.ok(files.includes(target), `${file} links to unpackaged ${target}`);
	}
}
console.log(`Package exports, exact allowlist and documentation links: PASS (${files.length} files)`);
