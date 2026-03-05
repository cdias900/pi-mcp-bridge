import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

import { piHome } from "./types.js";

export const OAUTH_CALLBACK_PORT = 19876;

type DiscoveryState = Parameters<NonNullable<OAuthClientProvider["saveDiscoveryState"]>>[0];

interface StoredOAuthState {
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	discoveryState?: DiscoveryState;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeServerName(serverName: string): string {
	return serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getStorePath(serverName: string): string {
	const safeName = sanitizeServerName(serverName);
	return path.join(piHome, "mcp-oauth", `${safeName}.json`);
}

function loadState(serverName: string): StoredOAuthState {
	const storePath = getStorePath(serverName);

	try {
		const raw = fs.readFileSync(storePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isPlainObject(parsed)) return {};

		const obj = parsed as Record<string, unknown>;
		const out: StoredOAuthState = {};

		if ("clientInformation" in obj) out.clientInformation = obj.clientInformation as any;
		if ("tokens" in obj) out.tokens = obj.tokens as any;
		if ("discoveryState" in obj) out.discoveryState = obj.discoveryState as any;

		return out;
	} catch {
		return {};
	}
}

function saveState(serverName: string, state: StoredOAuthState): void {
	const storePath = getStorePath(serverName);
	const dir = path.dirname(storePath);
	const tmpPath = `${storePath}.tmp`;

	try {
		fs.mkdirSync(dir, { recursive: true });

		const json = JSON.stringify(state, null, 2);
		fs.writeFileSync(tmpPath, json, { encoding: "utf8", mode: 0o600 });

		try {
			fs.renameSync(tmpPath, storePath);
		} catch {
			// Some platforms (notably Windows) may fail if the destination exists.
			try {
				fs.unlinkSync(storePath);
			} catch {
				// ignore
			}
			fs.renameSync(tmpPath, storePath);
		}
	} catch (err) {
		// Best-effort cleanup: never let persistence crash the extension.
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// ignore
		}
		console.error(`[mcp-bridge] Failed to save OAuth state for ${serverName}:`, err);
	}
}

function isEmptyState(state: StoredOAuthState): boolean {
	return !state.clientInformation && !state.tokens && !state.discoveryState;
}


export class BridgeOAuthProvider implements OAuthClientProvider {
	private _codeVerifier: string | undefined;

	constructor(
		private readonly serverName: string,
		private readonly callbackPort: number,
	) {}

	get redirectUrl(): string {
		return `http://127.0.0.1:${this.callbackPort}/callback`;
	}

	get clientMetadata(): OAuthClientMetadata {
		const redirectUrl = this.redirectUrl;

		return {
			client_name: "pi-mcp-bridge",
			redirect_uris: [redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "client_secret_post",
		};
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return loadState(this.serverName).clientInformation;
	}

	saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
		const state = loadState(this.serverName);
		state.clientInformation = clientInformation;
		saveState(this.serverName, state);
	}

	tokens(): OAuthTokens | undefined {
		return loadState(this.serverName).tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		const state = loadState(this.serverName);
		state.tokens = tokens;
		saveState(this.serverName, state);
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		const url = authorizationUrl.toString();
		console.error(`[mcp-bridge] Authorize at: ${url}`);

		const opener =
			process.platform === "darwin"
				? "open"
				: process.platform === "win32"
					? "cmd"
					: "xdg-open";
		const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

		try {
			execFileSync(opener, args, { stdio: "ignore" });
		} catch {
			// ignore — URL already printed.
		}
	}

	saveCodeVerifier(codeVerifier: string): void {
		this._codeVerifier = codeVerifier;
	}

	codeVerifier(): string {
		if (!this._codeVerifier) {
			throw new Error("No code verifier saved");
		}
		return this._codeVerifier;
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		if (scope === "verifier" || scope === "all") {
			this._codeVerifier = undefined;
		}

		const storePath = getStorePath(this.serverName);

		if (scope === "all") {
			try {
				fs.unlinkSync(storePath);
			} catch {
				// ignore
			}
			return;
		}

		const state = loadState(this.serverName);

		if (scope === "client") delete state.clientInformation;
		if (scope === "tokens") delete state.tokens;
		if (scope === "discovery") delete state.discoveryState;

		if (isEmptyState(state)) {
			try {
				fs.unlinkSync(storePath);
			} catch {
				// ignore
			}
			return;
		}

		saveState(this.serverName, state);
	}

	discoveryState(): DiscoveryState | undefined {
		return loadState(this.serverName).discoveryState;
	}

	saveDiscoveryState(state: DiscoveryState): void {
		const stored = loadState(this.serverName);
		stored.discoveryState = state;
		saveState(this.serverName, stored);
	}
}
