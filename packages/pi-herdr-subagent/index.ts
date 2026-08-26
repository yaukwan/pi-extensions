import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	assertProjectTrusted,
	backgroundTerminalService,
	type BackgroundListResult,
	type BackgroundStopResult,
	type TaskSummary,
} from "pi-herdr-background-terminal";

const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_NAME_LENGTH = 40;
const MAX_MODEL_LENGTH = 256;
const MAX_ACTIVE_SUBAGENTS = 8;
const MAX_READ_WAIT_MS = 300_000;
const DEFAULT_WAIT_OUTPUT_LINES = 120;
const MAX_OUTPUT_LINES = 2_000;
const SUBAGENT_LABEL_PREFIX = "subagent:";
const PLUGIN_CONFIG_KEY = "pi-herdr-subagent";
const MODEL_PRESET_NAMES = ["fast", "balanced", "strong"] as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const ROLE_TOOLS = {
	scout: ["read", "grep", "find", "ls"],
	reviewer: ["read", "grep", "find", "ls", "bash"],
	worker: ["read", "grep", "find", "ls", "bash", "edit", "write"],
} as const;

export type SubagentRole = keyof typeof ROLE_TOOLS;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export type ModelPreset = typeof MODEL_PRESET_NAMES[number];

export interface SubagentPreset {
	model: string;
	thinking?: ThinkingLevel;
}

export interface SubagentRunParams {
	prompt: string;
	role?: SubagentRole;
	name?: string;
	model_preset?: ModelPreset;
	thinking?: ThinkingLevel;
	cwd?: string;
}

export interface SubagentReadParams {
	subagent_id: string;
	wait_ms?: number;
	output_lines?: number;
}

export interface SubagentWaitParams {
	subagent_ids: string[];
	mode?: "all" | "any";
	wait_ms?: number;
	output_lines?: number;
}

export interface SubagentStopParams {
	subagent_id: string;
	mode: "interrupt" | "terminate";
}

export interface SubagentSummary extends TaskSummary {
	subagent_id: string;
	role: SubagentRole;
}

function assertUtf8Bytes(value: string, maximum: number, name: string): void {
	if (Buffer.byteLength(value, "utf8") > maximum) throw new Error(`invalid_arguments: ${name} is too large`);
}

function assertRunParams(params: SubagentRunParams): void {
	if (typeof params.prompt !== "string" || !params.prompt.trim()) throw new Error("invalid_arguments: prompt must not be empty");
	assertUtf8Bytes(params.prompt, MAX_PROMPT_BYTES, "prompt");
	if (params.name !== undefined && (params.name.length > MAX_NAME_LENGTH || /[\r\n]/.test(params.name))) {
		throw new Error(`invalid_arguments: name must be at most ${MAX_NAME_LENGTH} characters and contain no line breaks`);
	}
	if (params.model_preset !== undefined && !MODEL_PRESET_NAMES.includes(params.model_preset)) {
		throw new Error(`invalid_arguments: model_preset must be one of ${MODEL_PRESET_NAMES.join(", ")}`);
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		if (error instanceof SyntaxError) throw new Error(`invalid_configuration: could not parse ${path}`);
		throw error;
	}
}

function readConfiguredPresets(settings: Record<string, unknown>, path: string): Record<string, SubagentPreset> {
	const plugin = settings[PLUGIN_CONFIG_KEY];
	if (plugin === undefined) return {};
	if (!isRecord(plugin) || !isRecord(plugin.presets)) throw new Error(`invalid_configuration: ${path}.${PLUGIN_CONFIG_KEY}.presets must be an object`);
	const presets: Record<string, SubagentPreset> = {};
	for (const [name, value] of Object.entries(plugin.presets)) {
		if (!MODEL_PRESET_NAMES.includes(name as ModelPreset)) throw new Error(`invalid_configuration: unknown model preset ${name}`);
		if (!isRecord(value) || typeof value.model !== "string" || !value.model.trim()) {
			throw new Error(`invalid_configuration: ${path}.${PLUGIN_CONFIG_KEY}.presets.${name}.model must be a non-empty string`);
		}
		if (value.model.length > MAX_MODEL_LENGTH) throw new Error(`invalid_configuration: ${path}.${PLUGIN_CONFIG_KEY}.presets.${name}.model is too long`);
		if (value.thinking !== undefined && !THINKING_LEVELS.includes(value.thinking as ThinkingLevel)) {
			throw new Error(`invalid_configuration: ${path}.${PLUGIN_CONFIG_KEY}.presets.${name}.thinking is invalid`);
		}
		presets[name] = { model: value.model.trim(), thinking: value.thinking as ThinkingLevel | undefined };
	}
	return presets;
}

