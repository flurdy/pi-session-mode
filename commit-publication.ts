import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import { probeWorktreeLeaseOccupancies, type WorktreeLeaseOccupancy } from "./lease-observer.ts";
import { safeDisplay } from "./scope.ts";

const COMMIT = /^[0-9a-f]{7,64}$/;
const OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const TOKEN = /^[0-9a-f]{32}$/;
const MAX_CONTEXT = 500;
const MAX_LISTED_COMMITS = 20;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PREFLIGHT_TIMEOUT_MS = 10_000;
const DEFAULT_PUSH_TIMEOUT_MS = 120_000;
const CONFIRM_TIMEOUT_MS = 60_000;
const TOKEN_TTL_MS = 120_000;
const BATCH_SSH = "ssh -o BatchMode=yes -o ConnectTimeout=10";
const OVERRIDDEN_GIT_ENV = /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|EXEC_PATH|CONFIG(?:_|$))/;

export interface PublicationRequest { root: string; commit: string; context?: string }
export interface PublicationIdentity {
	root: string;
	branch: string;
	commit: string;
	remote: string;
	destination: string;
	ref: string;
	trackingCommit: string;
}
export interface PreparedPublication {
	revision: string;
	/** Digest of effective configuration, push URL and SSH environment, rechecked after the push. */
	transport: string;
	/** Unredacted push URL; session memory only, never returned to callers. */
	pushUrl: string;
	identity: PublicationIdentity;
	display: {
		commitCount: number;
		commits: Array<{ commit: string; subject: string }>;
		prePushHook: boolean;
		ssh: "configured" | "batch-mode default";
		context?: string;
	};
}
export type PublicationStatus = "ok" | "uptodate" | "rejected" | "failed" | "stale" | "unknown";
export interface PublicationReceipt extends Omit<PublicationIdentity, "trackingCommit"> {
	schemaVersion: "commit-publication/v1";
	status: PublicationStatus;
	summary?: string;
	warning?: string;
	diagnostics?: string;
}
export interface PublicationDependencies { pushTimeoutMs?: number }
export interface PublicationToolDependencies extends PublicationDependencies {
	now?: () => number;
	observe?: (root: string) => Promise<WorktreeLeaseOccupancy[]>;
}

interface GitResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnFailed: boolean }

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<GitResult> {
	return new Promise((done) => {
		let stdout = "", stderr = "", bytes = 0, timedOut = false, settled = false;
		// A separate process group lets a deadline also stop hook descendants holding our pipes.
		const child = spawn("git", args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		const kill = (signalName: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signalName); } catch { /* Already exited. */ } };
		let force: NodeJS.Timeout | undefined;
		const stop = () => { kill("SIGTERM"); force = setTimeout(() => kill("SIGKILL"), 1000); };
		const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
		const abort = () => stop();
		signal?.addEventListener("abort", abort, { once: true });
		const capture = (append: (text: string) => void) => (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes <= MAX_OUTPUT_BYTES) append(chunk.toString("utf8"));
		};
		child.stdout.on("data", capture((text) => { stdout += text; }));
		child.stderr.on("data", capture((text) => { stderr += text; }));
		const finish = (code: number | null, spawnFailed: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (force) clearTimeout(force);
			signal?.removeEventListener("abort", abort);
			done({ code, stdout, stderr, timedOut, spawnFailed });
		};
		child.once("error", () => finish(null, true));
		child.once("close", (code) => finish(code, false));
		if (signal?.aborted) abort();
	});
}

function baseEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (OVERRIDDEN_GIT_ENV.test(key) || key === "GIT_ASKPASS" || key === "SSH_ASKPASS") delete env[key];
	}
	return { ...env, GIT_TERMINAL_PROMPT: "0", SSH_ASKPASS_REQUIRE: "never", GIT_ALLOW_PROTOCOL: "file:git:http:https:ssh" };
}

function sshEnvironment(): Record<string, string | undefined> {
	return { GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND, GIT_SSH: process.env.GIT_SSH, GIT_SSH_VARIANT: process.env.GIT_SSH_VARIANT };
}

function sshConfigured(config: Map<string, string[]>): boolean {
	return Boolean(process.env.GIT_SSH_COMMAND || process.env.GIT_SSH || config.has("core.sshcommand"));
}

