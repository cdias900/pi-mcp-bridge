import * as http from "node:http";
import * as url from "node:url";

import { OAUTH_TIMEOUT_MS } from "./types.js";

const CALLBACK_HOST = "127.0.0.1";

const CALLBACK_HTML =
	"<html><body><h1>Authorization complete</h1><p>You can close this tab and return to your terminal.</p></body></html>";

function toErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	try {
		return typeof err === "string" ? err : JSON.stringify(err);
	} catch {
		return String(err);
	}
}

export function createCallbackServer(port: number): {
	waitForCode(): Promise<string>;
	close(): void;
} {
	let settled = false;
	let closed = false;

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let autoCloseId: ReturnType<typeof setTimeout> | undefined;

	let waitForCodeCalled = false;

	let resolvePromise: ((code: string) => void) | undefined;
	let rejectPromise: ((err: Error) => void) | undefined;
	let codePromise: Promise<string> | undefined;

	let settledCode: string | undefined;
	let settledError: Error | undefined;

	function clearTimers(): void {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
			timeoutId = undefined;
		}
		if (autoCloseId !== undefined) {
			clearTimeout(autoCloseId);
			autoCloseId = undefined;
		}
	}

	function settleResolve(code: string): void {
		if (settled) return;
		settled = true;
		settledCode = code;
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
			timeoutId = undefined;
		}
		if (waitForCodeCalled) resolvePromise?.(code);
	}

	function settleReject(err: Error): void {
		if (settled) return;
		settled = true;
		settledError = err;
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
			timeoutId = undefined;
		}
		if (waitForCodeCalled) rejectPromise?.(err);
	}

	function scheduleAutoClose(): void {
		if (autoCloseId !== undefined) return;
		autoCloseId = setTimeout(() => {
			close();
		}, 3000);
	}

	function sendHtml(res: http.ServerResponse, statusCode = 200): void {
		res.statusCode = statusCode;
		res.setHeader("Content-Type", "text/html; charset=utf-8");
		res.end(CALLBACK_HTML);
	}

	const server = http.createServer((req, res) => {
		if (req.method !== "GET") {
			res.statusCode = 405;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("Method Not Allowed");
			return;
		}

		let parsed: url.URL;
		try {
			parsed = new url.URL(req.url ?? "/", `http://${CALLBACK_HOST}:${port}`);
		} catch {
			res.statusCode = 400;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("Bad Request");
			return;
		}

		if (parsed.pathname !== "/callback") {
			res.statusCode = 404;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("Not Found");
			return;
		}

		const error = parsed.searchParams.get("error");
		const errorDescription = parsed.searchParams.get("error_description");
		const code = parsed.searchParams.get("code");

		sendHtml(res);

		if (error) {
			settleReject(new Error(errorDescription ?? error));
			scheduleAutoClose();
			return;
		}

		if (code) {
			settleResolve(code);
			scheduleAutoClose();
			return;
		}

		settleReject(new Error("Missing `code` in OAuth callback."));
		scheduleAutoClose();
	});

	function close(): void {
		if (closed) return;
		closed = true;

		clearTimers();

		if (!settled) {
			settleReject(new Error("Callback server closed before receiving OAuth response."));
		}

		try {
			server.close();
		} catch {
			// If close() is called before the server starts listening, `server.close()` can throw.
			// In that case, close again as soon as we get the `listening` event.
			server.once("listening", () => {
				try {
					server.close();
				} catch {
					// ignore
				}
			});
		}
	}

	server.on("error", (err) => {
		if (closed) return;

		const e = err as NodeJS.ErrnoException;
		if (e?.code === "EADDRINUSE") {
			settleReject(new Error(`Port ${port} is already in use.`));
		} else {
			settleReject(new Error(`Failed to start callback server: ${toErrorMessage(err)}`));
		}

		close();
	});

	timeoutId = setTimeout(() => {
		settleReject(new Error("Timed out waiting for OAuth callback."));
		close();
	}, OAUTH_TIMEOUT_MS);

	try {
		server.listen(port, CALLBACK_HOST);
	} catch (err) {
		settleReject(new Error(`Failed to start callback server: ${toErrorMessage(err)}`));
		close();
	}

	return {
		waitForCode(): Promise<string> {
			waitForCodeCalled = true;

			if (codePromise) return codePromise;
			if (settledCode !== undefined) return Promise.resolve(settledCode);
			if (settledError !== undefined) return Promise.reject(settledError);

			codePromise = new Promise<string>((resolve, reject) => {
				resolvePromise = resolve;
				rejectPromise = reject;
			});

			return codePromise;
		},
		close,
	};
}
