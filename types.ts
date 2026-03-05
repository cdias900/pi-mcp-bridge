/**
 * Shared types and constants for the pi-mcp-bridge extension.
 *
 * These are intentionally dependency-light "leaf" modules so they can be
 * imported from other modules (server manager, tool registry, index, etc.)
 * without causing circular dependencies.
 */

import * as os from "node:os";
import * as path from "node:path";

/**
 * Derive pi home from PI_CODING_AGENT_DIR (e.g. ~/.pi-foo/agent → ~/.pi-foo)
 * Falls back to ~/.pi if the env var is not set.
 */
export const piHome = process.env.PI_CODING_AGENT_DIR
	? path.dirname(process.env.PI_CODING_AGENT_DIR)
	: path.join(os.homedir(), ".pi");

/**
 * MCP server configuration as read from `~/.pi/mcp.json` (global) or `.pi/mcp.json` (project).
 */
export interface McpServerConfig {
	/** Transport type. */
	type: "stdio" | "http" | "sse";

	/**
	 * For `stdio` servers: executable command to spawn.
	 *
	 * Example: `"uvx"`, `"node"`.
	 */
	command?: string;

	/**
	 * For `stdio` servers: command arguments.
	 */
	args?: string[];

	/**
	 * For `stdio` servers: environment variables (merged with `process.env`).
	 */
	env?: Record<string, string>;

	/**
	 * For `http`/`sse` servers: absolute MCP endpoint URL.
	 */
	url?: string;
}

/** Connection lifecycle status for a single MCP server. */
export type ServerStatus =
	| "disconnected"
	| "connecting"
	| "connected"
	| "error"
	| "disposed";

/**
 * A tool as returned by `client.listTools()`.
 *
 * This is the MCP tool shape we cache on disk and use for registration.
 */
export interface McpTool {
	name: string;
	description?: string;
	inputSchema: any;
	serverName: string;
}

/**
 * In-memory state for an MCP server managed by the bridge.
 */
export interface ServerState<ClientT = unknown, TransportT = unknown> {
	name: string;
	config: McpServerConfig;
	status: ServerStatus;

	/** Active MCP client instance (present when connected/connecting). */
	client?: ClientT;
	/** Active transport instance (present when connected/connecting). */
	transport?: TransportT;

	/** Latest known tools for this server (from cache or live discovery). */
	tools: McpTool[];

	/** Number of consecutive reconnect attempts since last successful connect. */
	retryCount: number;

	/** Timer handle for a scheduled reconnect attempt. */
	retryTimer?: ReturnType<typeof setTimeout>;

	/** Last connection or discovery error, if any. */
	error?: unknown;
}

/**
 * A disk cache entry for a single server.
 */
export interface CacheEntry {
	tools: McpTool[];
	/** SHA-256 hash of the server config JSON (see `hashConfig`). */
	configHash: string;
	/** Unix epoch time in milliseconds when this entry was last updated. */
	updatedAt: number;
}

/** Entire on-disk cache document shape. */
export type CacheData = Record<string, CacheEntry>;

/**
 * Convenience type for a fully-connected server instance.
 */
export interface ConnectedServer<ClientT = unknown, TransportT = unknown> {
	name: string;
	config: McpServerConfig;
	client: ClientT;
	transport: TransportT;
	tools: McpTool[];
}

/** Default per-server operation timeout (connect, listTools, callTool). */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Maximum time to allow for an interactive OAuth browser flow. */
export const OAUTH_TIMEOUT_MS = 120_000;

/** Maximum number of reconnection attempts before giving up. */
export const MAX_RETRIES = 5;

/** Initial reconnection delay for exponential backoff. */
export const INITIAL_RETRY_DELAY_MS = 1_000;

/** Maximum delay between reconnection attempts. */
export const MAX_RETRY_DELAY_MS = 30_000;

/** Exponential backoff factor applied to retry delay after each failure. */
export const RETRY_BACKOFF_FACTOR = 2;

/** Cache time-to-live (24 hours). */
export const CACHE_TTL_MS = 86_400_000;

/** Maximum number of servers to connect concurrently in background startup. */
export const MAX_CONCURRENT_CONNECTS = 4;
