/**
 * MCP server connection lifecycle manager.
 *
 * Responsibilities:
 * - Load and merge MCP server configs from PI config locations.
 * - Establish MCP connections (stdio + http) with a hard timeout.
 * - Discover tools (with pagination) and notify the extension entrypoint.
 * - Detect transport closure and schedule reconnection with exponential backoff.
 * - Perform defensive process cleanup for stdio transports.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

import {
	DEFAULT_TIMEOUT_MS,
	INITIAL_RETRY_DELAY_MS,
	MAX_CONCURRENT_CONNECTS,
	MAX_RETRIES,
	MAX_RETRY_DELAY_MS,
	OAUTH_TIMEOUT_MS,
	RETRY_BACKOFF_FACTOR,
	piHome,
} from "./types.js";
import type { McpServerConfig, McpTool, ServerState } from "./types.js";

import { BridgeOAuthProvider, OAUTH_CALLBACK_PORT } from "./oauth.js";
import { createCallbackServer } from "./callback-server.js";

const GLOBAL_MCP_CONFIG = path.join(piHome, "mcp.json");
const PROJECT_MCP_CONFIG = path.join(process.cwd(), ".pi", "mcp.json");

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function toErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	try {
		return typeof err === "string" ? err : JSON.stringify(err);
	} catch {
		return String(err);
	}
}

function resolveEnv(env: Record<string, string> | undefined): Record<string, string> {
	const merged: Record<string, string> = {};

	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === "string") merged[k] = v;
	}

	if (env) {
		for (const [k, v] of Object.entries(env)) {
			if (typeof v === "string") merged[k] = v;
		}
	}

	return merged;
}

function loadConfigFile(filePath: string): Record<string, McpServerConfig> {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed: unknown = JSON.parse(raw);

		if (!isPlainObject(parsed)) return {};

		const out: Record<string, McpServerConfig> = {};
		for (const [name, value] of Object.entries(parsed)) {
			if (!isPlainObject(value)) continue;
			const type = (value as any).type;
			if (type !== "stdio" && type !== "http" && type !== "sse") continue;

			const cfg: McpServerConfig = { type };
			if (typeof (value as any).command === "string") cfg.command = (value as any).command;
			if (Array.isArray((value as any).args)) {
				cfg.args = (value as any).args.filter((a: unknown) => typeof a === "string");
			}
			if (isPlainObject((value as any).env)) {
				const env: Record<string, string> = {};
				for (const [k, v] of Object.entries((value as any).env)) {
					if (typeof v === "string") env[k] = v;
				}
				cfg.env = env;
			}
			if (typeof (value as any).url === "string") cfg.url = (value as any).url;

			out[name] = cfg;
		}

		return out;
	} catch {
		// Missing or invalid file is treated as empty.
		return {};
	}
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			reject(new Error(`Timeout after ${timeoutMs}ms: ${label}`));
		}, timeoutMs);
	});

	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		// CRITICAL: clearTimeout to avoid phantom timeouts after the raced promise resolves.
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}

function scheduleSigkill(proc: any, delayMs: number): void {
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		killTimer = setTimeout(() => {
			try {
				proc.kill?.("SIGKILL");
			} catch {
				// ignore
			}
		}, delayMs);

		proc.once?.("exit", () => {
			if (killTimer) clearTimeout(killTimer);
		});
	} catch {
		if (killTimer) clearTimeout(killTimer);
	}
}

function bestEffortKillStdioProcess(transport: unknown): void {
	const proc = (transport as any)?._process;
	if (!proc || typeof proc.kill !== "function") return;

	try {
		proc.kill("SIGTERM");
	} catch {
		// ignore
	}

	// Escalate if the process doesn't exit.
	scheduleSigkill(proc, 5_000);
}

interface InternalServerState extends ServerState<Client, unknown> {
	/** Only set while a connect attempt is in-flight; used to coalesce concurrent calls. */
	connectPromise?: Promise<void>;
	/** Monotonic id used to ignore stale connect results. */
	connectAttemptId: number;
	/** Guards against concurrent tools refresh on listChanged. */
	refreshingTools?: boolean;
}

/**
 * Manages MCP server connections and reconnection logic.
 */
export class ServerManager {
	private readonly _pi: ExtensionAPI;
	private readonly servers = new Map<string, InternalServerState>();
	private configs: Record<string, McpServerConfig> = {};