async function loadConfiguredPresets(ctx: ExtensionContext): Promise<Record<string, SubagentPreset>> {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(ctx.cwd, ".pi", "settings.json");
	const globalPresets = readConfiguredPresets(await readSettings(globalPath), globalPath);
	const projectPresets = ctx.isProjectTrusted() ? readConfiguredPresets(await readSettings(projectPath), projectPath) : {};
	return { ...globalPresets, ...projectPresets };
}

export function resolveConfiguredModel(value: string, ctx: ExtensionContext, source: string): string {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) {
		throw new Error(`invalid_configuration: ${source}.model must use provider/model format`);
	}
	const provider = value.slice(0, separator);
	const modelId = value.slice(separator + 1);
	if (!ctx.modelRegistry.find(provider, modelId)) throw new Error(`invalid_configuration: unknown model ${value} in ${source}`);
	return value;
}

export async function resolveSubagentModel(params: SubagentRunParams, ctx: ExtensionContext): Promise<{ model?: string; thinking?: ThinkingLevel }> {
	const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	if (!params.model_preset) return { model: parentModel, thinking: params.thinking ?? ctx.thinkingLevel };
	const presets = await loadConfiguredPresets(ctx);
	const preset = presets[params.model_preset];
	if (!preset) throw new Error(`invalid_configuration: model preset ${params.model_preset} is not configured`);
	return {
		model: resolveConfiguredModel(preset.model, ctx, `${PLUGIN_CONFIG_KEY}.presets.${params.model_preset}`),
		thinking: params.thinking ?? preset.thinking ?? ctx.thinkingLevel,
	};
}

let currentSessionKey: string | undefined;
let sessionSubagentIds = new Set<string>();

function sessionIds(ctx: ExtensionContext): Set<string> {
	const key = ctx.sessionManager.getSessionId() || ctx.sessionManager.getSessionFile() || `process:${process.pid}`;
	if (key !== currentSessionKey) {
		currentSessionKey = key;
		sessionSubagentIds = new Set<string>();
	}
	return sessionSubagentIds;
}

function resetSession(): void {
	currentSessionKey = undefined;
	sessionSubagentIds = new Set<string>();
}

function roleInstructions(role: SubagentRole): string {
	return [
		"You are a delegated Pi subagent.",
		`Role: ${role}.`,
		"Work only on the assigned task in the current project.",
		"Do not spawn another agent or start unrelated background work.",
		"Return a concise final report with findings, actions, and remaining risks.",
		role === "scout" ? "You are read-only: do not modify files or run commands that mutate state." : "Respect the requested scope and verify claims with the available tools.",
	].join("\n");
}

export interface SubagentCommandParams {
	prompt: string;
	role: SubagentRole;
	model?: string;
	thinking?: ThinkingLevel;
}

export function buildSubagentCommand(params: SubagentCommandParams): string {
	const args = [
		"pi",
		"--print",
		"--no-session",
		"--no-extensions",
		"--approve",
		"--tools",
		ROLE_TOOLS[params.role].join(","),
	];
	if (params.model) args.push("--model", params.model);
	if (params.thinking) args.push("--thinking", params.thinking);
	args.push("--append-system-prompt", roleInstructions(params.role), `Task:\n${params.prompt}`);
	return `exec ${args.map(shellQuote).join(" ")}`;
}

export function isSubagentLabel(label: string): boolean {
	return label.startsWith(SUBAGENT_LABEL_PREFIX);
}

function roleFromLabel(label: string): SubagentRole | undefined {
	const role = label.slice(SUBAGENT_LABEL_PREFIX.length).split(":", 1)[0];
	return role in ROLE_TOOLS ? role as SubagentRole : undefined;
}

