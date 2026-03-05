/**
 * PI MCP Bridge — Extension entrypoint.
 *
 * This extension connects to MCP servers configured in `~/.pi/mcp.json` and `.pi/mcp.json`,
 * discovers their tools, and registers them as PI tools using the naming scheme:
 *
 *   `mcp__{serverName}__{toolName}`
 *
 * It supports cached tool registration on startup and background connection.
 */

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
	clearCache as clearDiskCache,
	hashConfig,
	isCacheValid,
	loadCache,
	saveCache,
} from "./cache.js";
import { registerCommands } from "./commands.js";
import { jsonSchemaToTypebox } from "./schema.js";
import { ServerManager } from "./server-manager.js";
import type { CacheData, McpServerConfig, McpTool } from "./types.js";

function truncateText(text: string): string {
	const truncated = truncateHead(text, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});

	return truncated.truncated ? `${truncated.content}\n[truncated]` : truncated.content;
}

function safeStringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function toolFullName(serverName: string, toolName: string): string {
	return `mcp__${serverName}__${toolName}`;
}

function registerConnectingPlaceholder(pi: ExtensionAPI, serverManager: ServerManager, serverName: string): void {
	pi.registerTool({
		name: toolFullName(serverName, "connecting"),
		label: `MCP ${serverName} (connecting)`,
		description: "Server connecting...",
		promptSnippet: "Server connecting...",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			const state = serverManager.getServer(serverName);
			const status = state?.status ?? "disconnected";
			if (status === "connected") {
				return {
					content: [
						{ type: "text", text: `${serverName} is connected. Use tools prefixed ${toolFullName(serverName, "<tool>")}.` },
					],
				};
			}

			return {
				content: [
					{ type: "text", text: `${serverName} is not connected (status: ${status}). Try /mcp-reload ${serverName}` },
				],
				isError: true,
			};
		},
	});
}

function registerToolsForServer(
	pi: ExtensionAPI,
	serverManager: ServerManager,
	serverName: string,
	tools: McpTool[],
	options: { cached: boolean },
): void {
	for (const tool of tools) {
		const mcpToolName = tool.name;
		const fullName = toolFullName(serverName, mcpToolName);
		const description = tool.description ?? `MCP tool ${mcpToolName} from ${serverName}`;
		const promptSnippet = options.cached ? `${description} (cached — connecting...)` : description;
		const parameters = jsonSchemaToTypebox(tool.inputSchema);

		pi.registerTool({
			name: fullName,
			label: `${mcpToolName} (${serverName})`,
			description,
			promptSnippet,
			parameters,

			async execute(_id, params, _signal, _onUpdate, _ctx) {
				let client = serverManager.getClient(serverName);

				// If not connected yet, wait for in-flight connection (up to 30s)
				if (!client) {
					const state = serverManager.getServer(serverName);
					if (state && (state.status === "connecting" || state.status === "disconnected")) {
						// Trigger connect if not already in progress
						if (state.status === "disconnected") {
							serverManager.connectServer(serverName).catch(() => {});
						}
						// Poll for connection (every 500ms, up to 30s)
						const deadline = Date.now() + 30_000;
						while (Date.now() < deadline) {
							await new Promise((r) => setTimeout(r, 500));
							client = serverManager.getClient(serverName);
							if (client) break;
							const current = serverManager.getServer(serverName);
							if (current && current.status === "error") break;
						}
					}
				}

				if (!client) {
					const state = serverManager.getServer(serverName);
					const detail = state?.error ? `: ${state.error}` : "";
					return {
						content: [{ type: "text", text: `Server "${serverName}" not connected${detail}. Try /mcp-reload` }],
						isError: true,
					};
				}

				try {
					const result: any = await client.callTool({
						name: mcpToolName,
						arguments: params,
					});

					const content: any[] = [];

					if (result && Array.isArray(result.content)) {
						for (const item of result.content) {
							if (!item || typeof item !== "object") continue;

							if (item.type === "text") {
								content.push({ type: "text", text: truncateText(String(item.text ?? "")) });
								continue;
							}

							if (item.type === "image") {
								content.push({
									type: "image",
									data: item.data ?? "",
									mimeType: item.mimeType ?? "image/png",
								});
								continue;
							}

							if (item.type === "resource") {
								const res = (item as any).resource;
								if (res?.text) {
									content.push({
										type: "text",
										text: truncateText(`Resource (${res.uri ?? "unknown"}):\n${String(res.text)}`),
									});
								} else if (res?.blob) {
									content.push({
										type: "text",
										text: `Resource (${res.uri ?? "unknown"}): [binary data]`,
									});
								}
								continue;
							}

							// Unknown content item.
							content.push({ type: "text", text: truncateText(safeStringify(item)) });
						}
					} else if (result && "toolResult" in result) {
						content.push({ type: "text", text: truncateText(safeStringify(result.toolResult)) });
					}

					if (content.length === 0) content.push({ type: "text", text: "(no output)" });

					return {
						content,
						isError: result?.isError === true,
						details: { server: serverName, tool: mcpToolName },
					};
				} catch (err) {
					return {
						content: [
							{
								type: "text",
								text: truncateText(`MCP error (${serverName}/${mcpToolName}): ${err instanceof Error ? err.message : String(err)}`),
							},
						],
						isError: true,
						details: { server: serverName, tool: mcpToolName },
					};
				}
			},
		});
	}
}