	/** Global lock used to serialize interactive OAuth flows (single callback port). */
	private _oauthInProgress: Promise<void> | null = null;

	/**
	 * Called whenever a server's tool list is refreshed (initial connect, reconnect, listChanged).
	 *
	 * The entrypoint should re-register tools for `serverName` and update the disk cache.
	 */
	public onToolsUpdated: (serverName: string, tools: McpTool[]) => void = () => {};

	constructor(pi: ExtensionAPI) {
		this._pi = pi;
	}

	/**
	 * Load MCP server configurations.
	 *
	 * Precedence:
	 * - If `PI_MCP_CONFIG` is set: load ONLY that file (no merge)
	 * - Else: merge global (`~/.pi/mcp.json`) with project-local (`.pi/mcp.json`) where
	 *   project-local overrides global per server name.
	 */
	loadMcpConfigs(): Record<string, McpServerConfig> {
		const override = process.env.PI_MCP_CONFIG;
		const loaded = override
			? loadConfigFile(override)
			: { ...loadConfigFile(GLOBAL_MCP_CONFIG), ...loadConfigFile(PROJECT_MCP_CONFIG) };

		this.configs = loaded;

		// Remove servers that no longer exist in config.
		for (const existing of Array.from(this.servers.keys())) {
			if (!loaded[existing]) {
				this.disconnectServer(existing).catch((err) =>
					console.error(`[mcp-bridge] Failed to disconnect removed server ${existing}:`, err),
				);
				this.servers.delete(existing);
			}
		}

		// Add/update configured servers.
		for (const [name, config] of Object.entries(loaded)) {
			const existing = this.servers.get(name);
			if (existing) {
				existing.config = config;
				if (existing.status === "disposed") existing.status = "disconnected";
			} else {
				this.servers.set(name, {
					name,
					config,
					status: "disconnected",
					tools: [],
					retryCount: 0,
					retryTimer: undefined,
					error: undefined,
					connectAttemptId: 0,
				});
			}
		}

		return loaded;
	}

	/** Returns a single server state. */
	getServer(name: string): ServerState<Client, unknown> | undefined {
		return this.servers.get(name);
	}

	/** Returns all server states. */
	getServers(): Array<ServerState<Client, unknown>> {
		return Array.from(this.servers.values());
	}

	/**
	 * Returns the live MCP client for a server, or null if not connected.
	 */
	getClient(name: string): Client | null {
		const state = this.servers.get(name);
		if (!state) return null;
		if (state.status !== "connected") return null;
		return state.client ?? null;
	}

	/**
	 * Connect to a specific server.
	 *
	 * This method is idempotent:
	 * - Concurrent calls are coalesced.
	 * - If already connected, it returns immediately.
	 */
	async connectServer(name: string): Promise<void> {
		const state = this.servers.get(name);
		if (!state) {
			console.error(`[mcp-bridge] connectServer: unknown server "${name}"`);
			return;
		}

		if (state.status === "connected") return;
		if (state.connectPromise) return state.connectPromise;

		// Clear any scheduled reconnect; we're connecting now.
		if (state.retryTimer) {
			clearTimeout(state.retryTimer);
			state.retryTimer = undefined;
		}

		state.connectAttemptId += 1;
		const attemptId = state.connectAttemptId;
		state.status = "connecting";
		state.error = undefined;

		const promise = this.connectServerInternal(name, attemptId);
		state.connectPromise = promise.finally(() => {
			const current = this.servers.get(name);
			if (current && current.connectPromise === promise) current.connectPromise = undefined;
		});

		return state.connectPromise;
	}

	/**
	 * Connect all configured servers with a concurrency limit.
	 */
	async connectAll(_ctx?: any): Promise<void> {
		const names = Array.from(this.servers.keys());
		if (names.length === 0) return;

		let index = 0;
		const workerCount = Math.min(MAX_CONCURRENT_CONNECTS, names.length);

		const workers = Array.from({ length: workerCount }, async () => {
			while (true) {
				const name = names[index++];
				if (!name) return;
				try {
					await this.connectServer(name);
				} catch (err) {
					console.error(`[mcp-bridge] connectAll: failed to connect ${name}:`, err);
				}
			}
		});

		await Promise.all(workers);
	}