function gitEnvironment(config: Map<string, string[]>): NodeJS.ProcessEnv {
	// Respect explicit user transport policy; otherwise forbid interactive SSH prompts.
	return sshConfigured(config) ? baseEnvironment() : { ...baseEnvironment(), GIT_SSH_COMMAND: BATCH_SSH };
}

async function checked(args: string[], root: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, allowed: number[] = [0]): Promise<GitResult> {
	signal?.throwIfAborted();
	const result = await runGit(args, root, env, PREFLIGHT_TIMEOUT_MS, signal);
	signal?.throwIfAborted();
	if (result.spawnFailed) throw new Error("Git is unavailable");
	if (result.timedOut) throw new Error(`Git ${args[0]} timed out during publication preflight`);
	if (result.code === null || !allowed.includes(result.code)) throw new Error(`Git ${args.join(" ")} failed during publication preflight (exit ${result.code}): ${redactDiagnostics(result.stderr).slice(0, 300)}`);
	return result;
}

function parseConfig(text: string): Map<string, string[]> {
	const entries = new Map<string, string[]>();
	for (const entry of text.split("\0")) {
		if (!entry) continue;
		const newline = entry.indexOf("\n");
		const key = newline < 0 ? entry : entry.slice(0, newline);
		entries.set(key, [...(entries.get(key) ?? []), newline < 0 ? "true" : entry.slice(newline + 1)]);
	}
	return entries;
}

function single(config: Map<string, string[]>, key: string): string | undefined {
	const values = config.get(key);
	if (values && values.length !== 1) throw new Error(`Multiple ${key} values are unsupported`);
	return values?.[0];
}

function truthy(value: string): boolean {
	return !/^(?:false|no|off|0|)$/i.test(value.trim());
}

