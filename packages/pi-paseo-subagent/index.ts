import { setTimeout as delay } from "node:timers/promises";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { paseoMcp } from "./mcp-client.ts";

const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_NAME_LENGTH = 40;
const MAX_ANSWER_LENGTH = 512;
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
const ARCHIVED_TRANSCRIPT_NOTE =
	"archived: this subagent was removed from the track, and reading it here would resume it on the daemon (re-adding it to the list and re-firing its finish notification). Inspect it in Paseo instead.";
const WAIT_SUMMARY_NOTE =
	"\n\nactivity omitted: Paseo's finish notification delivers each child's final message. Pass include_activity to fetch transcripts here.";

/** Overridable so tests do not have to wait out a real poll interval. */
export const subagentTiming = { pollIntervalMs: 500 };

export interface SubagentRunParams {
	prompt: string;
	name?: string;
	profile?: string;
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
	include_activity?: boolean;
	output_lines?: number;
}

export interface SubagentStopParams {
	subagent_id: string;
	mode: "interrupt" | "terminate";
}

export interface SubagentSendParams {
	subagent_id: string;
	prompt: string;
}

export interface SubagentPermitParams {
	subagent_id?: string;
	request_id?: string;
	decision?: "allow" | "deny";
	answer?: string;
	comment?: string;
	action_id?: string;
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
	/** Passed to Paseo as `settings.modeId`. Required for a cross-provider child: the daemon refuses to inherit a mode across providers. */
	mode?: string;
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

/** The daemon has no separate name field; the agent title is the display name. */
export function titleName(title: string | undefined): string {
	return title?.trim() || "task";
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
	return {
		subagent_id: snapshot.id,
		name: titleName(snapshot.title),
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
		children.push({
			subagent_id: id,
			name: titleName(asString(entry.title)),
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
	return `${child.subagent_id} [${child.status}] ${child.name}${attention}${archived}`;
}

export function waitNote(child: SubagentSummary | undefined, waitMs: number, timedOut: boolean): string {
	if (child?.attentionReason === "permission") {
		return "\n\nblocked on a permission request that never times out: list it with `subagent_permit` and answer allow or deny, approve it in Paseo, or run `paseo permit allow <id>`. Until it is answered the subagent stays running and keeps one concurrency slot.";
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

/**
 * Resolves an id, or a display name unique among this session's children, and enforces ownership.
 *
 * The id path costs a single `get_agent_status`; a name only falls back to `list_agents` when the
 * reference is not a known agent id.
 */
async function requireOwnedChild(reference: string, parentId: string, signal?: AbortSignal): Promise<AgentSnapshot> {
	const trimmed = reference.trim();
	const direct = await findOwnedSnapshot(trimmed, parentId, signal);
	if (direct === "not-owned") fail("subagent_not_found", `${trimmed} is not a subagent of this session`);
	if (direct) return direct;

	const children = await listChildren(parentId, true, signal);
	const matches = children.filter((child) => child.name.toLowerCase() === trimmed.toLowerCase());
	if (matches.length > 1) {
		fail("ambiguous_subagent_name", `"${trimmed}" matches ${matches.length} subagents: ${matches.map((child) => `${child.subagent_id} [${child.status}]`).join(", ")}`);
	}
	const match = matches[0];
	if (!match) fail("subagent_not_found", `${reference} does not exist on this Paseo daemon`);
	const named = await findOwnedSnapshot(match.subagent_id, parentId, signal);
	if (!named || named === "not-owned") fail("subagent_not_found", `${reference} is not a subagent of this session`);
	return named;
}

/** Returns the snapshot, `not-owned` when it belongs to another parent, or `null` when unknown. */
async function findOwnedSnapshot(agentId: string, parentId: string, signal?: AbortSignal): Promise<AgentSnapshot | "not-owned" | null> {
	try {
		const snapshot = await getAgentSnapshot(agentId, parentId, signal);
		return snapshot.parentAgentId === parentId ? snapshot : "not-owned";
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith("subagent_not_found")) return null;
		throw error;
	}
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

/** A saved Paseo profile selects the runtime; omitting `profile` inherits the calling agent. */
export async function resolveSubagentTarget(params: SubagentRunParams, parentId: string, signal?: AbortSignal): Promise<SubagentTarget> {
	const query = params.profile?.trim();
	if (query) {
		const profile = await findProfile(query, parentId, signal);
		const target = splitProviderModel(profile.model ? `${profile.provider}/${profile.model}` : profile.provider);
		return { ...withThinking(target, params.thinking ?? profile.thinkingOptionId), ...(profile.modeId ? { mode: profile.modeId } : {}) };
	}
	if (params.profile !== undefined) fail("invalid_arguments", "profile must not be blank; use a name or id from subagent_presets, or omit it to inherit");
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
	// Back off from the base interval instead of hammering `list_agents`: the finish notification
	// already delivers settled children, so this loop is only a fallback.
	let attempt = 0;
	for (;;) {
		children = new Map((await listChildren(parentId, true, signal)).filter((child) => wanted.has(child.subagent_id)).map((child) => [child.subagent_id, child]));
		const settled = ids.filter((id) => {
			const child = children.get(id);
			return !child || isSettled(child);
		});
		if (mode === "any" ? settled.length > 0 : settled.length === ids.length) return { children, timedOut: false };
		const remaining = deadline - Date.now();
		if (remaining <= 0) return { children, timedOut: true };
		await delay(Math.min(subagentTiming.pollIntervalMs * 2 ** Math.min(attempt++, 3), remaining));
		if (signal?.aborted) fail("cancelled", "the wait was cancelled");
	}
}

async function readActivity(child: { subagent_id: string; archived?: boolean }, outputLines: number, parentId: string, signal?: AbortSignal): Promise<string> {
	// `get_agent_activity` resumes an archived agent on the daemon, which clears `archivedAt` (ghost row in the
	// default list) and re-fires its finish notification. There is no no-wake variant of the tool.
	if (child.archived) return ARCHIVED_TRANSCRIPT_NOTE;
	return parseActivity(await paseoMcp.callTool<unknown>("get_agent_activity", { agentId: child.subagent_id, limit: outputLines }, { callerAgentId: parentId, signal }));
}

const SUBAGENT_INSTRUCTIONS = [
	"You are a delegated Paseo subagent.",
	"Work only on the assigned task in the current project.",
	"Do not create workspaces or start unrelated agents.",
	"Other agents, including your parent, work in this same directory. Do not revert, overwrite, or reformat edits outside your assigned scope.",
	"You have no interactive user. Do not ask questions; make reasonable assumptions and state them in the final report.",
	"Your final message is delivered verbatim to the parent agent and truncated to about 4000 characters, so lead with the conclusion, then what you did, then the file paths you changed, then remaining risks.",
	"Do not rely on the parent reading your transcript. Make the final report self-contained.",
].join("\n");

export function buildInitialPrompt(prompt: string): string {
	return `${SUBAGENT_INSTRUCTIONS}\n\nTask:\n${prompt}`;
}

/**
 * Builds the `respond_to_permission` payload.
 *
 * A `question` permission (Pi `ask_user`, select, or confirm dialogs) needs the answer inside
 * `updatedInput.answers` under the provider's headers — a bare `allow` is read as a cancellation.
 */
export function permitResponse(params: { decision: "allow" | "deny"; answer?: string; comment?: string; action_id?: string }): Record<string, unknown> {
	const action = params.action_id ? { selectedActionId: params.action_id } : {};
	if (params.decision === "deny") {
		return { behavior: "deny", ...action, ...(params.comment ? { message: params.comment } : {}) };
	}
	return {
		behavior: "allow",
		...action,
		...(params.answer ? { updatedInput: { answers: { [QUESTION_RESPONSE_HEADER]: params.answer, ...(params.comment ? { [QUESTION_COMMENT_HEADER]: params.comment } : {}) } } } : {}),
	};
}

const QUESTION_RESPONSE_HEADER = "Response";
const QUESTION_COMMENT_HEADER = "Comment";

function permissionQuestion(request: Record<string, unknown>): { question: string; options: string[] } | undefined {
	const questions = isRecord(request.input) ? request.input.questions : undefined;
	if (!Array.isArray(questions) || !questions.length) return undefined;
	const first = questions[0];
	if (!isRecord(first)) return undefined;
	const options = Array.isArray(first.options) ? first.options.filter(isRecord).map((option) => asString(option.label) ?? "").filter(Boolean) : [];
	return { question: asString(first.question) ?? "", options };
}

function formatPendingPermission(entry: Record<string, unknown>): string {
	const request = isRecord(entry.request) ? entry.request : {};
	const head = `${asString(entry.agentId) ?? "?"} request=${asString(request.id) ?? "?"} kind=${asString(request.kind) ?? "?"}`;
	const title = asString(request.title) ?? asString(request.name) ?? "";
	const description = asString(request.description);
	const question = permissionQuestion(request);
	const actions = Array.isArray(request.actions)
		? request.actions.filter(isRecord).map((action) => `${asString(action.id) ?? "?"}=${asString(action.label) ?? ""}(${asString(action.behavior) ?? ""})`).join(", ")
		: "";
	const details = [
		...(title ? [`  ${title}`] : []),
		...(description ? [`  ${description}`] : []),
		...(question?.question ? [`  question: ${question.question}${question.options.length ? `\n  options: ${question.options.join(" | ")}` : ""}`] : []),
		...(actions ? [`  actions: ${actions}`] : []),
		`  answer with: subagent_permit {subagent_id: "${asString(entry.agentId) ?? ""}", request_id: "${asString(request.id) ?? ""}", decision: "allow"${question ? `, answer: "<choice or free text>"` : ""}}`,
	];
	return [head, ...details].join("\n");
}

export function parsePendingPermissions(value: unknown, ownedIds: Set<string>): Record<string, unknown>[] {
	const permissions = isRecord(value) ? value.permissions : undefined;
	if (!Array.isArray(permissions)) fail("paseo_invalid_output", "list_pending_permissions returned no permissions");
	// The daemon returns pending requests across every agent on the host, so ownership is filtered here.
	return permissions.filter(isRecord).filter((entry) => ownedIds.has(asString(entry.agentId) ?? ""));
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
		description: "Start a delegated Paseo subagent in the caller's workspace and return its opaque id. Omit profile to inherit this session's model; subagent_presets lists the profile names and ids.",
		promptSnippet: "Start an asynchronous delegated subagent tracked by Paseo",
		promptGuidelines: [
			"The subagent is a full Paseo agent in the user's Subagents track; Paseo notifies this session when it finishes, errors, or needs permission, so do not poll for status.",
			"Delegate only bounded, self-contained sidecar tasks that can run while you keep working locally. Do the critical-path step your next action depends on yourself instead of waiting on a subagent.",
			"A subagent sees only the prompt you give it, never your conversation history. Make every prompt self-contained: goal, relevant file paths, constraints, acceptance criteria, and the files it may edit.",
			"Spawn several independent subagents in the same turn instead of one at a time, and give editing tasks disjoint file scopes. Subagents share this working directory and see each other's edits.",
			`At most ${MAX_ACTIVE_SUBAGENTS} subagents can be active at once. After delegating, do non-overlapping work; do not redo or re-delegate a subagent's task while it runs.`,
			"Use subagent_send to add follow-up work to an existing subagent instead of spawning a new one when the task depends on the child's accumulated context.",
			"For subagent_run, omit profile to use this session's provider, model, and thinking level. To switch, copy a profile value from subagent_presets; profile is the only runtime selector.",
			"For subagent_run, there is no role argument. State task intent such as read-only in the prompt itself; it is advisory and grants no permissions.",
		],
		parameters: Type.Object({
			prompt: Type.String({ minLength: 1, maxLength: MAX_PROMPT_BYTES, description: "Focused task for the delegated agent" }),
			name: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_NAME_LENGTH, description: "Display name" })),
			profile: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Saved Paseo agent profile name or id from subagent_presets. Omit to inherit this session's provider, model, and thinking level." })),
			thinking: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Thinking level override, for example xhigh. Paseo ids are provider-specific; omit to use the profile's or the parent's level." })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: SubagentRunParams, signal, _onUpdate, ctx) {
			trusted(ctx);
			if (typeof params.prompt !== "string" || !params.prompt.trim()) fail("invalid_arguments", "prompt must not be empty");
			if (Buffer.byteLength(params.prompt, "utf8") > MAX_PROMPT_BYTES) fail("invalid_arguments", "prompt is too large");
			if (params.name !== undefined && (params.name.length > MAX_NAME_LENGTH || /[\r\n]/.test(params.name))) {
				fail("invalid_arguments", `name must be at most ${MAX_NAME_LENGTH} characters and contain no line breaks`);
			}
			const parentId = parentAgentId();
			const target = await resolveSubagentTarget(params, parentId, signal);
			const children = await listChildren(parentId, true, signal);
			const active = children.filter(isActive);
			if (active.length >= MAX_ACTIVE_SUBAGENTS) {
				fail("too_many_active_subagents", `${MAX_ACTIVE_SUBAGENTS} subagents are still active:\n${active.map(summaryText).join("\n")}\nStop one with subagent_stop, or wait for it to settle.`);
			}
			const created = parseCreateAgent(await paseoMcp.callTool<unknown>("create_agent", {
				title: titleName(params.name),
				provider: providerSelector(target.provider, target.model),
				labels: { [SESSION_LABEL_KEY]: sessionKey(ctx) },
				...((target.thinking || target.mode)
					? { settings: { ...(target.thinking ? { thinkingOptionId: target.thinking } : {}), ...(target.mode ? { modeId: target.mode } : {}) } }
					: {}),
				initialPrompt: buildInitialPrompt(params.prompt),
				notifyOnFinish: true,
			}, { callerAgentId: parentId, signal }));
			const summary: SubagentSummary = {
				subagent_id: created.agentId,
				name: params.name?.trim() || "task",
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
		description: "Read a delegated Paseo subagent's activity, optionally waiting for it to settle first. An archived subagent returns a status line instead of its transcript.",
		parameters: Type.Object({
			subagent_id: Type.String({ minLength: 1, maxLength: 128, description: "Subagent id or display name" }),
			wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS, description: `Milliseconds to wait for the subagent to settle first. Defaults to 0, which returns the current state without waiting. Maximum ${MAX_WAIT_MS}.` })),
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
		description: "Wait for one or more Paseo subagents to settle, then return their state and attention flags. Settled content arrives through Paseo's finish notification, so transcripts are not fetched unless include_activity is set. A subagent blocked on a permission request settles immediately with a note.",
		parameters: Type.Object({
			subagent_ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: MAX_ACTIVE_SUBAGENTS }),
			mode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("any")], { default: "all" })),
			wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS, description: `Shared timeout in milliseconds, default ${DEFAULT_WAIT_MS}. 0 returns the current state without waiting.` })),
			include_activity: Type.Optional(Type.Boolean({ description: "Also fetch each subagent's curated activity. Omit to return state only: the finish notification already delivers the child's final message." })),
			output_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OUTPUT_LINES, description: "Activity entries per subagent when include_activity is set." })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: SubagentWaitParams, signal, _onUpdate, ctx) {
			trusted(ctx);
			const parentId = parentAgentId();
			const ids = [...new Set(params.subagent_ids)];
			if (ids.length !== params.subagent_ids.length) fail("invalid_arguments", "subagent_ids must not contain duplicates");
			const snapshots = new Map<string, AgentSnapshot>(await Promise.all(
				ids.map(async (id) => [id, await requireOwnedChild(id, parentId, signal)] as const),
			));
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
			const includeActivity = params.include_activity === true;
			const results = await Promise.all(ids.map(async (id) => {
				const child = byId.get(id) ?? summarizeSnapshot(snapshots.get(id) as AgentSnapshot);
				return {
					child,
					activity: includeActivity ? await readActivity(child, params.output_lines ?? DEFAULT_OUTPUT_LINES, parentId, signal) : undefined,
				};
			}));
			const blocks = results.map(({ child, activity }) => `${summaryText(child)}${waitNote(child, waitMs, timedOut)}${activity ? `\n\n${activity}` : ""}`).join("\n\n---\n\n");
			const text = includeActivity ? blocks : `${blocks}${WAIT_SUMMARY_NOTE}`;
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
			subagent_id: Type.String({ minLength: 1, maxLength: 128, description: "Subagent id or display name" }),
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
		name: "subagent_send",
		label: "Subagent Send",
		description: "Send a follow-up task to an existing subagent. The daemon steers or replaces the child's current run and the finish notification delivers the result, so do not poll. Sending to an archived subagent resumes it.",
		promptSnippet: "Send follow-up work to an existing subagent",
		promptGuidelines: [
			"Prefer subagent_send over a second subagent_run when the new task depends on the child's accumulated context.",
		],
		parameters: Type.Object({
			subagent_id: Type.String({ minLength: 1, maxLength: 128, description: "Subagent id or display name" }),
			prompt: Type.String({ minLength: 1, maxLength: MAX_PROMPT_BYTES, description: "Follow-up task for the subagent" }),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: SubagentSendParams, signal, _onUpdate, ctx) {
			trusted(ctx);
			const parentId = parentAgentId();
			if (typeof params.prompt !== "string" || !params.prompt.trim()) fail("invalid_arguments", "prompt must not be empty");
			if (Buffer.byteLength(params.prompt, "utf8") > MAX_PROMPT_BYTES) fail("invalid_arguments", "prompt is too large");
			const snapshot = await requireOwnedChild(params.subagent_id, parentId, signal);
			const result = await paseoMcp.callTool<{ success?: boolean; status?: string; guidance?: string }>(
				"send_agent_prompt",
				{ agentId: snapshot.id, prompt: params.prompt, background: true, notifyOnFinish: true },
				{ callerAgentId: parentId, signal },
			);
			const summary = summarizeSnapshot(snapshot);
			const detail = result.success === false ? "follow-up rejected" : `follow-up accepted, status=${result.status ?? "unknown"}`;
			const resumeNote = snapshot.archived ? " (the archived subagent is resumed by this send)" : "";
			return {
				content: [{ type: "text", text: `${summaryText(summary)} ${detail}${resumeNote}` }],
				details: { summary, status: result.status, ...(result.guidance ? { guidance: result.guidance } : {}) },
			};
		},
		renderResult(result, _options, theme) { return renderSummary(result, theme); },
	});

	pi.registerTool({
		name: "subagent_permit",
		label: "Subagent Permit",
		description: "List pending permission requests of this session's subagents, or answer one. Omit request_id to list. Answering requires subagent_id, request_id, and decision; a question request needs answer (allow) or comment (deny). Never auto-approves.",
		promptSnippet: "List or answer a subagent's pending permission request",
		promptGuidelines: [
			"A subagent blocked on approval shows attention=permission and cannot progress until someone answers. List its request with subagent_permit, then answer allow or deny explicitly; deny when the request exceeds the delegated task scope.",
		],
		parameters: Type.Object({
			subagent_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Subagent id or display name; required when answering" })),
			request_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Request id from the listing; omit to list" })),
			decision: Type.Optional(Type.Union([Type.Literal("allow"), Type.Literal("deny")], { description: "Required when answering" })),
			answer: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ANSWER_LENGTH, description: "Answer for a question request (allow): a listed option or free text" })),
			comment: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ANSWER_LENGTH, description: "Optional comment (allow) or reason (deny)" })),
			action_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "A listed action id when the request offers more than a plain allow/deny" })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params: SubagentPermitParams, signal, _onUpdate, ctx) {
			trusted(ctx);
			const parentId = parentAgentId();
			if (!params.request_id) {
				if (params.decision || params.answer || params.comment || params.action_id || params.subagent_id) {
					fail("invalid_arguments", "answering requires request_id; omit it and the other fields to list pending requests");
				}
				const owned = new Set((await listChildren(parentId, true, signal)).map((child) => child.subagent_id));
				const pending = parsePendingPermissions(
					await paseoMcp.callTool<unknown>("list_pending_permissions", {}, { callerAgentId: parentId, signal }),
					owned,
				);
				const text = pending.length
					? pending.map(formatPendingPermission).join("\n\n")
					: "No pending permission requests from this session's subagents";
				return { content: [{ type: "text", text }], details: { pending } };
			}
			if (!params.subagent_id || !params.decision) {
				fail("invalid_arguments", "answering a request requires subagent_id and decision");
			}
			const snapshot = await requireOwnedChild(params.subagent_id, parentId, signal);
			await paseoMcp.callTool<{ success?: boolean }>("respond_to_permission", {
				agentId: snapshot.id,
				requestId: params.request_id,
				response: permitResponse({ decision: params.decision, answer: params.answer, comment: params.comment, action_id: params.action_id }),
			}, { callerAgentId: parentId, signal });
			return {
				content: [{ type: "text", text: `${snapshot.id} request ${params.request_id}: ${params.decision}${params.answer ? ` (${params.answer})` : ""}` }],
				details: { subagent_id: snapshot.id, request_id: params.request_id, decision: params.decision },
			};
		},
		renderResult(result, _options, theme) { return renderSummary(result, theme); },
	});

	pi.registerTool({
		name: "subagent_presets",
		label: "Subagent Presets",
		description: "List Paseo agent profiles with ready-to-use profile values for subagent_run and selection notes.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			trusted(ctx);
			const profiles = parseProfiles(await paseoMcp.callTool<unknown>("list_profiles", {}, { callerAgentId: parentAgentId(), signal }));
			const text = profiles.length
				? profiles.map((profile) => [
					`${profile.name} (${profile.id})`,
					`  ${JSON.stringify({ profile: profile.id })}`,
					`  ${providerSelector(profile.provider, profile.model)}${profile.thinkingOptionId ? ` thinking=${profile.thinkingOptionId}` : ""}${profile.modeId ? ` mode=${profile.modeId}` : ""}`,
					...(profile.notes ? [`  notes: ${profile.notes}`] : []),
				].join("\n")).join("\n")
				: "No agent profiles are configured in Paseo. Omit profile to keep this session's model.";
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
					ctx.ui.notify(profiles.length ? profiles.map((profile) => `${profile.name} -> ${providerSelector(profile.provider, profile.model)} ${JSON.stringify({ profile: profile.id })}`).join("\n") : "No agent profiles are configured in Paseo.", "info");
					return;
				}
				if (action === "send" && id) {
					const prompt = args.trim().split(/\s+/).slice(2).join(" ").trim();
					if (!prompt) {
						ctx.ui.notify("Usage: /subagent send <subagent_id> <prompt...>", "warning");
						return;
					}
					const snapshot = await requireOwnedChild(id, parentId);
					await paseoMcp.callTool<unknown>("send_agent_prompt", { agentId: snapshot.id, prompt, background: true, notifyOnFinish: true }, { callerAgentId: parentId });
					ctx.ui.notify(`${snapshot.id} follow-up sent`, "info");
					return;
				}
				if (action === "permit") {
					const owned = new Set((await listChildren(parentId, true)).map((child) => child.subagent_id));
					const pending = parsePendingPermissions(await paseoMcp.callTool<unknown>("list_pending_permissions", {}, { callerAgentId: parentId }), owned);
					ctx.ui.notify(pending.length ? pending.map(formatPendingPermission).join("\n\n") : "No pending permission requests from this session's subagents", "info");
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
			ctx.ui.notify("Usage: /subagent [list|read|send <id> <prompt>|interrupt <id>|terminate <id>|permit|presets] [subagent_id]", "warning");
		},
	});
}