	/**
	 * Disconnect a specific server.
	 */
	async disconnectServer(name: string): Promise<void> {
		const state = this.servers.get(name);
		if (!state) return;

		if (state.retryTimer) {
			clearTimeout(state.retryTimer);
			state.retryTimer = undefined;
		}

		state.status = "disposed";
		state.retryCount = 0;

		const client = state.client;
		const transport = state.transport;

		state.client = undefined;
		state.transport = undefined;

		// Best-effort process cleanup for stdio transports.
		if (state.config.type === "stdio") {
			bestEffortKillStdioProcess(transport);
		}

		try {
			await client?.close();
		} catch {
			// ignore
		}

		// Kill again after close in case the transport didn't expose the process early.
		if (state.config.type === "stdio") {
			bestEffortKillStdioProcess(transport);
		}
	}

	/**
	 * Disconnect all servers and clear all timers.
	 */
	async disconnectAll(): Promise<void> {
		const names = Array.from(this.servers.keys());
		await Promise.allSettled(names.map((name) => this.disconnectServer(name)));
	}

	/**
	 * Paginated tool discovery.
	 */
	async listToolsPaginated(client: Client, serverName: string): Promise<McpTool[]> {
		const tools: McpTool[] = [];
		const seen = new Set<string>();

		let cursor: string | undefined = undefined;
		while (true) {
			const result = cursor ? await client.listTools({ cursor }) : await client.listTools();
			const pageTools = Array.isArray((result as any).tools) ? ((result as any).tools as any[]) : [];
			for (const t of pageTools) {
				if (!t || typeof t !== "object") continue;
				if (typeof (t as any).name !== "string" || !(t as any).name) continue;
				const name = (t as any).name as string;
				if (seen.has(name)) continue;
				seen.add(name);

				tools.push({
					name,
					description: typeof (t as any).description === "string" ? (t as any).description : undefined,
					inputSchema: (t as any).inputSchema,
					serverName,
				});
			}

			const nextCursor = (result as any).nextCursor;
			if (!nextCursor || typeof nextCursor !== "string") break;
			if (nextCursor === cursor) break; // defensive: prevent infinite loops
			cursor = nextCursor;
		}

		return tools;
	}

	private async connectServerInternal(name: string, attemptId: number): Promise<void> {
		const state = this.servers.get(name);
		if (!state) return;

		// If a previous client/transport is still around, close it first.
		await this.closeWithoutDisposing(state);

		let client: Client | undefined;
		let transport: unknown;

		try {
			const connectAndDiscover = async (opts?: { authProvider?: BridgeOAuthProvider }) => {
				const connected = await this.createAndConnect(
					name,
					state.config,
					(c, t) => {
						client = c;
						transport = t;
					},
					opts,
				);
				client = connected.client;
				transport = connected.transport;

				const tools = await this.listToolsPaginated(client, name);
				return { client, transport, tools };
			};

			const connectLabel = `connect ${name}`;

			const { client: connectedClient, transport: connectedTransport, tools } =
				state.config.type === "http"
					? await this.withOAuthLock(async () => {
							const authProvider = new BridgeOAuthProvider(name, OAUTH_CALLBACK_PORT);

							try {
								return await raceWithTimeout(connectAndDiscover({ authProvider }), OAUTH_TIMEOUT_MS, connectLabel);
							} catch (err) {
								if (!(err instanceof UnauthorizedError)) throw err;

								const callbackServer = createCallbackServer(OAUTH_CALLBACK_PORT);
								try {
									const code = await raceWithTimeout(
										callbackServer.waitForCode(),
										OAUTH_TIMEOUT_MS,
										`oauth ${name}`,
									);

									const finishAuth = (transport as any)?.finishAuth;
									if (typeof finishAuth !== "function") {
										throw new Error("OAuth transport does not support finishAuth()");
									}

									await finishAuth.call(transport, code);
								} finally {
									callbackServer.close();
								}

								// Best-effort cleanup of the failed attempt before retry.
								await this.safeClose(client, transport, "http");
								client = undefined;
								transport = undefined;

								return await raceWithTimeout(
									connectAndDiscover({ authProvider }),
									DEFAULT_TIMEOUT_MS,
									`${connectLabel} (after auth)`,
								);
							}
						})
					: await raceWithTimeout(connectAndDiscover(), DEFAULT_TIMEOUT_MS, connectLabel);

			const current = this.servers.get(name);
			if (!current) {
				await this.safeClose(connectedClient, connectedTransport, state.config.type);
				return;
			}
			if (current.connectAttemptId !== attemptId || current.status === "disposed") {
				// Stale result; close resources and ignore.
				await this.safeClose(connectedClient, connectedTransport, state.config.type);
				return;
			}

			current.client = connectedClient;
			current.transport = connectedTransport;
			current.tools = tools;
			current.status = "connected";
			current.error = undefined;
			current.retryCount = 0;

			try {
				this.onToolsUpdated(name, tools);
			} catch (err) {
				console.error(`[mcp-bridge] onToolsUpdated callback failed for ${name}:`, err);
			}
		} catch (err) {
			const current = this.servers.get(name);
			if (current && current.connectAttemptId === attemptId) {
				current.status = "error";
				current.error = toErrorMessage(err);
				current.client = undefined;
				current.transport = undefined;
			}

			await this.safeClose(client, transport, state.config.type);

			// Schedule reconnect attempts unless intentionally disposed.
			if (!(err instanceof UnauthorizedError)) {
				this.scheduleReconnect(name);
			}
		}
	}

