// Local scripted replies for integration tests. Never contact a model service.
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createEditToolDefinition, createWriteToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Call = { name: "write" | "edit" | "multi_tool_use.parallel" | "activate_pi_package"; arguments: any };
export default function (pi: ExtensionAPI) {
	globalThis.fetch = async () => { throw new Error("Network is forbidden in the native-write fixture"); };
	pi.registerProvider("lease-fixture", {
		baseUrl: "http://127.0.0.1:1", apiKey: "fixture-only", api: "lease-fixture",
		models: [{ id: "fixed", name: "Scripted fixture (no model)", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const last = context.messages.at(-1);
				const text = last?.role === "user" ? typeof last.content === "string" ? last.content : last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
				const request: { label: string; calls: Call[] } = text.startsWith("fixture:") ? JSON.parse(text.slice(8)) : { label: "done", calls: [] };
				const output: AssistantMessage = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: [], stopReason: request.calls.length ? "toolUse" : "stop", timestamp: Date.now(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				stream.push({ type: "start", partial: output });
				for (const [index, call] of request.calls.entries()) {
					const toolCall = { type: "toolCall" as const, id: `${request.label}_${index}`, ...call };
					output.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
					stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
				}
				if (!request.calls.length) {
					output.content.push({ type: "text", text: `fixture-complete:${request.label}` });
					stream.push({ type: "text_start", contentIndex: 0, partial: output });
					stream.push({ type: "text_end", contentIndex: 0, content: `fixture-complete:${request.label}`, partial: output });
				}
				stream.push({ type: "done", reason: output.stopReason as "toolUse" | "stop", message: output });
				stream.end();
			});
			return stream;
		},
	});
	pi.registerTool({
		name: "multi_tool_use.parallel", label: "Fixture parallel wrapper", description: "Execute the supported native wrapper contract in tests",
		parameters: Type.Object({ tool_uses: Type.Array(Type.Object({ recipient_name: Type.String(), parameters: Type.Any() })) }),
		async execute(id, args, signal, onUpdate, ctx) {
			const results = await Promise.all(args.tool_uses.map((call, index) => {
				const tool = call.recipient_name === "functions.write" ? createWriteToolDefinition(ctx.cwd) : call.recipient_name === "functions.edit" ? createEditToolDefinition(ctx.cwd) : undefined;
				if (!tool) throw new Error("Unsupported fixture dispatch");
				return tool.execute(`${id}_${index}`, call.parameters, signal, onUpdate, ctx);
			}));
			return { content: results.flatMap((result) => result.content), details: undefined };
		},
	});
	pi.registerCommand("fixture-reload", { description: "Reload the isolated test runtime", handler: async (_args, ctx) => { await ctx.reload(); } });
	pi.registerCommand("fixture-snapshot", {
		description: "Inspect isolated test state without acquiring anything",
		handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify({
			fixtureSnapshot: true, tools: pi.getActiveTools(),
			saved: ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "session-mode").at(-1),
		})),
	});
}