/**
 * Extension entrypoint.
 */
export default function (pi: ExtensionAPI): void {
	const serverManager = new ServerManager(pi);
	let configs: Record<string, McpServerConfig> = {};
	let cacheData: CacheData = {};
	let initialized = false;

	serverManager.onToolsUpdated = (serverName, tools) => {
		try {
			// Register live tools (replaces cached tools/placeholder behavior).
			registerToolsForServer(pi, serverManager, serverName, tools, { cached: false });
		} catch (err) {
			console.error(`[mcp-bridge] Failed to register tools for ${serverName}:`, err);
		}

		try {
			// Update cache on disk.
			const config = configs[serverName] ?? serverManager.getServer(serverName)?.config;
			if (!config) return;

			cacheData[serverName] = {
				tools,
				configHash: hashConfig(config),
				updatedAt: Date.now(),
			};

			saveCache(cacheData);
		} catch (err) {
			console.error(`[mcp-bridge] Failed to update cache for ${serverName}:`, err);
		}
	};

	function loadConfigAndRegisterInitialTools(ctx?: any): string[] {
		configs = serverManager.loadMcpConfigs();
		cacheData = loadCache();

		const serverNames = Object.keys(configs);
		if (serverNames.length === 0) {
				const piHome = process.env.PI_CODING_AGENT_DIR
				? require("node:path").dirname(process.env.PI_CODING_AGENT_DIR)
				: "~/.pi";
			ctx?.ui?.notify?.(`No MCP servers found. Add them to ${piHome}/mcp.json or .pi/mcp.json`, "warning");
			return [];
		}

		for (const serverName of serverNames) {
			const config = configs[serverName];
			const state = serverManager.getServer(serverName);
			const entry = cacheData[serverName];

			if (entry && isCacheValid(entry, config)) {
				const cachedTools = (entry.tools ?? []).map((t) => ({ ...t, serverName }));
				if (state) state.tools = cachedTools;
				registerToolsForServer(pi, serverManager, serverName, cachedTools, { cached: true });
			} else {
				if (state) state.tools = [];
				registerConnectingPlaceholder(pi, serverManager, serverName);
			}
		}

		return serverNames;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (initialized) return;
		initialized = true;

		const serverNames = loadConfigAndRegisterInitialTools(ctx);
		if (serverNames.length === 0) return;

		// Connect in the background; do not block session start.
		void serverManager.connectAll(ctx).catch((err) => console.error("[mcp-bridge] connectAll failed:", err));
		ctx?.ui?.notify?.(`MCP: connecting to ${serverNames.length} server(s) in background...`, "info");
	});

	pi.on("session_shutdown", async () => {
		await serverManager.disconnectAll();
	});

	registerCommands(pi, serverManager, {
		reloadServer: async (serverName: string, ctx?: any) => {
			configs = serverManager.loadMcpConfigs();
			cacheData = loadCache();

			const config = configs[serverName];
			if (!config) {
				ctx?.ui?.notify?.(`Unknown MCP server: ${serverName}`, "warning");
				return;
			}

			// Ensure tools exist immediately (from cache or placeholder) while reconnecting.
			const state = serverManager.getServer(serverName);
			const entry = cacheData[serverName];
			if (entry && isCacheValid(entry, config)) {
				const cachedTools = (entry.tools ?? []).map((t) => ({ ...t, serverName }));
				if (state) state.tools = cachedTools;
				registerToolsForServer(pi, serverManager, serverName, cachedTools, { cached: true });
			} else {
				if (state) state.tools = [];
				registerConnectingPlaceholder(pi, serverManager, serverName);
			}

			await serverManager.disconnectServer(serverName);
			await serverManager.connectServer(serverName);
		},
		reloadAll: async (ctx?: any) => {
			await serverManager.disconnectAll();
			const serverNames = loadConfigAndRegisterInitialTools(ctx);
			if (serverNames.length === 0) return;
			await serverManager.connectAll(ctx);
		},
		clearCache: async (_ctx?: any) => {
			clearDiskCache();
			cacheData = {};
		},
	});
}
