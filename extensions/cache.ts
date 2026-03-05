/**
 * Disk cache utilities for MCP tool discovery.
 *
 * Cache file location:
 *   `~/.pi/mcp-cache.json`
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CACHE_TTL_MS } from "./types.js";
import type { CacheData, CacheEntry, McpServerConfig, McpTool } from "./types.js";

const CACHE_FILE_NAME = "mcp-cache.json";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function coerceTool(value: unknown, serverName: string): McpTool | null {
	if (!isPlainObject(value)) return null;
	const name = value.name;
	if (typeof name !== "string" || name.length === 0) return null;

	const description = typeof value.description === "string" ? value.description : undefined;
	const inputSchema = (value as any).inputSchema;
	const cachedServerName = typeof value.serverName === "string" ? value.serverName : serverName;

	return {
		name,
		description,
		inputSchema,
		serverName: cachedServerName,
	};
}

function coerceEntry(value: unknown, serverName: string): CacheEntry | null {
	if (!isPlainObject(value)) return null;

	const toolsRaw = (value as any).tools;
	const tools: McpTool[] = Array.isArray(toolsRaw)
		? toolsRaw
				.map((t) => coerceTool(t, serverName))
				.filter((t): t is McpTool => t !== null)
		: [];

	const configHash = typeof (value as any).configHash === "string" ? (value as any).configHash : "";
	const updatedAt = typeof (value as any).updatedAt === "number" ? (value as any).updatedAt : 0;

	if (!configHash || !updatedAt) return null;

	return { tools, configHash, updatedAt };
}

/**
 * Returns the absolute path to the MCP tool cache file.
 */
export function getCachePath(): string {
	return path.join(os.homedir(), ".pi", CACHE_FILE_NAME);
}

/**
 * Loads the MCP tool cache from disk.
 *
 * Resilience:
 * - Returns `{}` if the file doesn't exist.
 * - Returns `{}` on any read/parse/validation error (corrupt cache tolerance).
 */
export function loadCache(): CacheData {
	const cachePath = getCachePath();
	try {
		const raw = fs.readFileSync(cachePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isPlainObject(parsed)) return {};

		const result: CacheData = {};
		for (const [serverName, entry] of Object.entries(parsed)) {
			const coerced = coerceEntry(entry, serverName);
			if (coerced) result[serverName] = coerced;
		}

		return result;
	} catch {
		return {};
	}
}

/**
 * Saves the MCP tool cache to disk using an atomic write pattern:
 * write to `*.tmp` then rename into place.
 */
export function saveCache(data: CacheData): void {
	const cachePath = getCachePath();
	const dir = path.dirname(cachePath);
	const tmpPath = `${cachePath}.tmp`;

	try {
		fs.mkdirSync(dir, { recursive: true });

		const json = JSON.stringify(data, null, 2);
		fs.writeFileSync(tmpPath, json, { encoding: "utf8", mode: 0o600 });

		try {
			fs.renameSync(tmpPath, cachePath);
		} catch {
			// Some platforms (notably Windows) may fail if the destination exists.
			try {
				fs.unlinkSync(cachePath);
			} catch {
				// ignore
			}
			fs.renameSync(tmpPath, cachePath);
		}
	} catch (err) {
		// Best-effort cleanup: never let cache persistence crash the extension.
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// ignore
		}
		console.error("[mcp-bridge] Failed to save MCP cache:", err);
	}
}

/**
 * Deletes the on-disk cache file.
 */
export function clearCache(): void {
	const cachePath = getCachePath();
	try {
		fs.unlinkSync(cachePath);
	} catch {
		// ignore (missing file, permissions, etc.)
	}
}

/**
 * Computes a stable hash for a server config.
 */
export function hashConfig(config: McpServerConfig): string {
	const json = JSON.stringify(config);
	return crypto.createHash("sha256").update(json).digest("hex");
}

/**
 * Returns true if the cache entry matches the current config and is within TTL.
 */
export function isCacheValid(entry: CacheEntry, config: McpServerConfig): boolean {
	if (!entry || typeof entry !== "object") return false;
	if (typeof entry.configHash !== "string" || typeof entry.updatedAt !== "number") return false;

	const now = Date.now();
	if (now - entry.updatedAt > CACHE_TTL_MS) return false;

	return entry.configHash === hashConfig(config);
}
