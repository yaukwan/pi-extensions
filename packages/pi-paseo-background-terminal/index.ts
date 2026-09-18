import { DEFAULT_MAX_BYTES, truncateTail, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	assertExecParams,
	assertCursor,
	assertReadParams,
	assertStopParams,
	assertTaskId,
	assertWriteParams,
	MAX_LABEL_LENGTH,
	MAX_LIST_LIMIT,
	MAX_OUTPUT_LINES,
	type BackgroundExecParams,
	type BackgroundListParams,
	type BackgroundReadParams,
	type BackgroundStopParams,
	type BackgroundWriteParams,
} from "./protocol.ts";
import {
	assertInsideProject,
	canonicalProjectRoot,
	createTaskRecord,
	listTaskRecords,
	loadTaskRecord,
	newTaskId,
	removeTaskRecord,
	summarizeTask,
	taskSummaryText,
	type TaskMeta,
	type TaskSummary,
} from "./runner.ts";
import { isTerminalNotFound, paseoTerminals, type PaseoTerminalClient } from "./paseo-terminal-client.ts";

const DEFAULT_LIST_LIMIT = 25;
const DEFAULT_OUTPUT_LINES = 120;
/** Paseo terminals each own a PTY and a shell; keep the per-project fan-out modest. */
const MAX_ACTIVE_SESSIONS = 16;

export interface BackgroundListResult {
	tasks: TaskSummary[];
	next_cursor?: string;
}

export interface BackgroundWriteResult {
	task: TaskSummary;
	accepted: true;
}

export interface BackgroundStopResult {
	task: TaskSummary;
	mode: "interrupt" | "terminate";
	accepted: boolean;
	reason?: "terminal_closed";
}

export interface TaskCleanupResult {
	eligible: number;
	removed: number;
}

type ToolResult = BackgroundListResult | BackgroundWriteResult | BackgroundStopResult;

export function assertProjectTrusted(ctx: ExtensionContext): void {
	if (ctx.isProjectTrusted && !ctx.isProjectTrusted()) throw new Error("The current project is not trusted");
}

export function parentAgentId(env: NodeJS.ProcessEnv = process.env): string {
	const id = env.PASEO_AGENT_ID?.trim();
	if (!id) {
		throw new Error("paseo_agent_context_missing: this Pi session does not run inside a Paseo agent, so it cannot own workspace terminals");
	}
	return id;
}

export function taskLabel(label: string | undefined, command: string): string {
	const trimmed = label?.trim();
	if (trimmed) return trimmed.slice(0, MAX_LABEL_LENGTH);
	return (command.trim().split("\n")[0] ?? "").slice(0, MAX_LABEL_LENGTH) || "task";
}

function clamp(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

interface Cursor {
	createdAt: string;
	taskId: string;
}

function encodeCursor(task: TaskSummary): string {
	return Buffer.from(JSON.stringify({ createdAt: task.created_at, taskId: task.task_id })).toString("base64url");
}

export function parseCursor(cursor: string | undefined): Cursor | undefined {
	assertCursor(cursor);
	if (!cursor) return undefined;
	try {
		const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (!value || typeof value !== "object") throw new Error();
		const { createdAt, taskId } = value as Partial<Cursor>;
		if (typeof createdAt !== "string" || typeof taskId !== "string") throw new Error();
		return { createdAt, taskId };
	} catch {
		throw new Error("invalid_arguments: cursor is invalid. Use background_list without cursor.");
	}
}

function followsCursor(task: TaskSummary, cursor: Cursor | undefined): boolean {
	if (!cursor) return true;
	return task.created_at < cursor.createdAt
		|| (task.created_at === cursor.createdAt && task.task_id < cursor.taskId);
}

function resultText(result: ToolResult): string {
	if ("tasks" in result) return result.tasks.length === 0 ? "No background tasks" : result.tasks.map(taskSummaryText).join("\n");
	if ("mode" in result) return `${taskSummaryText(result.task)} ${result.mode} ${result.accepted ? "accepted" : result.reason ?? "not accepted"}`;
	return `${taskSummaryText(result.task)} input accepted`;
}

function trimTrailingBlanks(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && !lines[end - 1]?.trim()) end -= 1;
	return lines.slice(0, end);
}

export class PaseoBackgroundTerminalService {
	constructor(
		private readonly terminals: PaseoTerminalClient = paseoTerminals,
		private readonly home?: string,
	) {}

	private async projectPaths(ctx: ExtensionContext, cwd?: string): Promise<{ projectRoot: string; cwd: string }> {
		const projectRoot = await canonicalProjectRoot(ctx.cwd);
		const target = await canonicalProjectRoot(cwd ?? ".", ctx.cwd);
		return { projectRoot, cwd: assertInsideProject(projectRoot, target) };
	}

