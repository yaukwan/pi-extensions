import { setTimeout as delay } from "node:timers/promises";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { paseoMcp } from "./mcp-client.ts";

const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_NAME_LENGTH = 40;
const MAX_ACTIVE_SUBAGENTS = 8;
const MAX_WAIT_MS = 300_000;
const DEFAULT_WAIT_MS = 300_000;
const DEFAULT_OUTPUT_LINES = 120;
const MAX_OUTPUT_LINES = 2_000;
/** Paseo caps `list_agents` at 200 rows and its archived window at 30 days. */
const CHILD_LIST_LIMIT = 200;
const ARCHIVED_WINDOW_HOURS = 24 * 30;
const SESSION_LABEL_KEY = "pi-paseo-subagent";
const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
const ACTIVE_STATUSES = ["initializing", "running"];
const ROLES = ["scout", "reviewer", "worker"] as const;
const ARCHIVED_TRANSCRIPT_NOTE =
	"archived: this subagent was removed from the track, and reading it here would resume it on the daemon (re-adding it to the list and re-firing its finish notification). Inspect it in Paseo instead.";

export type SubagentRole = typeof ROLES[number];
/** Overridable so tests do not have to wait out a real poll interval. */
export const subagentTiming = { pollIntervalMs: 500 };

export interface SubagentRunParams {
	prompt: string;
	role?: SubagentRole;
	name?: string;
	profile?: string;
	provider?: string;
	thinking?: string;
}