// Userinfo may hold a token in either position, so redact it whole; queries and fragments too.
export function redactUrl(url: string): string {
	const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*@)?([^?#]*)([?#].*)?$/i.exec(url);
	if (!match) return safeDisplay(url);
	const [, scheme, userinfo, rest, query] = match;
	return safeDisplay(`${scheme}${userinfo ? "***@" : ""}${rest}${query ? `${query[0]}…` : ""}`);
}

export function redactDiagnostics(text: string): string {
	const redacted = text
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
		.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)([?#])\S*/gi, "$1$2…")
		.trim();
	return safeDisplay(redacted.length > 2000 ? `…${redacted.slice(-2000)}` : redacted);
}

function validated(input: PublicationRequest): Required<Pick<PublicationRequest, "root" | "commit">> & Pick<PublicationRequest, "context"> {
	if (!input || typeof input !== "object") throw new Error("Invalid publication request");
	if (typeof input.root !== "string" || !isAbsolute(input.root) || input.root.length > 4096) throw new Error("Publication root must be an absolute path");
	if (typeof input.commit !== "string" || !COMMIT.test(input.commit)) throw new Error("Expected a lowercase hex commit of 7-64 characters");
	if (input.context !== undefined && (typeof input.context !== "string" || input.context.length > MAX_CONTEXT)) throw new Error(`Context must be at most ${MAX_CONTEXT} characters`);
	return { root: input.root, commit: input.commit, ...(input.context !== undefined ? { context: input.context } : {}) };
}

function transportDigest(configText: string, urls: string[]): string {
	return createHash("sha256").update(JSON.stringify({ configText, urls, ssh: sshEnvironment() })).digest("hex");
}

async function currentTransport(identity: PublicationIdentity): Promise<string | undefined> {
	try {
		const configText = (await checked(["config", "--list", "-z"], identity.root, baseEnvironment())).stdout;
		const urls = (await checked(["remote", "get-url", "--push", "--all", identity.remote], identity.root, gitEnvironment(parseConfig(configText)))).stdout.split("\n").filter(Boolean);
		return transportDigest(configText, urls);
	} catch { return undefined; }
}

export async function preparePublication(input: PublicationRequest, _dependencies: PublicationDependencies = {}, signal?: AbortSignal): Promise<PreparedPublication> {
	const request = validated(input);
	const root = request.root;
	let canonical: string;
	try { canonical = await realpath(root); }
	catch { throw new Error("Publication root is unavailable"); }
	if (canonical !== root) throw new Error("Publication root must be the canonical worktree path, not an alias");
	const configText = (await checked(["config", "--list", "-z"], root, baseEnvironment(), signal)).stdout;
	const config = parseConfig(configText);
	const env = gitEnvironment(config);
	const git = (args: string[], allowed?: number[]) => checked(args, root, env, signal, allowed);

	if ((await git(["rev-parse", "--show-toplevel"])).stdout.trim() !== root) throw new Error("Publication root must be the worktree top-level");
	const head = await git(["symbolic-ref", "-q", "HEAD"], [0, 1]);
	const headRef = head.stdout.trim();
	if (head.code !== 0 || !headRef.startsWith("refs/heads/")) throw new Error("Publication requires a checked-out branch; HEAD is detached or unsupported");
	const branch = headRef.slice("refs/heads/".length);
	if (!BRANCH.test(branch) || (await git(["check-ref-format", headRef], [0, 1])).code !== 0) throw new Error("Branch name is unsupported for publication");
	const tip = (await git(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).stdout.trim();
	const named = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${request.commit}^{commit}`], [0, 1]);
	if (!OBJECT.test(tip) || !tip.startsWith(request.commit) || named.stdout.trim() !== tip) throw new Error("Expected commit does not match the checked-out tip");

	const remote = single(config, `branch.${branch}.remote`);
	if (!remote || !REMOTE.test(remote) || single(config, `branch.${branch}.merge`) !== headRef) {
		throw new Error(`Publication requires a same-name upstream (branch.${branch}.merge = ${headRef}) on a named remote`);
	}
	if ((config.get(`branch.${branch}.pushremote`) ?? []).some((value) => value !== remote)) throw new Error("Conflicting branch pushRemote configuration");
	if ((config.get("remote.pushdefault") ?? []).some((value) => value !== remote)) throw new Error("Conflicting remote.pushDefault configuration");
	if (config.has(`remote.${remote}.push`)) throw new Error("Remote push mapping configuration is unsupported");
	if ((config.get(`remote.${remote}.mirror`) ?? []).some(truthy)) throw new Error("Remote mirror configuration is unsupported");
	if (config.has(`remote.${remote}.receivepack`)) throw new Error("Custom receivepack configuration is unsupported");
	const urls = (await git(["remote", "get-url", "--push", "--all", remote])).stdout.split("\n").filter(Boolean);
	if (urls.length !== 1) throw new Error("Publication requires exactly one push URL");

	const trackingRef = `refs/remotes/${remote}/${branch}`;
	const tracking = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${trackingRef}^{commit}`], [0, 1]);
	const trackingCommit = tracking.stdout.trim();
	if (tracking.code !== 0 || !OBJECT.test(trackingCommit)) throw new Error(`Local tracking ref ${trackingRef} is missing; fetch before publishing`);
	if ((await git(["merge-base", "--is-ancestor", trackingCommit, tip], [0, 1])).code !== 0) throw new Error(`Candidate is not a fast-forward of the local tracking ref ${trackingRef}`);
	const commitCount = Number((await git(["rev-list", "--count", `${trackingCommit}..${tip}`])).stdout.trim());
	const commits = (await git(["log", "--no-show-signature", `--max-count=${MAX_LISTED_COMMITS}`, "--format=%H%x00%s", `${trackingCommit}..${tip}`])).stdout
		.split("\n").filter(Boolean).map((line) => {
			const [commit = "", subject = ""] = line.split("\0");
			return { commit, subject: safeDisplay(subject.slice(0, 200)) };
		});
	const hooks = resolve(root, (await git(["rev-parse", "--git-path", "hooks"])).stdout.trim());
	const prePushHook = await access(join(hooks, "pre-push"), constants.X_OK).then(() => true, () => false);

	const identity: PublicationIdentity = { root, branch, commit: tip, remote, destination: redactUrl(urls[0]!), ref: headRef, trackingCommit };
	const transport = transportDigest(configText, urls);
	const revision = createHash("sha256").update(JSON.stringify({ identity, transport, prePushHook })).digest("hex");
	return {
		revision,
		transport,
		pushUrl: urls[0]!,
		identity,
		display: {
			commitCount,
			commits,
			prePushHook,
			ssh: sshConfigured(config) ? "configured" : "batch-mode default",
			...(request.context !== undefined ? { context: safeDisplay(request.context) } : {}),
		},
	};
}

const withoutUserinfo = (url: string) => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1").replace(/^[^/@:]+@(?=[^/:]+:)/, "");

/** Git anonymizes userinfo in its "To" line, so compare both sides without it. */
export function destinationMatches(reported: string | undefined, approved: string): boolean {
	return reported !== undefined && withoutUserinfo(reported) === withoutUserinfo(approved);
}

export function parsePushPorcelain(stdout: string, ref: string, code: number | null): { status: PublicationStatus; summary: string; destination?: string; warning?: string } {
	let destination: string | undefined;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("To ")) { destination = line.slice(3); continue; }
		const fields = line.split("\t");
		if (fields.length !== 3 || fields[1]!.slice(fields[1]!.indexOf(":") + 1) !== ref) continue;
		const [flag, , summary = ""] = fields;
		const at = destination === undefined ? {} : { destination };
		if (flag === " " || flag === "*") {
			return code === 0 ? { status: "ok", summary, ...at }
				: { status: "ok", summary, ...at, warning: `Git exited ${code} after the remote acknowledged the update; local tracking state may be stale` };
		}
		if (flag === "=") return { status: "uptodate", summary, ...at };
		if (flag === "!") return { status: "rejected", summary, ...at };
		return { status: "unknown", summary: `Unexpected acknowledgement '${flag}': ${summary}`, ...at };
	}
	return { status: "unknown", summary: `No remote acknowledgement for ${ref}` };
}