	private async aliveTerminalIds(callerAgentId: string, signal?: AbortSignal): Promise<Set<string>> {
		const terminals = await this.terminals.listTerminals({ all: true, callerAgentId, signal });
		return new Set(terminals.map((terminal) => terminal.id));
	}

	async exec(params: BackgroundExecParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<{ task_id: string; summary: TaskSummary }> {
		assertProjectTrusted(ctx);
		assertExecParams(params);
		const callerAgentId = parentAgentId();
		const { projectRoot, cwd } = await this.projectPaths(ctx, params.cwd);
		const records = await listTaskRecords(projectRoot, this.home);

		let terminalId: string;
		let createdTerminal = false;
		if (params.session) {
			const session = await loadTaskRecord(projectRoot, params.session, this.home);
			terminalId = session.meta.terminal_id;
			const alive = await this.aliveTerminalIds(callerAgentId, signal);
			if (!alive.has(terminalId)) {
				throw new Error(`session_not_found: the Paseo terminal of session task ${params.session} is gone. Start a new task without session.`);
			}
		} else {
			const alive = await this.aliveTerminalIds(callerAgentId, signal);
			const activeSessions = new Set<string>();
			for (const record of records) {
				if (alive.has(record.meta.terminal_id)) activeSessions.add(record.meta.terminal_id);
			}
			if (activeSessions.size >= MAX_ACTIVE_SESSIONS) {
				throw new Error(`too_many_active_sessions: ${MAX_ACTIVE_SESSIONS} Paseo terminal sessions are active. Stop one, or pass session=<task_id> to reuse one.`);
			}
			const terminal = await this.terminals.createTerminal({ cwd, name: taskLabel(params.label, params.command), callerAgentId, signal });
			terminalId = terminal.id;
			createdTerminal = true;
		}

		const meta: TaskMeta = {
			task_id: newTaskId(),
			terminal_id: terminalId,
			label: taskLabel(params.label, params.command),
			command: params.command,
			cwd,
			created_at: new Date().toISOString(),
		};
		try {
			await createTaskRecord(projectRoot, meta, this.home);
			await this.terminals.sendKeys({ terminalId, keys: params.command, literal: true, callerAgentId, signal });
			await this.terminals.sendKeys({ terminalId, keys: "Enter", callerAgentId, signal });
		} catch (error) {
			if (createdTerminal) await this.terminals.killTerminal({ terminalId, callerAgentId }).catch(() => {});
			await removeTaskRecord(projectRoot, meta.task_id, this.home);
			throw error;
		}
		const summary: TaskSummary = { ...meta, state: "open" };
		return { task_id: meta.task_id, summary };
	}

	async list(params: BackgroundListParams, ctx: ExtensionContext): Promise<BackgroundListResult> {
		assertProjectTrusted(ctx);
		if (params.task_id !== undefined) assertTaskId(params.task_id);
		const cursor = parseCursor(params.cursor);
		const limit = clamp(params.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
		const { projectRoot } = await this.projectPaths(ctx);
		let records = await listTaskRecords(projectRoot, this.home);
		if (params.task_id !== undefined) records = records.filter((record) => record.meta.task_id === params.task_id);

		const alive = records.length > 0 ? await this.aliveTerminalIds(parentAgentId()) : new Set<string>();
		const tasks = records.map((record) => summarizeTask(record, alive.has(record.meta.terminal_id)));
		const visible = tasks.filter((task) => followsCursor(task, cursor));
		const page = visible.slice(0, limit);
		return { tasks: page, next_cursor: visible.length > page.length && page.length > 0 ? encodeCursor(page[page.length - 1] as TaskSummary) : undefined };
	}

	async read(params: BackgroundReadParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
		assertProjectTrusted(ctx);
		assertReadParams(params);
		const { projectRoot } = await this.projectPaths(ctx);
		const record = await loadTaskRecord(projectRoot, params.task_id, this.home);
		const lines = clamp(params.output_lines, DEFAULT_OUTPUT_LINES, 1, MAX_OUTPUT_LINES);
		const capture = await this.terminals.captureTerminal({
			terminalId: record.meta.terminal_id,
			scrollback: true,
			callerAgentId: parentAgentId(),
			signal,
		});
		const text = trimTrailingBlanks(capture.lines).slice(-lines).join("\n");
		const result = truncateTail(text, { maxLines: lines, maxBytes: DEFAULT_MAX_BYTES });
		return result.truncated ? `[older terminal output omitted]\n${result.content}` : result.content;
	}

	async write(params: BackgroundWriteParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<BackgroundWriteResult> {
		assertProjectTrusted(ctx);
		assertWriteParams(params);
		const callerAgentId = parentAgentId();
		const { projectRoot } = await this.projectPaths(ctx);
		const record = await loadTaskRecord(projectRoot, params.task_id, this.home);
		try {
			await this.terminals.sendKeys({ terminalId: record.meta.terminal_id, keys: params.input, literal: true, callerAgentId, signal });
			if (params.submit !== false) {
				await this.terminals.sendKeys({ terminalId: record.meta.terminal_id, keys: "Enter", callerAgentId, signal });
			}
		} catch (error) {
			if (isTerminalNotFound(error)) {
				throw new Error(`terminal_closed: Background task ${params.task_id} has no live Paseo terminal. Start a new session.`);
			}
			throw error;
		}
		return { task: summarizeTask(record, true), accepted: true };
	}

	async stop(params: BackgroundStopParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<BackgroundStopResult> {
		assertProjectTrusted(ctx);
		assertStopParams(params);
		const callerAgentId = parentAgentId();
		const { projectRoot } = await this.projectPaths(ctx);
		const record = await loadTaskRecord(projectRoot, params.task_id, this.home);
		const alive = await this.aliveTerminalIds(callerAgentId, signal);
		if (!alive.has(record.meta.terminal_id)) {
			return { task: summarizeTask(record, false), mode: params.mode, accepted: false, reason: "terminal_closed" };
		}
		if (params.mode === "interrupt") {
			try {
				await this.terminals.sendKeys({ terminalId: record.meta.terminal_id, keys: "C-c", callerAgentId, signal });
			} catch (error) {
				if (!isTerminalNotFound(error)) throw error;
				return { task: summarizeTask(record, false), mode: params.mode, accepted: false, reason: "terminal_closed" };
			}
			return { task: summarizeTask(record, true), mode: params.mode, accepted: true };
		}
		await this.terminals.killTerminal({ terminalId: record.meta.terminal_id, callerAgentId, signal });
		return { task: summarizeTask(record, false), mode: params.mode, accepted: true };
	}

	async cleanup(ctx: ExtensionContext, confirm: boolean): Promise<TaskCleanupResult> {
		assertProjectTrusted(ctx);
		const { projectRoot } = await this.projectPaths(ctx);
		const records = await listTaskRecords(projectRoot, this.home);
		const alive = records.length > 0 ? await this.aliveTerminalIds(parentAgentId()) : new Set<string>();
		const eligible = records.filter((record) => !alive.has(record.meta.terminal_id));
		if (!confirm) return { eligible: eligible.length, removed: 0 };
		for (const record of eligible) await removeTaskRecord(projectRoot, record.meta.task_id, this.home);
		return { eligible: eligible.length, removed: eligible.length };
	}
}

export const backgroundTerminalService = new PaseoBackgroundTerminalService();

function renderResult(result: { content: Array<{ type: string; text?: string }>; details: unknown }, theme: any, expanded: boolean): Text {
	const details = result.details as Partial<BackgroundListResult & { task?: TaskSummary; summary?: TaskSummary }>;
	if (details.tasks) return new Text(theme.fg("accent", `${details.tasks.length} background task(s)`), 0, 0);
	const task = details.task ?? details.summary;
	if (!task) return new Text(theme.fg("toolTitle", result.content[0]?.text ?? ""), 0, 0);
	if (!expanded) return new Text(theme.fg("toolTitle", `${task.label} [${task.state}]`), 0, 0);
	const color = task.state === "closed" ? "warning" : "success";
	return new Text(theme.fg(color, taskSummaryText(task)), 0, 0);
}

export default function paseoBackgroundTerminalExtension(pi: ExtensionAPI): void {
	const service = backgroundTerminalService;

	pi.registerTool({
		name: "background_exec",
		label: "Background Exec",
		description: "Type a command directly into a persistent Paseo terminal and press Enter. Output stays visible for human collaboration.",
		promptSnippet: "Start a command in a persistent Paseo background terminal session",
		promptGuidelines: [
			"Returns a task_id after sending input, not after command completion. Paseo does not report per-command exit codes.",
			"Commands run directly in the terminal's default shell; cd and export persist. Output is read through Paseo capture_terminal.",
			"Pass session=<task_id> only when the shell is ready. Input goes to the foreground process; there is no task queue. Omit cwd when reusing a session.",
			"Use the command's own output to assess completion. Do not append log redirection or generated shell wrappers.",
		],
		parameters: Type.Object({
			command: Type.String({ minLength: 1, maxLength: 65_536, description: "Command to type directly into the terminal shell" }),
			cwd: Type.Optional(Type.String({ maxLength: 4096, description: "Working directory inside the current trusted project" })),
			label: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_LABEL_LENGTH, description: "Human-readable task label" })),
			session: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Existing task id whose Paseo terminal session is reused" })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: BackgroundExecParams, signal, _onUpdate, ctx) {
			const result = await service.exec(params, ctx, signal);
			return { content: [{ type: "text", text: result.task_id }], details: result };
		},
		renderCall(args, theme) {
			const input = args as Partial<BackgroundExecParams>;
			return new Text(theme.fg("toolTitle", `background_exec ${input.label ?? ""} ${input.command ?? ""}`), 0, 0);
		},
		renderResult(result, _options, theme) { return renderResult(result, theme, false); },
	});

	pi.registerTool({
		name: "background_list",
		label: "Background List",
		description: "List tracked submissions with terminal state: open or closed. This does not indicate command completion.",
		promptSnippet: "List persistent Paseo background tasks",
		promptGuidelines: ["States describe terminal presence only, not running commands. Daemon failures are reported as errors."],
		parameters: Type.Object({
			task_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			cursor: Type.Optional(Type.String({ maxLength: 512 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_LIMIT })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: BackgroundListParams, _signal, _onUpdate, ctx) {
			const result = await service.list(params, ctx);
			return { content: [{ type: "text", text: resultText(result) }], details: result };
		},
		renderResult(result, { expanded }, theme) { return renderResult(result, theme, expanded); },
	});

	pi.registerTool({
		name: "background_read",
		label: "Background Read",
		description: "Capture recent rendered lines from the task's Paseo terminal, including commands, prompts, and shared session history.",
		promptSnippet: "Read output from a persistent Paseo background task",
		promptGuidelines: [
			"Reads are snapshots of terminal scrollback, not incremental output or a per-command log.",
			"Use background_list for terminal presence. Captured output may be truncated by Paseo scrollback limits.",
		],
		parameters: Type.Object({
			task_id: Type.String({ minLength: 1, maxLength: 128 }),
			output_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OUTPUT_LINES })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: BackgroundReadParams, signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: await service.read(params, ctx, signal) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "background_write",
		label: "Background Write",
		description: "Send input to an open Paseo terminal's foreground program or shell.",
		promptSnippet: "Send input to a persistent Paseo background task",
		promptGuidelines: ["background_write presses Enter unless submit is false. It is PTY keyboard input, not a stdin pipe: the foreground process must be reading."],
		parameters: Type.Object({
			task_id: Type.String({ minLength: 1, maxLength: 128 }),
			input: Type.String({ maxLength: 65_536 }),
			submit: Type.Optional(Type.Boolean()),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: BackgroundWriteParams, signal, _onUpdate, ctx) {
			const result = await service.write(params, ctx, signal);
			return { content: [{ type: "text", text: resultText(result) }], details: result };
		},
		renderResult(result, { expanded }, theme) { return renderResult(result, theme, expanded); },
	});

	pi.registerTool({
		name: "background_stop",
		label: "Background Stop",
		description: "Interrupt a background task with Ctrl-C, or terminate it by killing its Paseo terminal.",
		promptSnippet: "Interrupt or terminate a persistent Paseo background task",
		promptGuidelines: [
			"Use mode=interrupt to send Ctrl+C; acceptance does not confirm that the foreground command stopped.",
			"Use mode=terminate to close the terminal shared by all its submissions. Captured output is unavailable after closure.",
		],
		parameters: Type.Object({
			task_id: Type.String({ minLength: 1, maxLength: 128 }),
			mode: Type.Union([Type.Literal("interrupt"), Type.Literal("terminate")]),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: BackgroundStopParams, signal, _onUpdate, ctx) {
			const result = await service.stop(params, ctx, signal);
			return { content: [{ type: "text", text: resultText(result) }], details: result };
		},
		renderResult(result, { expanded }, theme) { return renderResult(result, theme, expanded); },
	});

	pi.registerCommand("bg", {
		description: "List or control Paseo background terminal tasks",
		handler: async (args, ctx) => {
			const parts = args.trim() ? args.trim().split(/\s+/) : [];
			const [action = "list", id, ...rest] = parts;
			try {
				if (action === "clean") {
					const confirmed = id === "--confirm";
					const result = await service.cleanup(ctx, confirmed);
					ctx.ui.notify(confirmed ? `Removed ${result.removed} closed-terminal record(s).` : `${result.eligible} closed-terminal record(s) can be cleaned. Run /bg clean --confirm.`, "info");
					return;
				}
				if (action === "list") { ctx.ui.notify(resultText(await service.list({}, ctx)), "info"); return; }
				if (action === "read" && id) { ctx.ui.notify(await service.read({ task_id: id }, ctx), "info"); return; }
				if (action === "write" && id) { ctx.ui.notify(resultText(await service.write({ task_id: id, input: rest.join(" ") }, ctx)), "info"); return; }
				if ((action === "interrupt" || action === "terminate") && id) {
					ctx.ui.notify(resultText(await service.stop({ task_id: id, mode: action }, ctx)), "info");
					return;
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			ctx.ui.notify("Usage: /bg [list|read|write|interrupt|terminate|clean] [task_id|--confirm] [input]", "warning");
		},
	});
}