export interface SubagentListParams {
	include_finished?: boolean;
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

export interface AgentProfile {
	id: string;
	name: string;
	provider: string;
	model?: string;
	thinkingOptionId?: string;
	modeId?: string;
	notes?: string;
}

export interface SubagentSummary {
	subagent_id: string;
	name: string;
	role?: SubagentRole;
	status: string;
	provider: string;
	model?: string;
	requiresAttention?: boolean;
	attentionReason?: string;
	archived?: boolean;
}

interface AgentSnapshot {
	id: string;
	provider: string;
	model?: string;
	thinkingOptionId?: string;
	effectiveThinkingOptionId?: string;
	status: string;
	title?: string;
	parentAgentId?: string;
	requiresAttention?: boolean;
	attentionReason?: string;
	archived?: boolean;
}

interface SubagentTarget {
	provider: string;
	model?: string;
	/** Passed to Paseo as `settings.thinkingOptionId`; ids are provider-specific, so they are not validated here. */
	thinking?: string;
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

export function parentAgentId(env: NodeJS.ProcessEnv = process.env): string {
	const id = env.PASEO_AGENT_ID?.trim();
	if (!id) {
		fail("paseo_agent_context_missing", "this Pi session does not run inside a Paseo agent, so delegation would create an unrelated top-level agent instead of a subagent");
	}
	return id;
}

export function sessionKey(ctx: ExtensionContext): string {
	const raw = ctx.sessionManager.getSessionId()?.trim() || ctx.sessionManager.getSessionFile()?.trim() || `pid-${process.pid}`;
	return raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(-120);
}

export function subagentTitle(role: SubagentRole, name?: string): string {
	return `${role}: ${name?.trim() || "task"}`;
}

export function parseSubagentTitle(title: string): { role?: SubagentRole; name: string } {
	const trimmed = title.trim();
	const [prefix, ...rest] = trimmed.split(":");
	const role = prefix && (ROLES as readonly string[]).includes(prefix) ? prefix as SubagentRole : undefined;
	if (!role) return { name: trimmed };
	return { role, name: rest.join(":").trim() || "task" };
}

/** Accepts `provider` or `provider/model`. */
export function splitProviderModel(value: string): { provider: string; model?: string } {
	const separator = value.indexOf("/");
	if (separator === 0) fail("invalid_arguments", `provider "${value}" has an empty provider`);
	const provider = value.slice(0, separator < 0 ? undefined : separator).trim();
	if (!provider) fail("invalid_arguments", "provider must not be empty");
	if (separator < 0) return { provider };
	const model = value.slice(separator + 1).trim();
	if (!model) fail("invalid_arguments", `provider "${value}" has an empty model`);
	return { provider, model };
}

export function providerSelector(provider: string, model?: string): string {
	return model ? `${provider}/${model}` : provider;
}

export function parseProfiles(value: unknown): AgentProfile[] {
	const profiles = isRecord(value) ? value.profiles : undefined;
	if (!Array.isArray(profiles)) fail("paseo_invalid_output", "list_profiles returned no profiles");
	const parsed: AgentProfile[] = [];
	for (const entry of profiles) {
		if (!isRecord(entry)) continue;
		const id = asString(entry.id);
		const provider = asString(entry.provider);
		if (!id || !provider) continue;
		parsed.push({
			id,
			name: asString(entry.name) ?? id,
			provider,
			...(asString(entry.model) ? { model: asString(entry.model) as string } : {}),
			...(asString(entry.thinkingOptionId) ? { thinkingOptionId: asString(entry.thinkingOptionId) as string } : {}),
			...(asString(entry.modeId) ? { modeId: asString(entry.modeId) as string } : {}),
			...(asString(entry.notes) ? { notes: asString(entry.notes) as string } : {}),
		});
	}
	return parsed;
}

export function parseAgentSnapshot(value: unknown): AgentSnapshot {
	// `get_agent_status` answers with `{status, snapshot}`; accept a bare snapshot too.
	const snapshot = isRecord(value) && isRecord(value.snapshot) ? value.snapshot : value;
	if (!isRecord(snapshot)) fail("paseo_invalid_output", "get_agent_status returned no snapshot");
	const id = asString(snapshot.id);
	const provider = asString(snapshot.provider);
	const status = asString(snapshot.status);
	if (!id || !provider || !status) fail("paseo_invalid_output", "get_agent_status returned an incomplete snapshot");
	const labels = isRecord(snapshot.labels) ? snapshot.labels : {};
	return {
		id,
		provider,
		status,
		...(asString(snapshot.model) ? { model: asString(snapshot.model) as string } : {}),
		...(asString(snapshot.thinkingOptionId) ? { thinkingOptionId: asString(snapshot.thinkingOptionId) as string } : {}),
		...(asString(snapshot.effectiveThinkingOptionId) ? { effectiveThinkingOptionId: asString(snapshot.effectiveThinkingOptionId) as string } : {}),
		...(asString(snapshot.title) ? { title: asString(snapshot.title) as string } : {}),
		...(asString(labels[PARENT_AGENT_ID_LABEL]) ? { parentAgentId: asString(labels[PARENT_AGENT_ID_LABEL]) as string } : {}),
		requiresAttention: snapshot.requiresAttention === true,
		...(asString(snapshot.attentionReason) ? { attentionReason: asString(snapshot.attentionReason) as string } : {}),
		...(asString(snapshot.archivedAt) ? { archived: true } : {}),
	};
}

export function summarizeSnapshot(snapshot: AgentSnapshot): SubagentSummary {
	const { role, name } = parseSubagentTitle(snapshot.title ?? "");
	return {
		subagent_id: snapshot.id,
		name,
		...(role ? { role } : {}),
		status: snapshot.status,
		provider: providerSelector(snapshot.provider, snapshot.model),
		...(snapshot.model ? { model: snapshot.model } : {}),
		requiresAttention: snapshot.requiresAttention,
		...(snapshot.attentionReason ? { attentionReason: snapshot.attentionReason } : {}),
		...(snapshot.archived ? { archived: true } : {}),
	};
}

export function parseChildren(value: unknown, parentId: string): SubagentSummary[] {
	const agents = isRecord(value) ? value.agents : undefined;
	if (!Array.isArray(agents)) fail("paseo_invalid_output", "list_agents returned no agents");
	const children: SubagentSummary[] = [];
	for (const entry of agents) {
		if (!isRecord(entry)) continue;
		const id = asString(entry.id);
		const labels = isRecord(entry.labels) ? entry.labels : {};
		if (!id || asString(labels[PARENT_AGENT_ID_LABEL]) !== parentId) continue;
		const { role, name } = parseSubagentTitle(asString(entry.title) ?? "");
		children.push({
			subagent_id: id,
			name,
			...(role ? { role } : {}),
			status: asString(entry.status) ?? "unknown",
			provider: providerSelector(asString(entry.provider) ?? "", asString(entry.model)),
			...(asString(entry.model) ? { model: asString(entry.model) as string } : {}),
			requiresAttention: entry.requiresAttention === true,
			...(asString(entry.attentionReason) ? { attentionReason: asString(entry.attentionReason) as string } : {}),
			...(asString(entry.archivedAt) ? { archived: true } : {}),
		});
	}
	return children;
}

export function parseActivity(value: unknown): string {
	if (!isRecord(value)) fail("paseo_invalid_output", "get_agent_activity returned no activity");
	const content = asString(value.content);
	if (!content) fail("paseo_invalid_output", "get_agent_activity returned no content");
	return content;
}

export function parseCreateAgent(value: unknown): { agentId: string; guidance?: string } {
	const agentId = isRecord(value) ? asString(value.agentId) : undefined;
	if (!agentId) fail("paseo_invalid_output", "create_agent did not return an agentId");
	const guidance = isRecord(value) ? asString(value.guidance) : undefined;
	return { agentId, ...(guidance ? { guidance } : {}) };
}

function isActive(child: SubagentSummary): boolean {
	return !child.archived && ACTIVE_STATUSES.includes(child.status);
}

function isBlocked(child: SubagentSummary): boolean {
	return child.attentionReason === "permission";
}

function isSettled(child: SubagentSummary): boolean {
	return !isActive(child) || isBlocked(child);
}

function summaryText(child: SubagentSummary): string {
	const attention = child.attentionReason ? ` attention=${child.attentionReason}` : "";
	const archived = child.archived ? " archived" : "";
	return `${child.subagent_id} [${child.status}] ${child.role ?? "-"} ${child.name}${attention}${archived}`;
}

export function waitNote(child: SubagentSummary | undefined, waitMs: number, timedOut: boolean): string {
	if (child?.attentionReason === "permission") {
		return "\n\nwaiting for permission approval: approve it in Paseo, or run `paseo permit allow <id>`.";
	}
	if (timedOut && child && isActive(child)) return `\n\nstill running after ${waitMs}ms.`;
	return "";
}

async function getAgentSnapshot(agentId: string, parentId: string, signal?: AbortSignal): Promise<AgentSnapshot> {
	try {
		return parseAgentSnapshot(await paseoMcp.callTool<unknown>("get_agent_status", { agentId }, { callerAgentId: parentId, signal }));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/not found/i.test(message)) fail("subagent_not_found", `${agentId} does not exist on this Paseo daemon`);
		throw error;
	}
}

async function requireOwnedChild(agentId: string, parentId: string, signal?: AbortSignal): Promise<AgentSnapshot> {
	const snapshot = await getAgentSnapshot(agentId, parentId, signal);
	if (snapshot.parentAgentId !== parentId) {
		fail("subagent_not_found", `${agentId} is not a subagent of this session`);
	}
	return snapshot;
}

async function listChildren(parentId: string, includeFinished: boolean, signal?: AbortSignal): Promise<SubagentSummary[]> {
	const value = await paseoMcp.callTool<unknown>(
		"list_agents",
		{ includeArchived: includeFinished, sinceHours: ARCHIVED_WINDOW_HOURS, limit: CHILD_LIST_LIMIT },
		{ callerAgentId: parentId, signal },
	);
	return parseChildren(value, parentId);
}

async function findProfile(query: string, parentId: string, signal?: AbortSignal): Promise<AgentProfile> {
	const profiles = parseProfiles(await paseoMcp.callTool<unknown>("list_profiles", {}, { callerAgentId: parentId, signal }));
	const trimmed = query.trim();
	const profile = profiles.find((entry) => entry.id === trimmed)
		?? profiles.find((entry) => entry.name.toLowerCase() === trimmed.toLowerCase());
	if (!profile) fail("profile_not_found", `${query}. Use subagent_presets to list Paseo agent profiles.`);
	return profile;
}

function withThinking(target: SubagentTarget, thinking: string | undefined): SubagentTarget {
	return thinking ? { ...target, thinking } : target;
}

export async function resolveSubagentTarget(params: SubagentRunParams, parentId: string, signal?: AbortSignal): Promise<SubagentTarget> {
	if (params.provider && params.profile) fail("invalid_arguments", "pass either provider or profile, not both");
	if (params.provider) {
		return withThinking(splitProviderModel(params.provider), params.thinking);
	}
	if (params.profile) {
		const profile = await findProfile(params.profile, parentId, signal);
		const target = splitProviderModel(profile.model ? `${profile.provider}/${profile.model}` : profile.provider);
		return withThinking(target, params.thinking ?? profile.thinkingOptionId);
	}
	const parent = await getAgentSnapshot(parentId, parentId, signal);
	return withThinking(
		{ provider: parent.provider, ...(parent.model ? { model: parent.model } : {}) },
		params.thinking ?? parent.effectiveThinkingOptionId ?? parent.thinkingOptionId,
	);
}

interface PollOutcome {
	children: Map<string, SubagentSummary>;
	timedOut: boolean;
}

async function pollChildren(ids: string[], mode: "all" | "any", waitMs: number, parentId: string, signal?: AbortSignal): Promise<PollOutcome> {
	const wanted = new Set(ids);
	const deadline = Date.now() + waitMs;
	let children = new Map<string, SubagentSummary>();
	for (;;) {
		children = new Map((await listChildren(parentId, true, signal)).filter((child) => wanted.has(child.subagent_id)).map((child) => [child.subagent_id, child]));
		const settled = ids.filter((id) => {
			const child = children.get(id);
			return !child || isSettled(child);
		});
		if (mode === "any" ? settled.length > 0 : settled.length === ids.length) return { children, timedOut: false };
		const remaining = deadline - Date.now();
		if (remaining <= 0) return { children, timedOut: true };
		await delay(Math.min(subagentTiming.pollIntervalMs, remaining));
		if (signal?.aborted) fail("cancelled", "the wait was cancelled");
	}
}

async function readActivity(child: { subagent_id: string; archived?: boolean }, outputLines: number, parentId: string, signal?: AbortSignal): Promise<string> {
	// `get_agent_activity` resumes an archived agent on the daemon, which clears `archivedAt` (ghost row in the
	// default list) and re-fires its finish notification. There is no no-wake variant of the tool.
	if (child.archived) return ARCHIVED_TRANSCRIPT_NOTE;
	return parseActivity(await paseoMcp.callTool<unknown>("get_agent_activity", { agentId: child.subagent_id, limit: outputLines }, { callerAgentId: parentId, signal }));
}

function roleInstructions(role: SubagentRole): string {
	return [
		"You are a delegated Paseo subagent.",
		`Role: ${role}.`,
		"Work only on the assigned task in the current project.",
		"Do not create workspaces or start unrelated agents.",
		"Return a concise final report with findings, actions, and remaining risks.",
		role === "scout" ? "You are read-only: do not modify files or run commands that mutate state." : "Respect the requested scope and verify claims with the available tools.",
	].join("\n");
}

export function buildInitialPrompt(prompt: string, role: SubagentRole): string {
	return `${roleInstructions(role)}\n\nTask:\n${prompt}`;
}

function renderSummary(result: { content: Array<{ type: string; text?: string }>; details: unknown }, theme: any): Text {
	const details = result.details as { summary?: SubagentSummary; summaries?: SubagentSummary[] };
	if (details.summaries) return new Text(theme.fg("accent", `${details.summaries.length} subagent(s)`), 0, 0);
	const label = details.summary ? summaryText(details.summary) : result.content[0]?.text ?? "";
	return new Text(theme.fg("toolTitle", label), 0, 0);
}

export default function piPaseoSubagentExtension(pi: ExtensionAPI): void {
	const trusted = (ctx: ExtensionContext): void => {
		if (!ctx.isProjectTrusted()) fail("untrusted_project", "the current project must be trusted before it can delegate work");
	};

	pi.registerTool({
		name: "subagent_run",
		label: "Subagent Run",
		description: "Start a delegated Paseo subagent in the caller's workspace and return its opaque id.",
		promptSnippet: "Start an asynchronous delegated subagent tracked by Paseo",
		promptGuidelines: [
			"The subagent is a full Paseo agent in the user's Subagents track; Paseo notifies this session when it finishes, errors, or needs permission, so do not poll for status.",
			"profile selects a Paseo agent profile (see subagent_presets); omit profile and provider to inherit this session's provider, model, and thinking level.",
			"Subagents share the caller's working directory. Use subagent_wait to block for results and subagent_stop to interrupt or archive one.",
		],
		parameters: Type.Object({
			prompt: Type.String({ minLength: 1, maxLength: MAX_PROMPT_BYTES, description: "Focused task for the delegated agent" }),
			role: Type.Optional(Type.Union([Type.Literal("scout"), Type.Literal("reviewer"), Type.Literal("worker")], { default: "scout" })),
			name: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_NAME_LENGTH, description: "Display name" })),
			profile: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Paseo agent profile name or id" })),
			provider: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Provider, or provider/model, overriding any profile" })),
			thinking: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Thinking level override, for example xhigh. Paseo ids are provider-specific; omit to use the profile's or the parent's level." })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: SubagentRunParams, signal, _onUpdate, ctx) {
			trusted(ctx);
			if (typeof params.prompt !== "string" || !params.prompt.trim()) fail("invalid_arguments", "prompt must not be empty");
			if (Buffer.byteLength(params.prompt, "utf8") > MAX_PROMPT_BYTES) fail("invalid_arguments", "prompt is too large");
			if (params.name !== undefined && (params.name.length > MAX_NAME_LENGTH || /[\r\n]/.test(params.name))) {
				fail("invalid_arguments", `name must be at most ${MAX_NAME_LENGTH} characters and contain no line breaks`);
			}
			const role = params.role ?? "scout";
			const parentId = parentAgentId();
			const target = await resolveSubagentTarget(params, parentId, signal);
			const children = await listChildren(parentId, true, signal);
			if (children.filter(isActive).length >= MAX_ACTIVE_SUBAGENTS) {
				fail("too_many_active_subagents", `${MAX_ACTIVE_SUBAGENTS} subagents are still active`);
			}
			const created = parseCreateAgent(await paseoMcp.callTool<unknown>("create_agent", {
				title: subagentTitle(role, params.name),
				provider: providerSelector(target.provider, target.model),
				labels: { [SESSION_LABEL_KEY]: sessionKey(ctx) },
				...(target.thinking ? { settings: { thinkingOptionId: target.thinking } } : {}),
				initialPrompt: buildInitialPrompt(params.prompt, role),
				notifyOnFinish: true,
			}, { callerAgentId: parentId, signal }));
			const summary: SubagentSummary = {
				subagent_id: created.agentId,
				name: params.name?.trim() || "task",
				role,
				status: "running",
				provider: providerSelector(target.provider, target.model),
			};
			return {
				content: [{ type: "text", text: created.agentId }],
				details: { subagent_id: created.agentId, summary, ...(created.guidance ? { guidance: created.guidance } : {}) },
			};
		},
		renderResult(result, _options, theme) { return renderSummary(result, theme); },
	});

	pi.registerTool({
		name: "subagent_list",
		label: "Subagent List",
		description: "List delegated Paseo subagents of this session, including state and attention flags.",
		parameters: Type.Object({
			include_finished: Type.Optional(Type.Boolean({ description: "Include archived subagents from the last 30 days" })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: SubagentListParams, signal, _onUpdate, ctx) {
			trusted(ctx);
			const children = await listChildren(parentAgentId(), params.include_finished === true, signal);
			return {
				content: [{ type: "text", text: children.length ? children.map(summaryText).join("\n") : "No subagents" }],
				details: { summaries: children },
			};
		},
		renderResult(result, _options, theme) { return renderSummary(result, theme); },
	});

	pi.registerTool({
		name: "subagent_read",
		label: "Subagent Read",
		description: "Read a delegated Paseo subagent's activity, optionally waiting for it to settle first.",
		parameters: Type.Object({
			subagent_id: Type.String({ minLength: 1, maxLength: 128 }),
			wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS })),
			output_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OUTPUT_LINES })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: SubagentReadParams, signal, _onUpdate, ctx) {
			trusted(ctx);
			const parentId = parentAgentId();
			const snapshot = await requireOwnedChild(params.subagent_id, parentId, signal);
			const waitMs = params.wait_ms ?? 0;
			let child: SubagentSummary | undefined;
			let timedOut = false;
			if (waitMs > 0) {
				const outcome = await pollChildren([snapshot.id], "all", waitMs, parentId, signal);
				child = outcome.children.get(snapshot.id);
				timedOut = outcome.timedOut;
			}
			const summary = child ?? summarizeSnapshot(snapshot);
			const activity = await readActivity(summary, params.output_lines ?? DEFAULT_OUTPUT_LINES, parentId, signal);
			return {
				content: [{ type: "text", text: `${summaryText(summary)}${waitNote(child, waitMs, timedOut)}\n\n${activity}` }],
				details: { summary, timed_out: timedOut, output: activity },
			};
		},
		renderResult(result, _options, theme) { return renderSummary(result, theme); },
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent Wait",
		description: "Wait for one or more Paseo subagents to settle, then return their state and activity.",
		parameters: Type.Object({
			subagent_ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: MAX_ACTIVE_SUBAGENTS }),
			mode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("any")], { default: "all" })),
			wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS, description: "Shared timeout for the wait operation" })),
			output_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OUTPUT_LINES })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: SubagentWaitParams, signal, _onUpdate, ctx) {
			trusted(ctx);
			const parentId = parentAgentId();
			const ids = [...new Set(params.subagent_ids)];
			if (ids.length !== params.subagent_ids.length) fail("invalid_arguments", "subagent_ids must not contain duplicates");
			const snapshots = new Map<string, AgentSnapshot>();
			for (const id of ids) snapshots.set(id, await requireOwnedChild(id, parentId, signal));
			const mode = params.mode ?? "all";
			const waitMs = params.wait_ms ?? DEFAULT_WAIT_MS;
			const byId = new Map((await listChildren(parentId, true, signal)).map((child) => [child.subagent_id, child]));
			const pending = ids.filter((id) => {
				const child = byId.get(id);
				return child ? !isSettled(child) : false;
			});
			// `any` returns immediately when a requested subagent already settled.
			const settledAlready = ids.some((id) => {
				const child = byId.get(id);
				return child ? isSettled(child) : false;
			});
			let timedOut = false;
			if (waitMs > 0 && pending.length > 0 && !(mode === "any" && settledAlready)) {
				const outcome = await pollChildren(pending, mode, waitMs, parentId, signal);
				for (const [id, child] of outcome.children) byId.set(id, child);
				timedOut = outcome.timedOut;
			}
			const outputLines = params.output_lines ?? DEFAULT_OUTPUT_LINES;
			const results = await Promise.all(ids.map(async (id) => {
				const child = byId.get(id) ?? summarizeSnapshot(snapshots.get(id) as AgentSnapshot);
				return { child, activity: await readActivity(child, outputLines, parentId, signal) };
			}));
			const text = results.map(({ child, activity }) => `${summaryText(child)}${waitNote(child, waitMs, timedOut)}\n\n${activity}`).join("\n\n---\n\n");
			return {
				content: [{ type: "text", text }],
				details: { mode, timed_out: timedOut, summaries: results.map(({ child }) => child) },
			};
		},
		renderResult(result, _options, theme) { return renderSummary(result, theme); },
	});

	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent Stop",
		description: "Interrupt a Paseo subagent, or terminate it by archiving it out of the parent's subagent track.",
		parameters: Type.Object({
			subagent_id: Type.String({ minLength: 1, maxLength: 128 }),
			mode: Type.Union([Type.Literal("interrupt"), Type.Literal("terminate")]),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: SubagentStopParams, signal, _onUpdate, ctx) {
			trusted(ctx);
			const parentId = parentAgentId();
			const snapshot = await requireOwnedChild(params.subagent_id, parentId, signal);
			const summary = summarizeSnapshot(snapshot);
			let detail: string;
			if (params.mode === "interrupt") {
				const result = await paseoMcp.callTool<{ success?: boolean }>("cancel_agent", { agentId: snapshot.id }, { callerAgentId: parentId, signal });
				detail = result.success === false ? "already idle" : "interrupt accepted";
			} else {
				await paseoMcp.callTool<{ success?: boolean }>("archive_agent", { agentId: snapshot.id }, { callerAgentId: parentId, signal });
				detail = "interrupted and archived out of the track";
			}
			return {
				content: [{ type: "text", text: `${summaryText(summary)} ${params.mode}: ${detail}` }],
				details: { summary, mode: params.mode },
			};
		},
		renderResult(result, _options, theme) { return renderSummary(result, theme); },
	});

	pi.registerTool({
		name: "subagent_presets",
		label: "Subagent Presets",
		description: "List the Paseo agent profiles available as subagent presets, including their notes.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			trusted(ctx);
			const profiles = parseProfiles(await paseoMcp.callTool<unknown>("list_profiles", {}, { callerAgentId: parentAgentId(), signal }));
			const text = profiles.length
				? profiles.map((profile) => [
					`${profile.name} (${profile.id})`,
					`  ${providerSelector(profile.provider, profile.model)}${profile.thinkingOptionId ? ` thinking=${profile.thinkingOptionId}` : ""}${profile.modeId ? ` mode=${profile.modeId}` : ""}`,
					...(profile.notes ? [`  notes: ${profile.notes}`] : []),
				].join("\n")).join("\n")
				: "No agent profiles are configured in Paseo.";
			return { content: [{ type: "text", text }], details: { profiles } };
		},
		renderResult(result, _options, theme) {
			const details = result.details as { profiles?: AgentProfile[] };
			return new Text(theme.fg("accent", `${details.profiles?.length ?? 0} profile(s)`), 0, 0);
		},
	});

	pi.registerCommand("subagent", {
		description: "List, read, or stop Paseo subagents",
		handler: async (args, ctx) => {
			const [action = "list", id] = args.trim().split(/\s+/);
			try {
				const parentId = parentAgentId();
				if (action === "list") {
					const children = await listChildren(parentId, true);
					ctx.ui.notify(children.length ? children.map(summaryText).join("\n") : "No subagents", "info");
					return;
				}
				if (action === "presets") {
					const profiles = parseProfiles(await paseoMcp.callTool<unknown>("list_profiles", {}, { callerAgentId: parentId }));
					ctx.ui.notify(profiles.length ? profiles.map((profile) => `${profile.name} -> ${providerSelector(profile.provider, profile.model)}`).join("\n") : "No agent profiles are configured in Paseo.", "info");
					return;
				}
				if (id && (action === "read" || action === "interrupt" || action === "terminate")) {
					const snapshot = await requireOwnedChild(id, parentId);
					if (action === "read") ctx.ui.notify(await readActivity({ subagent_id: snapshot.id, archived: snapshot.archived }, DEFAULT_OUTPUT_LINES, parentId), "info");
					else if (action === "interrupt") await paseoMcp.callTool<unknown>("cancel_agent", { agentId: id }, { callerAgentId: parentId });
					else await paseoMcp.callTool<unknown>("archive_agent", { agentId: id }, { callerAgentId: parentId });
					ctx.ui.notify(`${snapshot.id} ${action}`, "info");
					return;
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			ctx.ui.notify("Usage: /subagent [list|read|interrupt|terminate|presets] [subagent_id]", "warning");
		},
	});
}
