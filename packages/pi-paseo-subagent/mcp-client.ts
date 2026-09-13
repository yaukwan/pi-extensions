import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Minimal, stateless client for Paseo's agent MCP endpoint
 * (`POST /mcp/agents?callerAgentId=<agentId>`, streamable HTTP).
 *
 * The endpoint needs no `initialize` handshake and keeps no session: one POST per
 * tool call. Streaming responses are SSE (`event: message` + `data: <json>`).
 */

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 6767;
const TOOL_CALL_TIMEOUT_MS = 15_000;

function fail(code: string, detail: string): never {
	throw new Error(`${code}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		const cause = (error as { cause?: { code?: string } }).cause;
		return cause?.code ? `${error.message} (${cause.code})` : error.message;
	}
	return String(error);
}

export interface McpTarget {
	url: string;
	password?: string;
}

/** Wildcard bind addresses are reachable on loopback; anything else is kept as given. */
export function normalizeLoopbackHost(host: string): string {
	const bare = host.replace(/^\[/, "").replace(/\]$/, "");
	if (bare === "0.0.0.0" || bare === "::" || bare === "::0" || bare === "*") return DEFAULT_HOST;
	return host;
}

/** Accepts `host`, `host:port`, `tcp://host:port`, `http://host:port`, `ssh://user@host`. */
export function parseHostPort(value: string): { host: string; port: number } | null {
	const authority = value.trim().replace(/^[a-z+]+:\/\//i, "").split("/")[0] ?? "";
	const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
	const match = /^(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/.exec(hostPort);
	if (!match?.[1]) return null;
	const port = match[2] ? Number(match[2]) : DEFAULT_PORT;
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
	return { host: match[1], port };
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** `~/.paseo/paseo.pid` records the running daemon's listen address. */
export async function resolveListenAddress(paseoHome: string): Promise<string | undefined> {
	const pidFile = await readJsonFile(join(paseoHome, "paseo.pid"));
	if (typeof pidFile?.listen === "string" && pidFile.listen.trim()) return pidFile.listen.trim();
	const config = await readJsonFile(join(paseoHome, "config.json"));
	const daemon = config?.daemon;
	const listen = isRecord(daemon) && typeof daemon.listen === "string" ? daemon.listen.trim() : "";
	return listen || undefined;
}

export async function resolveMcpTarget(env: NodeJS.ProcessEnv = process.env): Promise<McpTarget> {
	const password = env.PASEO_PASSWORD?.trim() || undefined;
	const explicit = env.PASEO_MCP_URL?.trim();
	if (explicit) return { url: explicit, ...(password ? { password } : {}) };

	const paseoHome = env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
	const source = env.PASEO_HOST?.trim() || (await resolveListenAddress(paseoHome)) || `${DEFAULT_HOST}:${DEFAULT_PORT}`;
	const parsed = parseHostPort(source);
	if (!parsed) {
		fail("paseo_endpoint_invalid", `cannot read a host and port from "${source}". Use host:port, tcp://host:port, or set PASEO_MCP_URL`);
	}
	return { url: `http://${normalizeLoopbackHost(parsed.host)}:${parsed.port}/mcp/agents`, ...(password ? { password } : {}) };
}

export function buildMcpUrl(target: McpTarget, callerAgentId?: string): string {
	const url = new URL(target.url);
	if (callerAgentId && !url.searchParams.has("callerAgentId")) url.searchParams.set("callerAgentId", callerAgentId);
	return url.toString();
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
	const controller = new AbortController();
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort();
			break;
		}
		signal.addEventListener("abort", () => { controller.abort(); }, { once: true });
	}
	return controller.signal;
}

/** Streamable HTTP responses are SSE; a plain JSON body is accepted too. */
export function parseRpcPayloads(body: string): Record<string, unknown>[] {
	const payloads: Record<string, unknown>[] = [];
	for (const line of body.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const data = line.slice(5).trim();
		if (!data) continue;
		try {
			const parsed: unknown = JSON.parse(data);
			if (isRecord(parsed)) payloads.push(parsed);
		} catch {
			// Ignore keep-alive or partial frames.
		}
	}
	if (payloads.length > 0) return payloads;
	try {
		const parsed: unknown = JSON.parse(body);
		if (isRecord(parsed)) payloads.push(parsed);
	} catch {
		// Caller reports the malformed body.
	}
	return payloads;
}

function resultText(result: Record<string, unknown>): string {
	const content = result.content;
	if (!Array.isArray(content)) return "tool reported an error";
	const texts = content
		.map((entry) => (isRecord(entry) && typeof entry.text === "string" ? entry.text.trim() : ""))
		.filter(Boolean);
	return texts.length > 0 ? texts.join("\n") : "tool reported an error";
}

export interface ToolCallOptions {
	callerAgentId?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface PaseoMcpClient {
	callTool<T>(name: string, args?: Record<string, unknown>, options?: ToolCallOptions): Promise<T>;
}

let nextRequestId = 0;

async function callTool<T>(
	name: string,
	args?: Record<string, unknown>,
	options: ToolCallOptions = {},
): Promise<T> {
	const target = await resolveMcpTarget();
	const url = buildMcpUrl(target, options.callerAgentId);
	const timeout = AbortSignal.timeout(options.timeoutMs ?? TOOL_CALL_TIMEOUT_MS);
	const signal = options.signal ? combineSignals([options.signal, timeout]) : timeout;

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(target.password ? { authorization: `Bearer ${target.password}` } : {}),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: ++nextRequestId,
				method: "tools/call",
				params: { name, arguments: args ?? {} },
			}),
			signal,
		});
	} catch (error) {
		if (options.signal?.aborted) throw error;
		fail("paseo_unavailable", `cannot reach the Paseo daemon at ${url}: ${errorMessage(error)}`);
	}

	if (response.status === 401 || response.status === 403) {
		fail("paseo_auth_required", "the Paseo daemon rejected this request. Set PASEO_PASSWORD to the daemon password.");
	}
	if (!response.ok) {
		fail("paseo_request_failed", `HTTP ${response.status} from ${url}`);
	}

	const payloads = parseRpcPayloads(await response.text());
	const payload = payloads.at(-1);
	if (!payload) fail("paseo_invalid_output", `${name}: the daemon returned no JSON-RPC payload`);
	const rpcError = payload.error;
	if (isRecord(rpcError)) {
		fail("paseo_tool_failed", `${name}: ${typeof rpcError.message === "string" ? rpcError.message : "unknown error"}`);
	}
	const result = payload.result;
	if (!isRecord(result)) fail("paseo_invalid_output", `${name}: the daemon returned no tool result`);
	if (result.isError === true) fail("paseo_tool_failed", `${name}: ${resultText(result)}`);
	if (!isRecord(result.structuredContent)) {
		fail("paseo_invalid_output", `${name}: the daemon returned no structured content`);
	}
	return result.structuredContent as T;
}

export function createPaseoMcpClient(): PaseoMcpClient {
	return { callTool };
}

/** Reads the environment and `globalThis.fetch` per call, so tests can stub both. */
export const paseoMcp: PaseoMcpClient = createPaseoMcpClient();