function receipt(identity: PublicationIdentity, status: PublicationStatus, extra: Partial<Pick<PublicationReceipt, "summary" | "warning" | "diagnostics">> = {}): PublicationReceipt {
	const { trackingCommit: _tracking, ...published } = identity;
	return { schemaVersion: "commit-publication/v1", status, ...published, ...extra };
}

export async function executePublication(
	input: PublicationRequest,
	prepared: PreparedPublication,
	dependencies: PublicationDependencies = {},
	options: { beforeLaunch?: () => boolean; signal?: AbortSignal } = {},
): Promise<PublicationReceipt> {
	let fresh: PreparedPublication;
	try { fresh = await preparePublication(input, dependencies, options.signal); }
	catch (error) { return receipt(prepared.identity, "stale", { diagnostics: safeDisplay(String(error)).slice(0, 2000) }); }
	if (fresh.revision !== prepared.revision) {
		return receipt(prepared.identity, "stale", { diagnostics: "Publication identity, tip or configuration changed after confirmation; nothing was pushed" });
	}
	if (options.signal?.aborted || (options.beforeLaunch && !options.beforeLaunch())) {
		return receipt(prepared.identity, "stale", { diagnostics: "Publication was cancelled or its session ended before launch; nothing was pushed" });
	}
	const { identity } = fresh;
	const env = fresh.display.ssh === "configured" ? baseEnvironment() : { ...baseEnvironment(), GIT_SSH_COMMAND: BATCH_SSH };
	// Once launched, a push drains to completion or its deadline; cancellation would hide a partial outcome.
	// ^{commit} forces object lookup: a bare hex source would prefer a ref with that name.
	const result = await runGit(
		["push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", "--no-signed", identity.remote, `${identity.commit}^{commit}:${identity.ref}`],
		identity.root, env, dependencies.pushTimeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS,
	);
	const diagnostics = redactDiagnostics(result.stderr);
	if (result.spawnFailed) return receipt(identity, "failed", { diagnostics: "Git could not be started; nothing was pushed" });
	if (result.timedOut) {
		return receipt(identity, "unknown", { diagnostics: `Push exceeded its deadline and was terminated; remote outcome unknown${diagnostics ? `\n${diagnostics}` : ""}` });
	}
	const parsed = parsePushPorcelain(result.stdout, identity.ref, result.code);
	// Git rereads configuration at launch: require the reported destination and an unchanged transport.
	const acknowledged = parsed.status === "ok" || parsed.status === "uptodate" || parsed.status === "rejected";
	if (acknowledged && !destinationMatches(parsed.destination, fresh.pushUrl)) {
		return receipt(identity, "unknown", {
			summary: redactDiagnostics(parsed.summary).slice(0, 500),
			diagnostics: `Git reported a destination other than the approved push URL (reported ${parsed.status})${parsed.destination ? `: ${redactUrl(parsed.destination)}` : ""}`,
		});
	}
	if (await currentTransport(identity) !== fresh.transport) {
		return receipt(identity, "unknown", {
			summary: redactDiagnostics(parsed.summary).slice(0, 500),
			diagnostics: `Git configuration or transport changed while the push ran; actual destination unverified (reported ${parsed.status})${diagnostics ? `\n${diagnostics}` : ""}`,
		});
	}
	return receipt(identity, parsed.status, {
		summary: redactDiagnostics(parsed.summary).slice(0, 500),
		...(parsed.warning ? { warning: parsed.warning } : {}),
		...(diagnostics ? { diagnostics } : {}),
	});
}