function isActive(task: TaskSummary): boolean {
	return task.state === "starting" || task.state === "running";
}

function isTerminal(task: TaskSummary): boolean {
	return !isActive(task);
}

function toSummary(task: TaskSummary): SubagentSummary | undefined {
	const role = roleFromLabel(task.label);
	return role ? { ...task, subagent_id: task.task_id, role } : undefined;
}

function summaryText(task: SubagentSummary): string {
	const exit = task.exit_code === undefined ? "" : ` exit=${task.exit_code}`;
	return `${task.subagent_id} [${task.state}] ${task.role} ${task.label}${exit}`;
}

async function listAll(ctx: ExtensionContext): Promise<SubagentSummary[]> {
	const ids = sessionIds(ctx);
	const summaries = await Promise.all([...ids].map(async (id) => {
		const page: BackgroundListResult = await backgroundTerminalService.list({ task_id: id, limit: 1 }, ctx);
		const summary = page.tasks[0] ? toSummary(page.tasks[0]) : undefined;
		if (!summary) ids.delete(id);
		return summary;
	}));
	return summaries.filter((task): task is SubagentSummary => task !== undefined);
}

async function getSubagent(id: string, ctx: ExtensionContext): Promise<SubagentSummary> {
	const summary = (await listAll(ctx)).find((task) => task.subagent_id === id);
	if (!summary) throw new Error(`subagent_not_found: ${id}. Use subagent_list.`);
	return summary;
}

interface WaitObservation {
	task: SubagentSummary;
	timedOut: boolean;
}

async function waitForTerminal(id: string, deadline: number, ctx: ExtensionContext, signal?: AbortSignal): Promise<WaitObservation> {
	let task = await getSubagent(id, ctx);
	while (!isTerminal(task)) {
		const waitMs = Math.max(0, deadline - Date.now());
		if (waitMs === 0) return { task, timedOut: true };
		await backgroundTerminalService.read({ task_id: id, wait_ms: waitMs, output_lines: 1 }, ctx, signal);
		task = await getSubagent(id, ctx);
	}
	return { task, timedOut: false };
}

async function readWaitResult(task: SubagentSummary, outputLines: number, ctx: ExtensionContext, signal?: AbortSignal): Promise<{ task: SubagentSummary; output: string }> {
	const output = await backgroundTerminalService.read({ task_id: task.subagent_id, wait_ms: 0, output_lines: outputLines }, ctx, signal);
	const latest = await getSubagent(task.subagent_id, ctx);
	return { task: latest, output };
}

