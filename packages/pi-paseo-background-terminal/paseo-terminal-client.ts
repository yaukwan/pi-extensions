import { paseoMcp } from "./mcp-client.ts";

/**
 * Thin, typed wrappers over the five Paseo MCP terminal tools. The MCP surface
 * has no wait/subscribe primitive; these are the only daemon calls this package
 * ever makes. All ownership lives in the local task records.
 */

export interface TerminalSummary {
	id: string;
	name: string;
	cwd: string;
}

export interface TerminalCallOptions {
	callerAgentId: string;
	signal?: AbortSignal;
}

function fail(code: string, detail: string): never {
	throw new Error(`${code}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The daemon reports a missing terminal as a tool failure with this text. */
export function isTerminalNotFound(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /Terminal .+ not found/.test(message);
}

export interface PaseoTerminalClient {
	createTerminal(options: { cwd: string; name: string } & TerminalCallOptions): Promise<TerminalSummary>;
	sendKeys(options: { terminalId: string; keys: string; literal?: boolean } & TerminalCallOptions): Promise<void>;
	captureTerminal(options: { terminalId: string; scrollback?: boolean } & TerminalCallOptions): Promise<{ lines: string[]; totalLines: number }>;
	listTerminals(options: { all: boolean } & TerminalCallOptions): Promise<TerminalSummary[]>;
	killTerminal(options: { terminalId: string } & TerminalCallOptions): Promise<void>;
}

export const paseoTerminals: PaseoTerminalClient = {
	async createTerminal({ cwd, name, callerAgentId, signal }) {
		const result = await paseoMcp.callTool<unknown>("create_terminal", { cwd, name }, { callerAgentId, signal });
		const created = isRecord(result) ? result : {};
		const id = asString(created.id);
		if (!id) fail("paseo_invalid_output", "create_terminal returned no terminal id");
		return { id, name: asString(created.name) ?? name, cwd: asString(created.cwd) ?? cwd };
	},

	async sendKeys({ terminalId, keys, literal, callerAgentId, signal }) {
		await paseoMcp.callTool<unknown>("send_terminal_keys", { terminalId, keys, ...(literal ? { literal: true } : {}) }, { callerAgentId, signal });
	},

	async captureTerminal({ terminalId, scrollback, callerAgentId, signal }) {
		const result = await paseoMcp.callTool<unknown>("capture_terminal", {
			terminalId,
			...(scrollback ? { scrollback: true } : {}),
			stripAnsi: true,
		}, { callerAgentId, signal });
		if (!isRecord(result) || !Array.isArray(result.lines)) {
			fail("paseo_invalid_output", "capture_terminal returned no lines");
		}
		return {
			lines: result.lines.filter((line): line is string => typeof line === "string"),
			totalLines: typeof result.totalLines === "number" ? result.totalLines : result.lines.length,
		};
	},

	async listTerminals({ all, callerAgentId, signal }) {
		const result = await paseoMcp.callTool<unknown>("list_terminals", all ? { all: true } : {}, { callerAgentId, signal });
		const terminals = isRecord(result) ? result.terminals : undefined;
		if (!Array.isArray(terminals)) fail("paseo_invalid_output", "list_terminals returned no terminals");
		const parsed: TerminalSummary[] = [];
		for (const entry of terminals) {
			if (!isRecord(entry)) continue;
			const id = asString(entry.id);
			if (!id) continue;
			parsed.push({ id, name: asString(entry.name) ?? "", cwd: asString(entry.cwd) ?? "" });
		}
		return parsed;
	},

	async killTerminal({ terminalId, callerAgentId, signal }) {
		try {
			await paseoMcp.callTool<unknown>("kill_terminal", { terminalId }, { callerAgentId, signal });
		} catch (error) {
			if (!isTerminalNotFound(error)) throw error;
		}
	},
};