	private async withOAuthLock<T>(fn: () => Promise<T>): Promise<T> {
		while (this._oauthInProgress) {
			try {
				await this._oauthInProgress;
			} catch {
				// ignore — lock should never reject.
			}
		}

		let release: (() => void) | undefined;
		const lock = new Promise<void>((resolve) => {
			release = resolve;
		});
		this._oauthInProgress = lock;

		try {
			return await fn();
		} finally {
			release?.();
			if (this._oauthInProgress === lock) this._oauthInProgress = null;
		}
	}

	private createClient(serverName: string): Client {
		const client = new Client(
			{ name: "pi-mcp-bridge", version: "1.0.0" },
			{
				listChanged: {
					tools: {
						onChanged: async (_error: unknown) => {
							// Always refetch from the server to ensure pagination is respected.
							await this.refreshTools(serverName, client);
						},
					},
				},
			},
		);

		return client;
	}

	private async refreshTools(serverName: string, client: Client): Promise<void> {
		const state = this.servers.get(serverName);
		if (!state) return;
		if (state.status !== "connected") return;
		if (state.client !== client) return; // stale client
		if (state.refreshingTools) return;

		state.refreshingTools = true;
		try {
			const tools = await this.listToolsPaginated(client, serverName);
			state.tools = tools;

			try {
				this.onToolsUpdated(serverName, tools);
			} catch (err) {
				console.error(`[mcp-bridge] onToolsUpdated callback failed for ${serverName}:`, err);
			}
		} catch (err) {
			console.error(`[mcp-bridge] Failed to refresh tools for ${serverName}:`, err);
		} finally {
			state.refreshingTools = false;
		}
	}

	private attachCloseHandlers(serverName: string, client: Client, transport: unknown): void {
		const state = this.servers.get(serverName);
		if (!state) return;

		const handle = (reason?: unknown) => {
			const current = this.servers.get(serverName);
			if (!current) return;
			if (current.status === "disposed") return;

			// If the server was connected, mark it disconnected and schedule reconnect.
			if (current.status === "connected" || current.status === "connecting") {
				current.status = "disconnected";
			}

			if (reason !== undefined) {
				current.error = toErrorMessage(reason);
			}

			current.client = undefined;
			current.transport = undefined;

			this.scheduleReconnect(serverName);
		};

		// Hook transport.onclose without breaking the SDK's handler.
		if (transport && typeof transport === "object") {
			const prev = (transport as any).onclose;
			(transport as any).onclose = (...args: any[]) => {
				try {
					if (typeof prev === "function") prev(...args);
				} catch {
					// ignore
				}
				handle(args[0]);
			};
		}

		// Also hook client.onclose if present (defensive across transport implementations).
		const prevClientOnClose = (client as any).onclose;
		(client as any).onclose = (...args: any[]) => {
			try {
				if (typeof prevClientOnClose === "function") prevClientOnClose(...args);
			} catch {
				// ignore
			}
			handle(args[0]);
		};
	}