async function waitForSubagents(params: SubagentWaitParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<{ results: Array<{ task: SubagentSummary; output: string }>; timedOut: boolean }> {
	const ids = [...new Set(params.subagent_ids)];
	if (ids.length !== params.subagent_ids.length) throw new Error("invalid_arguments: subagent_ids must not contain duplicates");
	const initial = await Promise.all(ids.map((id) => getSubagent(id, ctx)));
	const deadline = Date.now() + (params.wait_ms ?? MAX_READ_WAIT_MS);
	let tasks: SubagentSummary[];
	let timedOut: boolean;
	if (params.mode === "any") {
		const winner = await waitForAny(ids, deadline, ctx, signal);
		tasks = await Promise.all(ids.map((id) => getSubagent(id, ctx)));
		timedOut = winner === undefined;
	} else {
		const observations = await Promise.all(ids.map((id) => waitForTerminal(id, deadline, ctx, signal)));
		tasks = observations.map(({ task }) => task);
		timedOut = observations.some(({ timedOut: observationTimedOut }) => observationTimedOut);
	}
	const results = await Promise.all(initial.map((initialTask, index) => readWaitResult(tasks[index] ?? initialTask, params.output_lines ?? DEFAULT_WAIT_OUTPUT_LINES, ctx, signal)));
	return { results, timedOut };
}

async function waitForAny(ids: string[], deadline: number, ctx: ExtensionContext, signal?: AbortSignal): Promise<WaitObservation | undefined> {
	const controller = new AbortController();
	const forwardAbort = signal ? () => controller.abort(signal.reason) : undefined;
	if (signal?.aborted) forwardAbort?.();
	else if (forwardAbort) signal.addEventListener("abort", forwardAbort, { once: true });
	try {
		const winner = await Promise.race([
			...ids.map((subagentId) => waitForTerminal(subagentId, deadline, ctx, controller.signal)),
			delay(Math.max(0, deadline - Date.now())).then(() => undefined),
		]);
		return winner && !winner.timedOut ? winner : undefined;
	} finally {
		if (forwardAbort) signal?.removeEventListener("abort", forwardAbort);
		controller.abort();
	}
}

function renderSummary(result: { content: Array<{ type: string; text?: string }>; details: unknown }, theme: any): Text {
	const details = result.details as { task?: SubagentSummary; tasks?: SubagentSummary[] };
	if (details.tasks) return new Text(theme.fg("accent", `${details.tasks.length} subagent(s)`), 0, 0);
	return new Text(theme.fg("toolTitle", details.task ? summaryText(details.task) : result.content[0]?.text ?? ""), 0, 0);
}

export default function piHerdrSubagentExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent_run",
		label: "Subagent Run",
		description: "Start a delegated Pi subagent using an optional configured model preset and return its opaque id.",
		promptSnippet: "Start an asynchronous delegated subagent",
		promptGuidelines: ["model_preset is optional; omit it to inherit the parent model. Use fast, balanced, or strong when a configured preset is needed.", "Use subagent_wait to wait for one or more subagents, subagent_read to inspect output without waiting, and subagent_stop to interrupt or terminate a subagent."],
		parameters: Type.Object({
			prompt: Type.String({ minLength: 1, maxLength: MAX_PROMPT_BYTES, description: "Focused task for the delegated agent" }),
			role: Type.Optional(Type.Union([Type.Literal("scout"), Type.Literal("reviewer"), Type.Literal("worker")], { default: "scout" })),
			name: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_NAME_LENGTH, description: "Display name" })),
			model_preset: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("balanced"), Type.Literal("strong")], { description: "Optional configured model preset; omit to inherit the parent model" })),
			thinking: Type.Optional(Type.Union([
				Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
				Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
			])),
			cwd: Type.Optional(Type.String({ maxLength: 4096, description: "Working directory inside the current trusted project" })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: SubagentRunParams, signal, _onUpdate, ctx) {
			assertProjectTrusted(ctx);
			assertRunParams(params);
			const role = params.role ?? "scout";
			const resolved = await resolveSubagentModel(params, ctx);
			const subagents = await listAll(ctx);
			if (subagents.filter(isActive).length >= MAX_ACTIVE_SUBAGENTS) {
				throw new Error(`too_many_active_subagents: ${MAX_ACTIVE_SUBAGENTS} subagents are still active`);
			}
			const label = `${SUBAGENT_LABEL_PREFIX}${role}:${params.name?.trim() || "task"}`;
			const task = await backgroundTerminalService.exec({
				command: buildSubagentCommand({ role, model: resolved.model, thinking: resolved.thinking, prompt: params.prompt }),
				cwd: params.cwd,
				label,
			}, ctx, signal);
			sessionIds(ctx).add(task.task_id);
			const summary = await getSubagent(task.task_id, ctx);
			return {
				content: [{ type: "text", text: summary.subagent_id }],
				details: { subagent_id: summary.subagent_id, task: summary },
			};
		},
		renderResult(result, _options, theme) { return renderSummary(result, theme); },
	});

	pi.registerTool({
		name: "subagent_list",
		label: "Subagent List",
		description: "List delegated subagents created in the current Pi session, including state and exit code.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			assertProjectTrusted(ctx);
			const tasks = await listAll(ctx);
			return { content: [{ type: "text", text: tasks.length ? tasks.map(summaryText).join("\n") : "No subagents" }], details: { tasks } };
		},
		renderResult(result, _options, theme) { return renderSummary(result, theme); },
	});

	pi.registerTool({
		name: "subagent_read",
		label: "Subagent Read",
		description: "Read bounded output from a delegated subagent, optionally waiting for completion.",
		parameters: Type.Object({
			subagent_id: Type.String({ minLength: 1, maxLength: 128 }),
			wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_READ_WAIT_MS })),
			output_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OUTPUT_LINES })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: SubagentReadParams, signal, _onUpdate, ctx) {
			assertProjectTrusted(ctx);
			const summary = await getSubagent(params.subagent_id, ctx);
			const output = await backgroundTerminalService.read({ task_id: summary.subagent_id, wait_ms: params.wait_ms, output_lines: params.output_lines }, ctx, signal);
			const latest = await getSubagent(params.subagent_id, ctx);
			const truncationNotice = latest.output_truncated ? "\n\n[output truncated, showing only the tail]" : "";
			return {
				content: [{ type: "text", text: `${summaryText(latest)}\n\n${output}${truncationNotice}` }],
				details: { task: latest, output, output_truncated: latest.output_truncated ?? false },
			};
		},
		renderResult(result, _options, theme) { return renderSummary(result, theme); },
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent Wait",
		description: "Wait for one or more delegated subagents, then return their current state and bounded output.",
		parameters: Type.Object({
			subagent_ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: MAX_ACTIVE_SUBAGENTS }),
			mode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("any")], { default: "all" })),
			wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_READ_WAIT_MS, description: "Shared timeout for the wait operation" })),
			output_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OUTPUT_LINES })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: SubagentWaitParams, signal, _onUpdate, ctx) {
			assertProjectTrusted(ctx);
			const result = await waitForSubagents(params, ctx, signal);
			const text = result.results.map(({ task, output }) => {
				const truncationNotice = task.output_truncated ? "\n\n[output truncated, showing only the tail]" : "";
				return `${summaryText(task)}\n\n${output}${truncationNotice}`;
			}).join("\n\n---\n\n");
			return { content: [{ type: "text", text }], details: { mode: params.mode ?? "all", timed_out: result.timedOut, tasks: result.results.map(({ task }) => task) } };
		},
		renderResult(result, _options, theme) { return renderSummary(result, theme); },
	});

	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent Stop",
		description: "Interrupt or terminate a delegated subagent.",
		parameters: Type.Object({
			subagent_id: Type.String({ minLength: 1, maxLength: 128 }),
			mode: Type.Union([Type.Literal("interrupt"), Type.Literal("terminate")]),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: SubagentStopParams, signal, _onUpdate, ctx) {
			assertProjectTrusted(ctx);
			const summary = await getSubagent(params.subagent_id, ctx);
			const result: BackgroundStopResult = await backgroundTerminalService.stop({ task_id: summary.subagent_id, mode: params.mode }, ctx, signal);
			const task = toSummary(result.task);
			if (!task) throw new Error(`subagent_state_invalid: ${summary.subagent_id}`);
			return { content: [{ type: "text", text: `${summaryText(task)} ${result.mode} ${result.accepted ? "accepted" : result.reason ?? "not accepted"}` }], details: { task, mode: result.mode, accepted: result.accepted } };
		},
		renderResult(result, _options, theme) { return renderSummary(result, theme); },
	});

	pi.on("session_start", (_event, ctx) => { sessionIds(ctx); });
	pi.on("session_shutdown", () => { resetSession(); });

	pi.registerCommand("subagent", {
		description: "List, read, or stop Herdr subagents",
		handler: async (args, ctx) => {
			const [action = "list", id] = args.trim().split(/\s+/);
			if (action === "list") {
				const tasks = await listAll(ctx);
				ctx.ui.notify(tasks.length ? tasks.map(summaryText).join("\n") : "No subagents", "info");
				return;
			}
			if (action === "read" && id) {
				const summary = await getSubagent(id, ctx);
				ctx.ui.notify(await backgroundTerminalService.read({ task_id: id }, ctx), "info");
				ctx.ui.notify(summaryText(summary), "info");
				return;
			}
			if ((action === "interrupt" || action === "terminate") && id) {
				const result = await backgroundTerminalService.stop({ task_id: id, mode: action }, ctx);
				ctx.ui.notify(`${summaryText(toSummary(result.task) as SubagentSummary)} ${result.accepted ? "accepted" : "not accepted"}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /subagent [list|read|interrupt|terminate] [subagent_id]", "warning");
		},
	});
}
