import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
	MAX_WAIT_MS,
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
	generateSubmitLine,
	listTaskRecords,
	loadTaskRecord,
	logPath,
	newTaskId,
	projectLogText,
	readLogSlice,
	readStatusFile,
	removeTaskRecord,
	summarizeTask,
	taskSummaryText,
	writeStatusFile,
	writeTaskMeta,
	type TaskMeta,
	type TaskSummary,
} from "./runner.ts";
import { isTerminalNotFound, paseoTerminals, type PaseoTerminalClient } from "./paseo-terminal-client.ts";

const DEFAULT_LIST_LIMIT = 25;
const DEFAULT_OUTPUT_LINES = 120;
const DEFAULT_READ_WAIT_MS = 5_000;
/** Paseo terminals each own a PTY and a shell; keep the per-project fan-out modest. */
const MAX_ACTIVE_SESSIONS = 16;
const STATUS_POLL_INTERVAL_MS = 100;
/** How long a stop waits for the wrapper's trap to record the exit code. */
const STOP_CONFIRM_MS = 1_500;

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
	reason?: "already_terminal";
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

	private async waitForStatus(dir: string, waitMs: number, signal?: AbortSignal): Promise<void> {
		const deadline = Date.now() + waitMs;
		for (;;) {
			if (await readStatusFile(dir)) return;
			const remaining = deadline - Date.now();
			if (remaining <= 0) return;
			await delay(Math.min(STATUS_POLL_INTERVAL_MS, remaining), undefined, { signal });
		}
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
				if (!(await readStatusFile(record.dir)) && alive.has(record.meta.terminal_id)) activeSessions.add(record.meta.terminal_id);
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
			output: params.output ?? "log",
			created_at: new Date().toISOString(),
			read_offset: 0,
		};
		const dir = await createTaskRecord(projectRoot, meta, this.home);
		try {
			await this.terminals.sendKeys({ terminalId, keys: generateSubmitLine(join(dir, "run.sh")), literal: true, callerAgentId, signal });
			await this.terminals.sendKeys({ terminalId, keys: "Enter", callerAgentId, signal });
		} catch (error) {
			if (createdTerminal) await this.terminals.killTerminal({ terminalId, callerAgentId }).catch(() => {});
			await removeTaskRecord(projectRoot, meta.task_id, this.home);
			throw error;
		}
		if (params.wait_ms !== undefined && params.wait_ms > 0) await this.waitForStatus(dir, params.wait_ms, signal);
		const summary = await summarizeTask({ meta, dir }, true);
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

		const statuses = await Promise.all(records.map((record) => readStatusFile(record.dir)));
		let alive: Set<string> | undefined;
		if (statuses.some((status) => !status)) {
			// Orphan detection needs the daemon; a daemon that is down leaves states reported as running.
			alive = await this.aliveTerminalIds(parentAgentId()).catch(() => undefined);
		}
		const tasks = await Promise.all(records.map(async (record, index) =>
			summarizeTask(record, statuses[index] ? undefined : alive?.has(record.meta.terminal_id)),
		));
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
		const range = params.range ?? "new";

		if (record.meta.output === "screen") {
			const waitMs = clamp(params.wait_ms, DEFAULT_READ_WAIT_MS, 0, MAX_WAIT_MS);
			if (!(await readStatusFile(record.dir)) && waitMs > 0) await this.waitForStatus(record.dir, waitMs, signal);
			const capture = await this.terminals.captureTerminal({
				terminalId: record.meta.terminal_id,
				scrollback: true,
				callerAgentId: parentAgentId(),
				signal,
			}).catch((error: unknown) => {
				if (isTerminalNotFound(error)) return { lines: [], totalLines: 0 };
				throw error;
			});
			return trimTrailingBlanks(capture.lines).slice(-lines).join("\n");
		}

		const slice = await readLogSlice(logPath(record.dir), record.meta.read_offset, range);
		if (slice.nextOffset !== record.meta.read_offset) {
			await writeTaskMeta(record.dir, { ...record.meta, read_offset: slice.nextOffset });
		}
		const projection = projectLogText(slice.text, lines);
		const notice = slice.windowTruncated ? "[older output dropped by the read window]\n" : "";
		return notice + projection.content;
	}

	async write(params: BackgroundWriteParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<BackgroundWriteResult> {
		assertProjectTrusted(ctx);
		assertWriteParams(params);
		const callerAgentId = parentAgentId();
		const { projectRoot } = await this.projectPaths(ctx);
		const record = await loadTaskRecord(projectRoot, params.task_id, this.home);
		if (await readStatusFile(record.dir)) {
			throw new Error(`task_not_running: Background task ${params.task_id} already finished. Use background_read to inspect it or background_exec to start a new task.`);
		}
		try {
			await this.terminals.sendKeys({ terminalId: record.meta.terminal_id, keys: params.input, literal: true, callerAgentId, signal });
			if (params.submit !== false) {
				await this.terminals.sendKeys({ terminalId: record.meta.terminal_id, keys: "Enter", callerAgentId, signal });
			}
		} catch (error) {
			if (isTerminalNotFound(error)) {
				throw new Error(`task_not_running: Background task ${params.task_id} has no live Paseo terminal (orphaned). Use background_read for its recorded output.`);
			}
			throw error;
		}
		return { task: await summarizeTask(record, true), accepted: true };
	}

	async stop(params: BackgroundStopParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<BackgroundStopResult> {
		assertProjectTrusted(ctx);
		assertStopParams(params);
		const callerAgentId = parentAgentId();
		const { projectRoot } = await this.projectPaths(ctx);
		const record = await loadTaskRecord(projectRoot, params.task_id, this.home);
		if (await readStatusFile(record.dir)) {
			return { task: await summarizeTask(record), mode: params.mode, accepted: false, reason: "already_terminal" };
		}
		if (params.mode === "interrupt") {
			let alive = true;
			try {
				await this.terminals.sendKeys({ terminalId: record.meta.terminal_id, keys: "C-c", callerAgentId, signal });
			} catch (error) {
				if (!isTerminalNotFound(error)) throw error;
				alive = false;
			}
			await this.waitForStatus(record.dir, STOP_CONFIRM_MS);
			// During the first milliseconds of startup the wrapper can take the default
			// SIGINT action before its traps install. The command is gone either way, so
			// record the death instead of leaving a task that lies about running.
			if (alive && !(await readStatusFile(record.dir))) await writeStatusFile(record.dir, "terminated");
			return { task: await summarizeTask(record, alive), mode: params.mode, accepted: true };
		}
		await this.terminals.killTerminal({ terminalId: record.meta.terminal_id, callerAgentId, signal });
		// Give the wrapper's HUP trap a moment to record the real exit code.
		await this.waitForStatus(record.dir, STOP_CONFIRM_MS);
		if (!(await readStatusFile(record.dir))) await writeStatusFile(record.dir, "terminated");
		return { task: await summarizeTask(record, false), mode: params.mode, accepted: true };
	}

	async cleanup(ctx: ExtensionContext, confirm: boolean): Promise<TaskCleanupResult> {
		assertProjectTrusted(ctx);
		const { projectRoot } = await this.projectPaths(ctx);
		const records = await listTaskRecords(projectRoot, this.home);
		const eligible: typeof records = [];
		let orphans: typeof records = [];
		for (const record of records) {
			if (await readStatusFile(record.dir)) eligible.push(record);
			else orphans.push(record);
		}
		if (orphans.length > 0) {
			// Orphaned sessions are terminal too, but proving them needs the daemon;
			// with the daemon down only recorded finishes are eligible.
			const alive = await this.aliveTerminalIds(parentAgentId()).catch(() => undefined);
			if (alive) {
				eligible.push(...orphans.filter((record) => !alive.has(record.meta.terminal_id)));
				orphans = orphans.filter((record) => alive.has(record.meta.terminal_id));
			}
		}
		if (!confirm) return { eligible: eligible.length, removed: 0 };

		let callerAgentId: string | undefined;
		try { callerAgentId = parentAgentId(); } catch { callerAgentId = undefined; }
		const keptTerminals = new Set(records.filter((record) => !eligible.includes(record)).map((record) => record.meta.terminal_id));
		for (const record of eligible) {
			// A session outlives its last task on purpose (the human may still look at it);
			// cleanup only releases terminals no record references any more.
			if (callerAgentId && !keptTerminals.has(record.meta.terminal_id)) {
				await this.terminals.killTerminal({ terminalId: record.meta.terminal_id, callerAgentId }).catch(() => {});
			}
			await removeTaskRecord(projectRoot, record.meta.task_id, this.home);
		}
		return { eligible: eligible.length, removed: eligible.length };
	}
}

export const backgroundTerminalService = new PaseoBackgroundTerminalService();

export function execResultText(taskId: string, summary: TaskSummary): string {
	if (summary.state === "exited") {
		return `${taskId} exited${summary.exit_code === undefined ? "" : ` exit=${summary.exit_code}`}${summary.terminated ? " terminated" : ""}`;
	}
	return taskId;
}

function renderResult(result: { content: Array<{ type: string; text?: string }>; details: unknown }, theme: any, expanded: boolean): Text {
	const details = result.details as Partial<BackgroundListResult & { task?: TaskSummary; summary?: TaskSummary }>;
	if (details.tasks) return new Text(theme.fg("accent", `${details.tasks.length} background task(s)`), 0, 0);
	const task = details.task ?? details.summary;
	if (!task) return new Text(theme.fg("toolTitle", result.content[0]?.text ?? ""), 0, 0);
	if (!expanded) return new Text(theme.fg("toolTitle", `${task.label} [${task.state}]`), 0, 0);
	const color = task.state === "orphaned" ? "error" : task.state === "exited" && task.exit_code !== 0 && !task.terminated ? "warning" : "success";
	return new Text(theme.fg(color, taskSummaryText(task)), 0, 0);
}

export default function paseoBackgroundTerminalExtension(pi: ExtensionAPI): void {
	const service = backgroundTerminalService;

	pi.registerTool({
		name: "background_exec",
		label: "Background Exec",
		description: "Run a POSIX shell command in a persistent Paseo terminal session and track it as a background task.",
		promptSnippet: "Start a command in a persistent Paseo background terminal session",
		promptGuidelines: [
			"background_exec returns a task_id; with wait_ms it also reports completion and the exit code when the command finished in time.",
			"output=\"log\" (default) keeps exact command bytes in a log file the human can tail; output=\"screen\" leaves output on the terminal for interactive programs.",
			"Pass session=<task_id> to run the next command in the same shell session (queued after a running one); commands run under POSIX sh.",
		],
		parameters: Type.Object({
			command: Type.String({ minLength: 1, maxLength: 65_536, description: "POSIX shell command to run" }),
			cwd: Type.Optional(Type.String({ maxLength: 4096, description: "Working directory inside the current trusted project" })),
			label: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_LABEL_LENGTH, description: "Human-readable task label" })),
			session: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Existing task id whose Paseo terminal session is reused" })),
			output: Type.Optional(Type.Union([Type.Literal("log"), Type.Literal("screen")], { description: "Output sink: log file (default) or terminal screen" })),
			wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS, description: "Wait up to N ms for completion before returning" })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: BackgroundExecParams, signal, _onUpdate, ctx) {
			const result = await service.exec(params, ctx, signal);
			return { content: [{ type: "text", text: execResultText(result.task_id, result.summary) }], details: result };
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
		description: "List tracked background tasks or get one task by id; states are derived from side-channel files and terminal presence.",
		promptSnippet: "List persistent Paseo background tasks",
		promptGuidelines: ["background_list works while the Paseo daemon is down for finished tasks; running tasks fall back to reported state."],
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
		description: "Read one background task's output: log-mode tasks return exact bytes since the last read, screen-mode tasks return rendered terminal lines.",
		promptSnippet: "Read output from a persistent Paseo background task",
		promptGuidelines: [
			"Log mode advances a per-task byte cursor; range=\"all\" returns the bounded tail without rewinding earlier reads.",
			"background_read only reports output; use background_list for state, exit codes, and the log path.",
		],
		parameters: Type.Object({
			task_id: Type.String({ minLength: 1, maxLength: 128 }),
			wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS })),
			output_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OUTPUT_LINES })),
			range: Type.Optional(Type.Union([Type.Literal("new"), Type.Literal("all")], { description: "Log mode: new bytes since the last read (default) or the bounded tail" })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: BackgroundReadParams, signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: await service.read(params, ctx, signal) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "background_write",
		label: "Background Write",
		description: "Send input to a running background task's terminal session.",
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
			"Use mode=interrupt for Ctrl+C (the wrapper records exit code 130) and mode=terminate to kill the session terminal.",
			"Terminated tasks keep their log file; a task whose trap could not run reports terminated.",
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
					ctx.ui.notify(confirmed ? `Removed ${result.removed} finished background task(s).` : `${result.eligible} finished background task(s) can be cleaned. Run /bg clean --confirm.`, "info");
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