	private async createAndConnect(
		serverName: string,
		config: McpServerConfig,
		onCreated?: (client: Client, transport: unknown) => void,
		opts?: { authProvider?: BridgeOAuthProvider },
	): Promise<{ client: Client; transport: unknown }> {
		if (config.type === "stdio") {
			if (!config.command) {
				throw new Error(`Missing command for stdio server "${serverName}"`);
			}

			const transport = new StdioClientTransport({
				command: config.command,
				args: config.args ?? [],
				env: resolveEnv(config.env),
				stderr: "pipe",
			});

			const client = this.createClient(serverName);
			onCreated?.(client, transport);
			await client.connect(transport);
			this.attachCloseHandlers(serverName, client, transport);
			return { client, transport };
		}

		if (!config.url) {
			throw new Error(`Missing url for server "${serverName}" (${config.type})`);
		}

		const url = new URL(config.url);

		if (config.type === "sse") {
			const transport = new SSEClientTransport(url);
			const client = this.createClient(serverName);
			onCreated?.(client, transport);
			await client.connect(transport);
			this.attachCloseHandlers(serverName, client, transport);
			return { client, transport };
		}

		// HTTP: try Streamable HTTP first, fall back to SSE.
		const authProvider = opts?.authProvider ?? new BridgeOAuthProvider(serverName, OAUTH_CALLBACK_PORT);

		let httpClient: Client | undefined;
		let httpTransport: unknown;

		try {
			httpTransport = new StreamableHTTPClientTransport(url, { authProvider });
			httpClient = this.createClient(serverName);
			onCreated?.(httpClient, httpTransport);
			await httpClient.connect(httpTransport);
			this.attachCloseHandlers(serverName, httpClient, httpTransport);
			return { client: httpClient, transport: httpTransport };
		} catch (err) {
			if (err instanceof UnauthorizedError) {
				throw err;
			}

			const streamableHttpNotSupported =
				err instanceof StreamableHTTPError
					? err.code === 404 || err.code === 405 || err.code === 415
					: /method not allowed|not found/.test(toErrorMessage(err).toLowerCase());

			// Best-effort cleanup of the failed attempt.
			await this.safeClose(httpClient, httpTransport, "http");

			// Only fall back to legacy SSE when StreamableHTTP is clearly unsupported by the server.
			if (!streamableHttpNotSupported) {
				throw err;
			}

			let sseClient: Client | undefined;
			let sseTransport: unknown;
			try {
				sseTransport = new SSEClientTransport(url, { authProvider });
				sseClient = this.createClient(serverName);
				onCreated?.(sseClient, sseTransport);
				await sseClient.connect(sseTransport);
				this.attachCloseHandlers(serverName, sseClient, sseTransport);
				return { client: sseClient, transport: sseTransport };
			} catch (err2) {
				if (err2 instanceof UnauthorizedError) {
					throw err2;
				}

				await this.safeClose(sseClient, sseTransport, "sse");
				const msg1 = toErrorMessage(err);
				const msg2 = toErrorMessage(err2);
				throw new Error(`HTTP connect failed for ${serverName}: streamable=(${msg1}), sse=(${msg2})`);
			}
		}
	}

	private scheduleReconnect(name: string): void {
		const state = this.servers.get(name);
		if (!state) return;
		if (state.status === "disposed") return;
		if (state.retryTimer) return;

		if (state.retryCount >= MAX_RETRIES) {
			state.status = "error";
			state.error = state.error ?? `Max reconnect attempts (${MAX_RETRIES}) reached`;
			return;
		}

		const delay = Math.min(
			INITIAL_RETRY_DELAY_MS * RETRY_BACKOFF_FACTOR ** state.retryCount,
			MAX_RETRY_DELAY_MS,
		);
		state.retryCount += 1;

		state.retryTimer = setTimeout(() => {
			const current = this.servers.get(name);
			if (!current) return;
			current.retryTimer = undefined;
			if (current.status === "disposed") return;
			this.connectServer(name).catch((err) =>
				console.error(`[mcp-bridge] Reconnect attempt failed for ${name}:`, err),
			);
		}, delay);
	}

	private async closeWithoutDisposing(state: InternalServerState): Promise<void> {
		const client = state.client;
		const transport = state.transport;
		if (!client && !transport) return;

		state.client = undefined;
		state.transport = undefined;

		await this.safeClose(client, transport, state.config.type);
	}

	private async safeClose(
		client: Client | undefined,
		transport: unknown,
		transportType: McpServerConfig["type"],
	): Promise<void> {
		// For stdio, try to kill the child process. This is best-effort and uses private SDK fields.
		if (transportType === "stdio") {
			bestEffortKillStdioProcess(transport);
		}

		try {
			await client?.close();
		} catch {
			// ignore
		}
	}
}