function occupancyLine(observations: WorktreeLeaseOccupancy[]): string {
	const kind = observations.length === 1 ? observations[0]!.kind : "unavailable";
	const state = kind === "held" ? "held by another local Pi session"
		: kind === "free" ? "none observed by local Pi"
		: "observation unavailable";
	return `Writer lease: ${state} (advisory; this publication does not take or need a source lease)`;
}

function confirmation(prepared: PreparedPublication, occupancy: string): string {
	const { identity, display } = prepared;
	const lines = [
		`Worktree: ${safeDisplay(JSON.stringify(identity.root))}`,
		`Branch: ${safeDisplay(identity.branch)}`,
		`Commit: ${identity.commit}`,
		`Destination: ${identity.remote} ${identity.destination} ${identity.ref}`,
		`Commits beyond local tracking ref: ${display.commitCount}`,
		...display.commits.map((entry) => `  ${entry.commit.slice(0, 12)} ${entry.subject}`),
		...(display.commitCount > display.commits.length ? [`  … ${display.commitCount - display.commits.length} more`] : []),
		`pre-push hook: ${display.prePushHook ? "present (trusted user code will run)" : "none"}`,
		`SSH: ${display.ssh}`,
		occupancy,
		...(display.context !== undefined ? [`Caller context (unverified): ${display.context}`] : []),
		"",
		"Publishing makes this exact commit visible remotely and may trigger CI or deployment. Non-force, no tags, no retry. Execution rechecks every value above and refuses on drift.",
	];
	return lines.join("\n").slice(0, 10_000);
}

const PARALLEL_REASON = "publish_commit cannot run inside parallel tool wrappers; call it directly so each confirmation and push stays attended and serialized.";

/** Guard-independent: blocks publish_commit nested in parallel wrappers, including when the guard is disabled. */
export function publicationWrapperBlockReason(toolName: string, input: unknown, depth = 0): string | undefined {
	if (toolName !== "multi_tool_use.parallel") return undefined;
	const uses = typeof input === "object" && input !== null ? (input as { tool_uses?: unknown }).tool_uses : undefined;
	if (!Array.isArray(uses)) return undefined;
	for (const use of uses) {
		const name = typeof use?.recipient_name === "string" ? use.recipient_name.replace(/^functions\./, "") : "";
		if (name === "publish_commit") return PARALLEL_REASON;
		if (depth >= 8) return PARALLEL_REASON;
		const nested = publicationWrapperBlockReason(name, use?.parameters, depth + 1);
		if (nested) return nested;
	}
	return undefined;
}

const result = (details: object) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });

export interface CommitPublicationLifecycle {
	sessionStart(ctx: { sessionManager: { getSessionId(): string } }): void;
	sessionShutdown(): Promise<void>;
}

