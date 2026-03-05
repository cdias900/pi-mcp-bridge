/**
 * Slash commands for the MCP bridge.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { ServerState } from "./types.js";
import { ServerManager } from "./server-manager.js";

/**
 * Callbacks provided by the entrypoint to implement command actions.
 */
export interface ToolRegistryCallbacks {
	reloadServer: (serverName: string, ctx?: any) => Promise<void>;
	reloadAll: (ctx?: any) => Promise<void>;
	clearCache: (ctx?: any) => Promise<void>;
}

function parseArgs(args: unknown): string[] {
	if (Array.isArray(args)) return args.map(String).filter(Boolean);
	if (typeof args === "string") return args.split(/\s+/g).filter(Boolean);
	return [];
}

function statusIcon(status: ServerState["status"]): string {
	switch (status) {
		case "connected":
			return "🟢";
		case "connecting":
			return "🟡";
		case "error":
			return "🔴";
		case "disposed":
		case "disconnected":
		default:
			return "⚪";
	}
}

/**
 * Register `/mcp*` commands.
 */
export function registerCommands(
	pi: ExtensionAPI,
	serverManager: ServerManager,
	toolRegistryCallbacks: ToolRegistryCallbacks,
): void {
	pi.registerCommand("mcp", {
		description: "List MCP servers, status, and tool counts",
		handler: async (_args, ctx) => {
			const servers = serverManager.getServers();
			if (servers.length === 0) {
				ctx.ui?.notify?.("No MCP servers configured. Add them to ~/.pi/mcp.json or .pi/mcp.json", "warning");
				return;
			}

			let totalTools = 0;
			const lines = servers
				.slice()
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((s) => {
					const count = Array.isArray(s.tools) ? s.tools.length : 0;
					totalTools += count;
					const status = s.status;
					const err = status === "error" && s.error ? ` — ${String(s.error)}` : "";
					return `${statusIcon(status)} ${s.name} — ${status} — ${count} tools${err}`;
				});

			ctx.ui?.notify?.(`MCP servers (${servers.length})\n${lines.join("\n")}\n\nTotal tools: ${totalTools}`, "info");
		},
	});

	pi.registerCommand("mcp-reload", {
		description: "Reconnect MCP servers. Usage: /mcp-reload [server-name]",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			const target = parsed[0];

			try {
				if (target) {
					ctx.ui?.notify?.(`Reloading MCP server: ${target}...`, "info");
					await toolRegistryCallbacks.reloadServer(target, ctx);
					ctx.ui?.notify?.(`MCP server reloaded: ${target}`, "success");
				} else {
					ctx.ui?.notify?.("Reloading all MCP servers...", "info");
					await toolRegistryCallbacks.reloadAll(ctx);
					ctx.ui?.notify?.("MCP servers reloaded", "success");
				}
			} catch (err) {
				ctx.ui?.notify?.(`MCP reload failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerCommand("mcp-cache-clear", {
		description: "Clear the MCP tool cache on disk",
		handler: async (_args, ctx) => {
			try {
				await toolRegistryCallbacks.clearCache(ctx);
				ctx.ui?.notify?.("MCP cache cleared", "success");
			} catch (err) {
				ctx.ui?.notify?.(
					`Failed to clear MCP cache: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});
}