/** With ownLifecycle false, the caller must invoke the returned hooks from its own session events. */
export function registerCommitPublication(pi: ExtensionAPI, dependencies: PublicationToolDependencies = {}, options: { ownLifecycle?: boolean } = {}): CommitPublicationLifecycle {
	const now = dependencies.now ?? Date.now;
	const observe = dependencies.observe ?? ((root: string) => probeWorktreeLeaseOccupancies([root]));
	const tokens = new Map<string, { sessionId: string; request: PublicationRequest; prepared: PreparedPublication; expiresAt: number }>();
	const pending = new Set<Promise<unknown>>();
	let session: { id: string; abort: AbortController } | undefined;
	let busy = false;

	const lifecycle: CommitPublicationLifecycle = {
		sessionStart(ctx) {
			session?.abort.abort();
			tokens.clear();
			session = { id: ctx.sessionManager.getSessionId(), abort: new AbortController() };
		},
		async sessionShutdown() {
			session?.abort.abort();
			session = undefined;
			tokens.clear();
			await Promise.allSettled([...pending]);
		},
	};
	if (options.ownLifecycle !== false) {
		pi.on("session_start", (_event, ctx) => lifecycle.sessionStart(ctx));
		pi.on("session_shutdown", () => lifecycle.sessionShutdown());
	}

	pi.registerTool({
		name: "publish_commit",
		label: "Publish commit",
		description: "Attended, exact-commit Git publication without a source-writer lease. action=confirm checks one canonical worktree's checked-out branch, same-name upstream, single push URL and fast-forward candidate, then asks a fresh native TUI confirmation and returns a single-use token valid for two minutes in this session. action=execute takes only that token, rechecks everything and pushes that commit to its same-name branch: non-force, no tags, no retry. Returns a commit-publication/v1 receipt: ok, uptodate, rejected, failed, stale or unknown.",
		promptSnippet: "Publish one exact, freshly confirmed commit without a source lease",
		promptGuidelines: [
			"Use publish_commit only for an attended release step the user is approving now. Never treat READY status, silence, an earlier approval or a scheduled tick as confirmation.",
			"Recollect readiness after a confirm result and before execute; if evidence changed, do not execute the token.",
			"Never retry rejected, failed, stale or unknown receipts automatically, and never fall back to Bash git push or make recipes when the tool refuses.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("confirm"), Type.Literal("execute")]),
			root: Type.Optional(Type.String({ maxLength: 4096, description: "confirm: canonical absolute worktree root" })),
			commit: Type.Optional(Type.String({ pattern: COMMIT.source, description: "confirm: expected tip, lowercase hex (7-64)" })),
			context: Type.Optional(Type.String({ maxLength: MAX_CONTEXT, description: "confirm: short caller context, shown as unverified" })),
			token: Type.Optional(Type.String({ pattern: TOKEN.source, description: "execute: token from a confirmed publication" })),
		}, { additionalProperties: false }),
		async execute(_id, params, signal, _update, ctx) {
			if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Commit publication requires interactive TUI confirmation");
			const active = session;
			if (!active || active.id !== ctx.sessionManager.getSessionId() || active.abort.signal.aborted) throw new Error("Publication session is no longer active");
			if (busy) throw new Error("Another commit publication operation is already running");
			busy = true;
			const operation = (async () => {
				const combined = signal ? AbortSignal.any([signal, active.abort.signal]) : active.abort.signal;
				if (params.action === "execute") {
					if (params.root !== undefined || params.commit !== undefined || params.context !== undefined || typeof params.token !== "string") {
						throw new Error("Execute accepts only a token from a confirmed publication");
					}
					const entry = tokens.get(params.token);
					tokens.delete(params.token);
					if (!entry || !TOKEN.test(params.token) || entry.sessionId !== active.id || now() > entry.expiresAt) {
						throw new Error("Publication token is unknown, used or expired; confirm again");
					}
					combined.throwIfAborted();
					return result(await executePublication(entry.request, entry.prepared, dependencies, {
						signal: combined,
						beforeLaunch: () => session === active && !combined.aborted,
					}));
				}
				if (params.token !== undefined) throw new Error("Confirm does not accept a token");
				const request: PublicationRequest = { root: params.root as string, commit: params.commit as string, ...(params.context !== undefined ? { context: params.context } : {}) };
				const prepared = await preparePublication(request, dependencies, combined);
				const occupancy = await observe(prepared.identity.root).catch(() => [] as WorktreeLeaseOccupancy[]);
				combined.throwIfAborted();
				const approved = await ctx.ui.confirm("Publish commit?", confirmation(prepared, occupancyLine(occupancy)), { timeout: CONFIRM_TIMEOUT_MS, signal: combined });
				if (session !== active || combined.aborted) throw new Error("Publication session changed during confirmation; nothing was authorized");
				const { trackingCommit: _tracking, ...identity } = prepared.identity;
				const advisory = occupancy.length === 1 ? occupancy[0]!.kind : "unavailable";
				if (!approved) return result({ status: "declined", ...identity, occupancy: advisory });
				const token = randomBytes(16).toString("hex");
				const expiresAt = now() + TOKEN_TTL_MS;
				tokens.set(token, { sessionId: active.id, request, prepared, expiresAt });
				return result({ status: "confirmed", token, expiresAt: new Date(expiresAt).toISOString(), ...identity, commitCount: prepared.display.commitCount, occupancy: advisory });
			})();
			pending.add(operation);
			try { return await operation; }
			catch (error) { throw new Error(safeDisplay(String(error)).slice(0, 4000)); }
			finally { pending.delete(operation); busy = false; }
		},
	});
	return lifecycle;
}
