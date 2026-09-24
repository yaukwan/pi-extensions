import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "typebox/value";

import piPaseoSubagentExtension, {
	buildInitialPrompt,
	parseChildren,
	parsePendingPermissions,
	parseProfiles,
	permitResponse,
	providerSelector,
	sessionKey,
	splitProviderModel,
	subagentTiming,
	titleName,
	waitNote,
} from "./index.ts";
import {
	buildMcpUrl,
	normalizeLoopbackHost,
	parseHostPort,
	parseRpcPayloads,
	paseoMcp,
	resolveMcpTarget,
} from "./mcp-client.ts";

const PARENT_ID = "55642197-7b36-48e0-8367-1332c8e9e98b";
const CHILD_ID = "1f751745-ffc5-4100-9448-d963a8528d09";
const OTHER_CHILD_ID = "59c0a0d3-cdb4-44eb-a0b7-6616164267ba";
const FOREIGN_ID = "deadbeef-0000-0000-0000-000000000000";
const DAEMON_URL = "http://127.0.0.1:6767/mcp/agents";

// --- fixtures ---------------------------------------------------------------

const PARENT_SNAPSHOT = {
	id: PARENT_ID,
	provider: "pi",
	model: "h/deepseek-flash",
	thinkingOptionId: "xhigh",
	effectiveThinkingOptionId: "xhigh",
	status: "running",
	title: "parent session",
	labels: {},
};

function childSnapshot(overrides: Record<string, unknown> = {}) {
	return {
		id: CHILD_ID,
		provider: "pi",
		model: "h/deepseek-flash",
		effectiveThinkingOptionId: "minimal",
		status: "idle",
		title: "auth-review",
		labels: { "paseo.parent-agent-id": PARENT_ID, "pi-paseo-subagent": "session-1" },
		requiresAttention: true,
		attentionReason: "finished",
		...overrides,
	};
}

function childRow(overrides: Record<string, unknown> = {}) {
	return {
		id: CHILD_ID,
		shortId: "1f75174",
		title: "auth-review",
		provider: "pi",
		model: "h/deepseek-flash",
		status: "idle",
		cwd: "/tmp/project",
		archivedAt: null,
		requiresAttention: true,
		attentionReason: "finished",
		labels: { "paseo.parent-agent-id": PARENT_ID, "pi-paseo-subagent": "session-1" },
		...overrides,
	};
}

/** Pi `ask_user` surfaces as a question permission whose answer lives in `updatedInput.answers`. */
function questionPermission(overrides: Record<string, unknown> = {}) {
	return {
		agentId: CHILD_ID,
		status: "running",
		request: {
			id: "perm-1",
			provider: "pi",
			name: "Pi ask_user",
			kind: "question",
			title: "Which database should the migration target?",
			input: {
				questions: [{
					question: "Which database should the migration target?",
					header: "Response",
					options: [{ label: "postgres" }, { label: "sqlite" }],
					multiSelect: false,
				}],
			},
			actions: [{ id: "act_allow", label: "Allow", behavior: "allow" }, { id: "act_deny", label: "Deny", behavior: "deny" }],
		},
		...overrides,
	};
}

const PROFILES = {
	profiles: [
		{ id: "agent_profile_fast", name: "Fast Flash", provider: "pi", model: "h/deepseek-flash", thinkingOptionId: "low" },
		{ id: "agent_profile_review", name: "Reviewer", provider: "pi", model: "nikoapi/gpt-5.6-sol", thinkingOptionId: "high", notes: "Use for independent review." },
	],
};

// --- fake daemon ------------------------------------------------------------

interface RecordedCall {
	name: string;
	args: Record<string, unknown>;
	url: string;
	callerAgentId: string | null;
	authorization: string | null;
}

interface FakeDaemon {
	calls: RecordedCall[];
	state: { children: Array<Record<string, unknown>>; activity: string; permissions: Array<Record<string, unknown>> };
	respond: (call: RecordedCall) => unknown;
}

function ok(payload: unknown) {
	return { payload: { jsonrpc: "2.0", id: 1, result: { content: [], structuredContent: payload } } };
}

function toolError(text: string) {
	return { payload: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], isError: true } } };
}

function makeDaemon(overrides: { respond?: (call: RecordedCall, daemon: FakeDaemon) => unknown } = {}): FakeDaemon {
	const daemon: FakeDaemon = {
		calls: [],
		state: {
			children: [
				childRow(),
				childRow({ id: OTHER_CHILD_ID, title: "parser audit", status: "running", requiresAttention: false, attentionReason: null }),
				childRow({ id: FOREIGN_ID, title: "someone else", labels: { "paseo.parent-agent-id": "another-parent" } }),
			],
			activity: "Showing all 2 activities\n\n[User] review the diff\ntwo real bugs found",
			permissions: [],
		},
		respond: () => undefined,
	};
	daemon.respond = (call) => {
		const override = overrides.respond?.(call, daemon);
		if (override !== undefined) return override;
		switch (call.name) {
			case "list_profiles":
				return ok(PROFILES);
			case "get_agent_status": {
				const agentId = call.args.agentId;
				if (agentId === PARENT_ID) return ok({ status: "running", snapshot: PARENT_SNAPSHOT });
				if (agentId === CHILD_ID) return ok({ status: "idle", snapshot: childSnapshot() });
				if (agentId === OTHER_CHILD_ID) return ok({ status: "running", snapshot: childSnapshot({ id: OTHER_CHILD_ID, title: "parser audit", status: "running", requiresAttention: false, attentionReason: undefined }) });
				return toolError(`Agent ${String(agentId)} not found`);
			}
			case "list_agents":
				return ok({ agents: daemon.state.children });
			case "get_agent_activity":
				return ok({ agentId: call.args.agentId, updateCount: 3, currentModeId: null, content: daemon.state.activity });
			case "create_agent":
				return ok({
					agentId: CHILD_ID,
					type: "pi",
					status: "running",
					cwd: "/tmp/project",
					workspaceId: "wks_1",
					currentModeId: null,
					availableModes: [],
					lastMessage: null,
					permission: null,
					guidance: "You will get notified when the created agent finishes.",
				});
			case "send_agent_prompt":
				return ok({ success: true, status: "running", lastMessage: null, permission: null, guidance: "You will get notified when the prompted agent finishes." });
			case "list_pending_permissions":
				return ok({ permissions: daemon.state.permissions });
			case "respond_to_permission":
				return ok({ success: true });
			case "cancel_agent":
			case "archive_agent":
				return ok({ success: true });
			default:
				return toolError(`unknown tool ${call.name}`);
		}
	};
	return daemon;
}

async function withFakeDaemon(
	daemon: FakeDaemon,
	run: (daemon: FakeDaemon) => Promise<void>,
	env: Record<string, string | undefined> = {},
): Promise<void> {
	const originalFetch = globalThis.fetch;
	const originalPoll = subagentTiming.pollIntervalMs;
	const previousEnv: Record<string, string | undefined> = {};
	const baseEnv: Record<string, string | undefined> = {
		PASEO_MCP_URL: DAEMON_URL,
		PASEO_AGENT_ID: PARENT_ID,
		PASEO_HOST: undefined,
		PASEO_HOME: undefined,
		PASEO_PASSWORD: undefined,
		...env,
	};
	for (const [key, value] of Object.entries(baseEnv)) {
		previousEnv[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	subagentTiming.pollIntervalMs = 5;
	globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
		const url = new URL(String(input));
		const body = JSON.parse(String(init.body ?? "{}")) as { params?: { name?: string; arguments?: Record<string, unknown> } };
		const call: RecordedCall = {
			name: body.params?.name ?? "unknown",
			args: body.params?.arguments ?? {},
			url: url.toString(),
			callerAgentId: url.searchParams.get("callerAgentId"),
			authorization: new Headers(init.headers).get("authorization"),
		};
		daemon.calls.push(call);
		const { payload } = daemon.respond(call) as { payload: unknown };
		return {
			ok: true,
			status: 200,
			text: async () => `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
		} as unknown as Response;
	}) as typeof fetch;
	try {
		await run(daemon);
	} finally {
		globalThis.fetch = originalFetch;
		subagentTiming.pollIntervalMs = originalPoll;
		for (const [key, value] of Object.entries(previousEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

interface RegisteredTool {
	name: string;
	execute?: (...args: unknown[]) => Promise<unknown>;
	parameters?: { properties?: Record<string, unknown> };
}

function registeredTools(): RegisteredTool[] {
	const tools: RegisteredTool[] = [];
	piPaseoSubagentExtension({
		registerTool: (tool: unknown) => tools.push(tool as RegisteredTool),
		registerCommand: () => undefined,
		on: () => undefined,
	} as never);
	return tools;
}

function tool(tools: RegisteredTool[], name: string): (...args: unknown[]) => Promise<unknown> {
	const execute = tools.find((entry) => entry.name === name)?.execute;
	if (!execute) throw new Error(`${name} was not registered`);
	return execute;
}

function fakeContext(overrides: Record<string, unknown> = {}): never {
	return {
		cwd: "/tmp/project",
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined },
		ui: { notify: () => undefined },
		...overrides,
	} as never;
}

function toolNames(calls: RecordedCall[]): string[] {
	return calls.map((call) => call.name);
}

// --- transport --------------------------------------------------------------

test("parses supported daemon host forms", () => {
	assert.deepEqual(parseHostPort("127.0.0.1"), { host: "127.0.0.1", port: 6767 });
	assert.deepEqual(parseHostPort("0.0.0.0:7000"), { host: "0.0.0.0", port: 7000 });
	assert.deepEqual(parseHostPort("tcp://mac-mini:6767"), { host: "mac-mini", port: 6767 });
	assert.deepEqual(parseHostPort("http://10.0.0.5:1234/mcp"), { host: "10.0.0.5", port: 1234 });
	assert.deepEqual(parseHostPort("ssh://me@build-box"), { host: "build-box", port: 6767 });
	assert.deepEqual(parseHostPort("[::1]:8000"), { host: "[::1]", port: 8000 });
	assert.equal(parseHostPort(""), null);
	assert.equal(parseHostPort("host:not-a-port"), null);
});

test("maps wildcard bind addresses to loopback", () => {
	assert.equal(normalizeLoopbackHost("0.0.0.0"), "127.0.0.1");
	assert.equal(normalizeLoopbackHost("::"), "127.0.0.1");
	assert.equal(normalizeLoopbackHost("[::1]"), "[::1]");
	assert.equal(normalizeLoopbackHost("10.0.0.5"), "10.0.0.5");
});

test("resolves the MCP endpoint from the environment, then the daemon files", async () => {
	assert.deepEqual(await resolveMcpTarget({ PASEO_MCP_URL: `${DAEMON_URL}?callerAgentId=x`, PASEO_PASSWORD: " pw " }), {
		url: `${DAEMON_URL}?callerAgentId=x`,
		password: "pw",
	});

	const home = join(tmpdir(), `pi-paseo-subagent-home-${process.pid}-${Date.now()}`);
	try {
		await mkdir(home, { recursive: true });
		await writeFile(join(home, "paseo.pid"), JSON.stringify({ listen: "0.0.0.0:7001", pid: 1 }));
		await writeFile(join(home, "config.json"), JSON.stringify({ daemon: { listen: "127.0.0.1:7002" } }));
		assert.deepEqual(await resolveMcpTarget({ PASEO_HOME: home }), { url: "http://127.0.0.1:7001/mcp/agents" });
		assert.deepEqual(await resolveMcpTarget({ PASEO_HOME: home, PASEO_HOST: "tcp://build:7003" }), { url: "http://build:7003/mcp/agents" });
		await rm(join(home, "paseo.pid"));
		assert.deepEqual(await resolveMcpTarget({ PASEO_HOME: home }), { url: "http://127.0.0.1:7002/mcp/agents" });
		await rm(join(home, "config.json"));
		assert.deepEqual(await resolveMcpTarget({ PASEO_HOME: home }), { url: "http://127.0.0.1:6767/mcp/agents" });
		await assert.rejects(() => resolveMcpTarget({ PASEO_HOME: home, PASEO_HOST: "not a host" }), /paseo_endpoint_invalid/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("appends the caller agent id without clobbering an explicit one", () => {
	assert.equal(buildMcpUrl({ url: DAEMON_URL }, PARENT_ID), `${DAEMON_URL}?callerAgentId=${PARENT_ID}`);
	assert.equal(buildMcpUrl({ url: `${DAEMON_URL}?callerAgentId=given` }, PARENT_ID), `${DAEMON_URL}?callerAgentId=given`);
	assert.equal(buildMcpUrl({ url: DAEMON_URL }), DAEMON_URL);
});

test("parses SSE frames and plain JSON bodies", () => {
	assert.deepEqual(parseRpcPayloads('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'), [{ jsonrpc: "2.0", id: 1, result: {} }]);
	assert.deepEqual(parseRpcPayloads('{"jsonrpc":"2.0","id":2,"result":{"a":1}}'), [{ jsonrpc: "2.0", id: 2, result: { a: 1 } }]);
	assert.deepEqual(parseRpcPayloads("not json"), []);
});

test("sends the daemon password and caller agent id", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		await paseoMcp.callTool("list_agents", { limit: 1 }, { callerAgentId: PARENT_ID });
		assert.equal(daemon.calls[0]?.authorization, "Bearer s3cret");
		assert.equal(daemon.calls[0]?.callerAgentId, PARENT_ID);
	}, { PASEO_PASSWORD: "s3cret" });
});

test("maps transport failures to the paseo error vocabulary", async () => {
	const originalFetch = globalThis.fetch;
	const previousUrl = process.env.PASEO_MCP_URL;
	process.env.PASEO_MCP_URL = DAEMON_URL;
	try {
		globalThis.fetch = (async () => { throw new Error("fetch failed", { cause: { code: "ECONNREFUSED" } }); }) as typeof fetch;
		await assert.rejects(() => paseoMcp.callTool("list_agents"), /paseo_unavailable: cannot reach the Paseo daemon .*ECONNREFUSED/);

		globalThis.fetch = (async () => ({ ok: false, status: 401, text: async () => "" }) as Response) as typeof fetch;
		await assert.rejects(() => paseoMcp.callTool("list_agents"), /paseo_auth_required/);

		globalThis.fetch = (async () => ({ ok: false, status: 500, text: async () => "" }) as Response) as typeof fetch;
		await assert.rejects(() => paseoMcp.callTool("list_agents"), /paseo_request_failed: HTTP 500/);

		globalThis.fetch = (async () => ({
			ok: true,
			status: 200,
			text: async () => 'event: message\ndata: {"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"invalid arguments"}}\n\n',
		}) as Response) as typeof fetch;
		await assert.rejects(() => paseoMcp.callTool("list_agents"), /paseo_tool_failed: list_agents: invalid arguments/);

		globalThis.fetch = (async () => ({
			ok: true,
			status: 200,
			text: async () => `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Agent x not found" }], isError: true } })}\n\n`,
		}) as Response) as typeof fetch;
		await assert.rejects(() => paseoMcp.callTool("get_agent_status", { agentId: "x" }), /paseo_tool_failed: get_agent_status: Agent x not found/);

		globalThis.fetch = (async () => ({
			ok: true,
			status: 200,
			text: async () => 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n',
		}) as Response) as typeof fetch;
		await assert.rejects(() => paseoMcp.callTool("list_agents"), /paseo_invalid_output: list_agents: the daemon returned no structured content/);
	} finally {
		globalThis.fetch = originalFetch;
		if (previousUrl === undefined) delete process.env.PASEO_MCP_URL;
		else process.env.PASEO_MCP_URL = previousUrl;
	}
});

// --- value helpers ----------------------------------------------------------

test("splits provider/model ids and rejects empty models", () => {
	assert.deepEqual(splitProviderModel("pi"), { provider: "pi" });
	assert.deepEqual(splitProviderModel("pi/nikoapi/gpt-5.6-sol"), { provider: "pi", model: "nikoapi/gpt-5.6-sol" });
	assert.throws(() => splitProviderModel("pi/"), /invalid_arguments/);
	assert.throws(() => splitProviderModel("/h/deepseek-flash"), /invalid_arguments: provider "\/h\/deepseek-flash" has an empty provider/);
	assert.throws(() => splitProviderModel("/"), /invalid_arguments/);
	assert.throws(() => splitProviderModel("   "), /invalid_arguments: provider must not be empty/);
	assert.equal(providerSelector("pi", "h/deepseek-flash"), "pi/h/deepseek-flash");
});

test("treats the agent title as the subagent name", () => {
	assert.equal(titleName("hand-written agent"), "hand-written agent");
	assert.equal(titleName("  padded name  "), "padded name");
	assert.equal(titleName(""), "task");
	assert.equal(titleName(undefined), "task");
});

test("derives a stable session key", () => {
	assert.equal(sessionKey(fakeContext()), "session-1");
	assert.equal(sessionKey(fakeContext({ sessionManager: { getSessionId: () => undefined, getSessionFile: () => "/tmp/sessions/a.jsonl" } })), "-tmp-sessions-a.jsonl");
});

test("frames the child prompt with delegation instructions instead of a role", () => {
	const prompt = buildInitialPrompt("Read-only: inspect the parser");
	assert.ok(prompt.includes("You are a delegated Paseo subagent."));
	assert.ok(prompt.includes("Task:\nRead-only: inspect the parser"));
	assert.ok(!prompt.includes("Role:"));
	// Shared workspace, no interactive user, and the parent-visible final message contract.
	assert.match(prompt, /Do not revert, overwrite, or reformat edits outside your assigned scope\./);
	assert.match(prompt, /Do not ask questions; make reasonable assumptions/);
	assert.match(prompt, /truncated to about 4000 characters/);
	assert.match(prompt, /the file paths you changed/);
});

test("notes permission blocks, timeouts, and idle waits", () => {
	const blocked = waitNote({ subagent_id: "a", name: "x", status: "running", provider: "pi", attentionReason: "permission" }, 1000, false);
	assert.match(blocked, /subagent_permit/);
	assert.match(blocked, /paseo permit allow/);
	assert.match(blocked, /keeps one concurrency slot/);
	assert.match(waitNote({ subagent_id: "a", name: "x", status: "running", provider: "pi" }, 1000, true), /still running after 1000ms/);
	assert.equal(waitNote({ subagent_id: "a", name: "x", status: "idle", provider: "pi" }, 1000, false), "");
});

test("answers question permissions through updatedInput.answers", () => {
	assert.deepEqual(permitResponse({ decision: "allow", answer: "postgres" }), { behavior: "allow", updatedInput: { answers: { Response: "postgres" } } });
	assert.deepEqual(permitResponse({ decision: "allow", answer: "postgres", comment: "already provisioned" }), {
		behavior: "allow",
		updatedInput: { answers: { Response: "postgres", Comment: "already provisioned" } },
	});
	// A bare allow stays a plain tool approval; it reads as a cancellation for question requests.
	assert.deepEqual(permitResponse({ decision: "allow", action_id: "act_allow" }), { behavior: "allow", selectedActionId: "act_allow" });
	assert.deepEqual(permitResponse({ decision: "deny", comment: "out of scope" }), { behavior: "deny", message: "out of scope" });
});

test("keeps only this session's pending permission requests", () => {
	const owned = new Set([CHILD_ID]);
	const rows = parsePendingPermissions(
		{ permissions: [questionPermission(), questionPermission({ agentId: FOREIGN_ID })] },
		owned,
	);
	assert.equal(rows.length, 1);
	assert.equal((rows[0] as Record<string, unknown>).agentId, CHILD_ID);
	assert.throws(() => parsePendingPermissions({}, owned), /paseo_invalid_output/);
});

test("maps paseo profiles and child rows", () => {
	const profiles = parseProfiles(PROFILES);
	assert.equal(profiles.length, 2);
	assert.deepEqual(profiles[1], { id: "agent_profile_review", name: "Reviewer", provider: "pi", model: "nikoapi/gpt-5.6-sol", thinkingOptionId: "high", notes: "Use for independent review." });
	assert.throws(() => parseProfiles({}), /paseo_invalid_output/);

	const children = parseChildren({ agents: [...makeDaemon().state.children] }, PARENT_ID);
	assert.equal(children.length, 2);
	assert.deepEqual(children[0], {
		subagent_id: CHILD_ID,
		name: "auth-review",
		status: "idle",
		provider: "pi/h/deepseek-flash",
		model: "h/deepseek-flash",
		requiresAttention: true,
		attentionReason: "finished",
	});
	assert.throws(() => parseChildren({}, PARENT_ID), /paseo_invalid_output/);
});

// --- tools ------------------------------------------------------------------

test("registers the eight subagent tools", () => {
	const tools = registeredTools();
	assert.deepEqual(tools.map((entry) => entry.name), [
		"subagent_run",
		"subagent_list",
		"subagent_read",
		"subagent_wait",
		"subagent_stop",
		"subagent_send",
		"subagent_permit",
		"subagent_presets",
	]);
	const runParams = tools.find((entry) => entry.name === "subagent_run")?.parameters?.properties;
	assert.ok(runParams && "profile" in runParams && "thinking" in runParams);
	assert.ok(runParams && !("role" in runParams) && !("cwd" in runParams) && !("model_preset" in runParams));
	const runTool = tools.find((entry) => entry.name === "subagent_run");
	assert.ok(runParams && !("target" in runParams) && !("provider" in runParams));
	assert.ok(Check(runTool!.parameters!, { prompt: "task" }));
	assert.ok(Check(runTool!.parameters!, { prompt: "task", profile: "Reviewer" }));
	for (const legacy of [{ target: "inherit" }, { provider: "openai" }, { role: "scout" }, { profile: "Reviewer", provider: "pi" }]) {
		assert.equal(Check(runTool!.parameters!, { prompt: "task", ...legacy }), false);
	}

	// The delegation methodology reaches the system prompt, and wait transcripts stay opt-in.
	const runGuidelines = (runTool as unknown as { promptGuidelines?: string[] }).promptGuidelines ?? [];
	assert.ok(runGuidelines.some((guideline) => guideline.includes("disjoint file scopes")));
	assert.ok(runGuidelines.some((guideline) => guideline.includes("never your conversation history")));
	assert.ok(runGuidelines.some((guideline) => guideline.includes(`At most ${8} subagents can be active at once`)));
	const waitTool = tools.find((entry) => entry.name === "subagent_wait");
	assert.ok(waitTool?.parameters?.properties && "include_activity" in waitTool.parameters.properties);
	const permitTool = tools.find((entry) => entry.name === "subagent_permit");
	assert.ok(permitTool?.parameters?.properties && "answer" in permitTool.parameters.properties);
	assert.equal(Check(permitTool!.parameters!, { subagent_id: "x", request_id: "r", decision: "allow", answer: "postgres" }), true);
	assert.equal(Check(permitTool!.parameters!, { subagent_id: "x", request_id: "r", decision: "maybe" }), false);
});

test("inherits provider, model, and thinking from the calling agent", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		const result = await tool(registeredTools(), "subagent_run")("call", { prompt: "review the diff", name: "diff pass" }, undefined, undefined, fakeContext()) as {
			content: Array<{ text: string }>;
			details: { subagent_id: string; guidance?: string };
		};
		assert.equal(result.content[0]?.text, CHILD_ID);
		assert.equal(result.details.subagent_id, CHILD_ID);
		assert.match(result.details.guidance ?? "", /notified/);
		assert.deepEqual(toolNames(daemon.calls).slice(0, 3), ["get_agent_status", "list_agents", "create_agent"]);
		const created = daemon.calls[2];
		assert.deepEqual(created?.args, {
			title: "diff pass",
			provider: "pi/h/deepseek-flash",
			labels: { "pi-paseo-subagent": "session-1" },
			settings: { thinkingOptionId: "xhigh" },
			initialPrompt: buildInitialPrompt("review the diff"),
			notifyOnFinish: true,
		});
		assert.equal(created?.callerAgentId, PARENT_ID);
	});
});

test("omitting profile keeps the parent model and allows a thinking override", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		await tool(registeredTools(), "subagent_run")("call", { prompt: "task", name: "inherit check", thinking: "high" }, undefined, undefined, fakeContext());
		assert.deepEqual(toolNames(daemon.calls), ["get_agent_status", "list_agents", "create_agent"]);
		assert.equal(daemon.calls[2]?.args.provider, "pi/h/deepseek-flash");
		assert.deepEqual(daemon.calls[2]?.args.settings, { thinkingOptionId: "high" });
	});
});

test("uses a profile by name or id without inspecting the parent", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		const run = tool(registeredTools(), "subagent_run");
		await run("call", { prompt: "task", profile: "reviewer" }, undefined, undefined, fakeContext());
		assert.deepEqual(toolNames(daemon.calls), ["list_profiles", "list_agents", "create_agent"]);
		assert.equal(daemon.calls[2]?.args.provider, "pi/nikoapi/gpt-5.6-sol");
		assert.deepEqual(daemon.calls[2]?.args.settings, { thinkingOptionId: "high" });
		await run("call", { prompt: "task", profile: "agent_profile_review", thinking: "low" }, undefined, undefined, fakeContext());
		assert.equal(daemon.calls[5]?.args.provider, "pi/nikoapi/gpt-5.6-sol");
		assert.deepEqual(daemon.calls[5]?.args.settings, { thinkingOptionId: "low" });
	});
});

test("lets an explicit thinking override win over the profile level", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		const run = tool(registeredTools(), "subagent_run");
		await run("call", { prompt: "task", profile: "Fast Flash", thinking: "low" }, undefined, undefined, fakeContext());
		assert.deepEqual(toolNames(daemon.calls), ["list_profiles", "list_agents", "create_agent"]);
		assert.equal(daemon.calls[2]?.args.provider, "pi/h/deepseek-flash");
		assert.deepEqual(daemon.calls[2]?.args.settings, { thinkingOptionId: "low" });
		await run("call", { prompt: "task", profile: "Fast Flash" }, undefined, undefined, fakeContext());
		assert.deepEqual(daemon.calls[5]?.args.settings, { thinkingOptionId: "low" });
	});
});

test("keeps the profile's own thinking level and provider without an override", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		await tool(registeredTools(), "subagent_run")("call", { prompt: "task", profile: "Reviewer" }, undefined, undefined, fakeContext());
		assert.equal(daemon.calls[2]?.args.provider, "pi/nikoapi/gpt-5.6-sol");
		assert.deepEqual(daemon.calls[2]?.args.settings, { thinkingOptionId: "high" });
	});
});

test("rejects malformed profiles locally and never falls back for unknown ones", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		const run = tool(registeredTools(), "subagent_run");
		for (const profile of ["", " ", "   "]) {
			await assert.rejects(() => run("call", { prompt: "task", profile }, undefined, undefined, fakeContext()), /invalid_arguments: profile must not be blank/);
		}
		assert.deepEqual(daemon.calls, []);
		for (const profile of ["scout", "default", "openai", "inherit", "provider:codex"]) {
			await assert.rejects(() => run("call", { prompt: "task", profile }, undefined, undefined, fakeContext()), /profile_not_found/);
		}
		assert.deepEqual(toolNames(daemon.calls).filter((name) => name !== "list_profiles"), []);
	});
});

test("caps concurrently active subagents and names them", async () => {
	const daemon = makeDaemon();
	daemon.state.children = Array.from({ length: 8 }, (_, index) => childRow({ id: `child-${index}`, status: "running", requiresAttention: false, attentionReason: null }));
	await withFakeDaemon(daemon, async () => {
		await assert.rejects(
			() => tool(registeredTools(), "subagent_run")("call", { prompt: "task" }, undefined, undefined, fakeContext()),
			(error: Error & { message: string }) => {
				assert.match(error.message, /too_many_active_subagents: 8 subagents are still active/);
				assert.match(error.message, /child-0 \[running\]/);
				assert.match(error.message, /child-7 \[running\]/);
				assert.match(error.message, /Stop one with subagent_stop/);
				return true;
			},
		);
	});
});

test("forwards a profile's modeId so cross-provider children can start", async () => {
	const daemon = makeDaemon({
		respond: (call) => (call.name === "list_profiles"
			? ok({ profiles: [{ id: "agent_profile_codex", name: "Codex Full Access", provider: "codex", thinkingOptionId: "medium", modeId: "full-access" }] })
			: undefined),
	});
	await withFakeDaemon(daemon, async () => {
		await tool(registeredTools(), "subagent_run")("call", { prompt: "task", profile: "Codex Full Access" }, undefined, undefined, fakeContext());
		const created = daemon.calls.find((call) => call.name === "create_agent");
		assert.deepEqual(created?.args.settings, { thinkingOptionId: "medium", modeId: "full-access" });
	});
});

test("refuses to delegate from an untrusted project or with an empty prompt", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		const run = tool(registeredTools(), "subagent_run");
		await assert.rejects(() => run("call", { prompt: "task" }, undefined, undefined, fakeContext({ isProjectTrusted: () => false })), /untrusted_project/);
		await assert.rejects(() => run("call", { prompt: "   " }, undefined, undefined, fakeContext()), /invalid_arguments: prompt must not be empty/);
		await assert.rejects(() => run("call", { prompt: "task", name: "bad\nname" }, undefined, undefined, fakeContext()), /invalid_arguments: name must be at most/);
	});
});

test("refuses to delegate outside a paseo agent session", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		await assert.rejects(
			() => tool(registeredTools(), "subagent_run")("call", { prompt: "task" }, undefined, undefined, fakeContext()),
			/paseo_agent_context_missing/,
		);
	}, { PASEO_AGENT_ID: undefined });
});

test("lists only this session's children, with attention flags", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		const result = await tool(registeredTools(), "subagent_list")("call", {}, undefined, undefined, fakeContext()) as {
			content: Array<{ text: string }>;
			details: { summaries: Array<{ subagent_id: string }> };
		};
		assert.deepEqual(result.details.summaries.map((entry) => entry.subagent_id), [CHILD_ID, OTHER_CHILD_ID]);
		assert.match(result.content[0]?.text ?? "", new RegExp(`${CHILD_ID} \\[idle\\] auth-review attention=finished`));
		assert.equal(daemon.calls[0]?.args.includeArchived, false);
		assert.equal(daemon.calls[0]?.args.sinceHours, 720);

		await tool(registeredTools(), "subagent_list")("call", { include_finished: true }, undefined, undefined, fakeContext());
		assert.equal(daemon.calls[1]?.args.includeArchived, true);
	});
});

test("reads a child's activity and refuses agents it does not own", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		const read = tool(registeredTools(), "subagent_read");
		const result = await read("call", { subagent_id: CHILD_ID, output_lines: 20 }, undefined, undefined, fakeContext()) as { content: Array<{ text: string }> };
		assert.match(result.content[0]?.text ?? "", /two real bugs found/);
		assert.deepEqual(daemon.calls.map((call) => call.name), ["get_agent_status", "get_agent_activity"]);
		assert.deepEqual(daemon.calls[1]?.args, { agentId: CHILD_ID, limit: 20 });

		await assert.rejects(() => read("call", { subagent_id: "nope" }, undefined, undefined, fakeContext()), /subagent_not_found: nope does not exist/);
	});
});

test("does not resume an archived child when reading it", async () => {
	const ARCHIVED_AT = "2026-09-13T04:13:12.000Z";
	const daemon = makeDaemon({
		respond: (call) => (call.name === "get_agent_status" && call.args.agentId === CHILD_ID
			? ok({ status: "closed", snapshot: childSnapshot({ status: "closed", archivedAt: ARCHIVED_AT }) })
			: undefined),
	});
	await withFakeDaemon(daemon, async () => {
		const result = await tool(registeredTools(), "subagent_read")("call", { subagent_id: CHILD_ID }, undefined, undefined, fakeContext()) as {
			content: Array<{ text: string }>;
			details: { summary: { archived?: boolean } };
		};
		// `get_agent_activity` would resume the agent on the daemon and clear its `archivedAt`.
		assert.deepEqual(daemon.calls.map((call) => call.name), ["get_agent_status"]);
		assert.equal(result.details.summary.archived, true);
		assert.match(result.content[0]?.text ?? "", new RegExp(`${CHILD_ID} \\[closed\\] auth-review attention=finished archived`));
		assert.match(result.content[0]?.text ?? "", /archived: this subagent was removed from the track/);
	});
});

test("refuses a non-owned agent even though it exists", async () => {
	const daemon = makeDaemon();
	daemon.respond = (call) => {
		if (call.name === "get_agent_status") {
			return ok({ status: "idle", snapshot: childSnapshot({ id: FOREIGN_ID, labels: { "paseo.parent-agent-id": "another-parent" } }) });
		}
		return ok({});
	};
	await withFakeDaemon(daemon, async () => {
		await assert.rejects(() => tool(registeredTools(), "subagent_read")("call", { subagent_id: FOREIGN_ID }, undefined, undefined, fakeContext()), /subagent_not_found: .* is not a subagent/);
	});
});

test("addresses a child by display name when it is unique", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		const result = await tool(registeredTools(), "subagent_read")("call", { subagent_id: "auth-review" }, undefined, undefined, fakeContext()) as { content: Array<{ text: string }> };
		assert.match(result.content[0]?.text ?? "", /two real bugs found/);
		// Failed id lookup, name scan, ownership check, then the read.
		assert.deepEqual(toolNames(daemon.calls), ["get_agent_status", "list_agents", "get_agent_status", "get_agent_activity"]);
	});
});

test("refuses an ambiguous display name and lists the candidates", async () => {
	const daemon = makeDaemon();
	daemon.state.children = [
		childRow({ id: CHILD_ID, title: "task", status: "running" }),
		childRow({ id: OTHER_CHILD_ID, title: "task", status: "running" }),
	];
	await withFakeDaemon(daemon, async () => {
		await assert.rejects(
			() => tool(registeredTools(), "subagent_read")("call", { subagent_id: "task" }, undefined, undefined, fakeContext()),
			(error: Error) => {
				assert.match(error.message, /ambiguous_subagent_name: "task" matches 2 subagents/);
				assert.ok(error.message.includes(CHILD_ID) && error.message.includes(OTHER_CHILD_ID));
				return true;
			},
		);
	});
});

test("sends a follow-up task to an existing child", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		const send = tool(registeredTools(), "subagent_send");
		const result = await send("call", { subagent_id: CHILD_ID, prompt: "now check the parser" }, undefined, undefined, fakeContext()) as {
			content: Array<{ text: string }>;
			details: { status?: string; guidance?: string };
		};
		assert.match(result.content[0]?.text ?? "", /follow-up accepted, status=running/);
		assert.match(result.details.guidance ?? "", /notified/);
		assert.deepEqual(daemon.calls[1]?.args, { agentId: CHILD_ID, prompt: "now check the parser", background: true, notifyOnFinish: true });
		await assert.rejects(() => send("call", { subagent_id: CHILD_ID, prompt: "   " }, undefined, undefined, fakeContext()), /invalid_arguments: prompt must not be empty/);
	});
});

test("notes that sending to an archived child resumes it", async () => {
	const daemon = makeDaemon({
		respond: (call) => (call.name === "get_agent_status" && call.args.agentId === CHILD_ID
			? ok({ status: "closed", snapshot: childSnapshot({ status: "closed", archivedAt: "2026-09-13T04:13:12.000Z" }) })
			: undefined),
	});
	await withFakeDaemon(daemon, async () => {
		const result = await tool(registeredTools(), "subagent_send")("call", { subagent_id: CHILD_ID, prompt: "resume work" }, undefined, undefined, fakeContext()) as { content: Array<{ text: string }> };
		assert.match(result.content[0]?.text ?? "", /the archived subagent is resumed by this send/);
	});
});

test("refuses to steer an agent it does not own", async () => {
	const daemon = makeDaemon({
		respond: (call) => (call.name === "get_agent_status"
			? ok({ status: "idle", snapshot: childSnapshot({ id: FOREIGN_ID, labels: { "paseo.parent-agent-id": "another-parent" } }) })
			: undefined),
	});
	await withFakeDaemon(daemon, async () => {
		await assert.rejects(
			() => tool(registeredTools(), "subagent_send")("call", { subagent_id: FOREIGN_ID, prompt: "steal" }, undefined, undefined, fakeContext()),
			/subagent_not_found: .* is not a subagent/,
		);
		assert.deepEqual(daemon.calls.filter((call) => call.name === "send_agent_prompt"), []);
	});
});

test("lists only the pending permissions of owned children", async () => {
	const daemon = makeDaemon();
	daemon.state.permissions = [questionPermission(), questionPermission({ agentId: FOREIGN_ID })];
	await withFakeDaemon(daemon, async () => {
		const result = await tool(registeredTools(), "subagent_permit")("call", {}, undefined, undefined, fakeContext()) as {
			content: Array<{ text: string }>;
			details: { pending: unknown[] };
		};
		assert.equal(result.details.pending.length, 1);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /request=perm-1 kind=question/);
		assert.match(text, /options: postgres \| sqlite/);
		assert.match(text, /actions: act_allow=Allow\(allow\), act_deny=Deny\(deny\)/);
		assert.ok(!text.includes(FOREIGN_ID));
	});
});

test("answers a question permission and a plain approval", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		const permit = tool(registeredTools(), "subagent_permit");
		const allowed = await permit("call", { subagent_id: CHILD_ID, request_id: "perm-1", decision: "allow", answer: "postgres" }, undefined, undefined, fakeContext()) as { content: Array<{ text: string }> };
		assert.match(allowed.content[0]?.text ?? "", /request perm-1: allow \(postgres\)/);
		assert.deepEqual(daemon.calls[1]?.args, {
			agentId: CHILD_ID,
			requestId: "perm-1",
			response: { behavior: "allow", updatedInput: { answers: { Response: "postgres" } } },
		});

		await permit("call", { subagent_id: CHILD_ID, request_id: "perm-1", decision: "deny", comment: "out of scope" }, undefined, undefined, fakeContext());
		assert.deepEqual(daemon.calls[3]?.args, { agentId: CHILD_ID, requestId: "perm-1", response: { behavior: "deny", message: "out of scope" } });

		await assert.rejects(() => permit("call", { decision: "allow" }, undefined, undefined, fakeContext()), /invalid_arguments: answering requires request_id/);
		await assert.rejects(() => permit("call", { subagent_id: CHILD_ID, request_id: "perm-1" }, undefined, undefined, fakeContext()), /invalid_arguments: answering a request requires subagent_id and decision/);
	});
});

test("waits for every child and reports their transcripts when asked", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		const result = await tool(registeredTools(), "subagent_wait")("call", { subagent_ids: [CHILD_ID, OTHER_CHILD_ID], wait_ms: 200, include_activity: true }, undefined, undefined, fakeContext()) as {
			content: Array<{ text: string }>;
			details: { timed_out: boolean; summaries: unknown[] };
		};
		assert.equal(result.details.timed_out, true);
		assert.equal(result.details.summaries.length, 2);
		assert.match(result.content[0]?.text ?? "", /still running after 200ms/);
		assert.match(result.content[0]?.text ?? "", /two real bugs found/);
		assert.equal(daemon.calls.filter((call) => call.name === "list_agents").length > 1, true);
	});
});

test("waits return state only unless transcripts are requested", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		const result = await tool(registeredTools(), "subagent_wait")("call", { subagent_ids: [CHILD_ID, OTHER_CHILD_ID], wait_ms: 120 }, undefined, undefined, fakeContext()) as { content: Array<{ text: string }> };
		// The finish notification already delivers each child's final message, so no transcript is fetched.
		assert.deepEqual(daemon.calls.filter((call) => call.name === "get_agent_activity"), []);
		assert.match(result.content[0]?.text ?? "", /activity omitted: Paseo's finish notification delivers/);
		assert.match(result.content[0]?.text ?? "", new RegExp(`${CHILD_ID} \\[idle\\] auth-review attention=finished`));

		// The fallback poll backs off instead of hammering list_agents at a fixed rate.
		const polls = daemon.calls.filter((call) => call.name === "list_agents").length;
		assert.ok(polls <= 8, `expected backoff, saw ${polls} polls`);
	});
});

test("reads no transcript for an archived child during a wait", async () => {
	const daemon = makeDaemon();
	daemon.state.children = [
		childRow({ status: "closed", archivedAt: "2026-09-13T04:13:12.000Z" }),
		childRow({ id: OTHER_CHILD_ID, title: "parser audit", status: "running", requiresAttention: false, attentionReason: null }),
	];
	await withFakeDaemon(daemon, async () => {
		const result = await tool(registeredTools(), "subagent_wait")("call", { subagent_ids: [CHILD_ID, OTHER_CHILD_ID], wait_ms: 200, include_activity: true }, undefined, undefined, fakeContext()) as { content: Array<{ text: string }> };
		// The archived child is skipped, so `get_agent_activity` only reaches the running one.
		assert.deepEqual(daemon.calls.filter((call) => call.name === "get_agent_activity").map((call) => call.args.agentId), [OTHER_CHILD_ID]);
		assert.match(result.content[0]?.text ?? "", /archived: this subagent was removed from the track/);
		assert.match(result.content[0]?.text ?? "", /two real bugs found/);
	});
});

test("returns as soon as any child settles in any mode", async () => {
	const daemon = makeDaemon();
	const runningChild = childRow({ id: OTHER_CHILD_ID, title: "parser audit", status: "running", requiresAttention: false, attentionReason: null });
	daemon.state.children = [
		childRow({ id: CHILD_ID, status: "running", requiresAttention: false, attentionReason: null }),
		runningChild,
	];
	await withFakeDaemon(daemon, async () => {
		const wait = tool(registeredTools(), "subagent_wait");
		await assert.rejects(() => wait("call", { subagent_ids: [CHILD_ID, CHILD_ID], wait_ms: 100 }, undefined, undefined, fakeContext()), /invalid_arguments: subagent_ids must not contain duplicates/);

		// The second child is still running, but `any` should not wait for the first one to settle twice.
		daemon.state.children[1] = childRow({ id: OTHER_CHILD_ID, title: "parser audit", status: "idle", requiresAttention: false, attentionReason: null });
		const settled = await wait("call", { subagent_ids: [CHILD_ID, OTHER_CHILD_ID], mode: "any", wait_ms: 1_000 }, undefined, undefined, fakeContext()) as {
			details: { timed_out: boolean };
		};
		assert.equal(settled.details.timed_out, false);

		daemon.state.children[1] = runningChild;
		const timedOut = await wait("call", { subagent_ids: [CHILD_ID, OTHER_CHILD_ID], mode: "any", wait_ms: 60 }, undefined, undefined, fakeContext()) as {
			details: { timed_out: boolean };
		};
		assert.equal(timedOut.details.timed_out, true);
	});
});

test("interrupts and archives a child through the lifecycle tools", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		const stop = tool(registeredTools(), "subagent_stop");
		const interrupted = await stop("call", { subagent_id: CHILD_ID, mode: "interrupt" }, undefined, undefined, fakeContext()) as { content: Array<{ text: string }> };
		assert.match(interrupted.content[0]?.text ?? "", /interrupt accepted/);
		assert.deepEqual(daemon.calls[1]?.args, { agentId: CHILD_ID });

		const archived = await stop("call", { subagent_id: CHILD_ID, mode: "terminate" }, undefined, undefined, fakeContext()) as { content: Array<{ text: string }> };
		assert.match(archived.content[0]?.text ?? "", /archived out of the track/);
		assert.deepEqual(toolNames(daemon.calls).slice(2), ["get_agent_status", "archive_agent"]);
	});
});

test("lists paseo profiles as presets", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		const result = await tool(registeredTools(), "subagent_presets")("call", {}, undefined, undefined, fakeContext()) as {
			content: Array<{ text: string }>;
			details: { profiles: Array<{ id: string }> };
		};
		assert.equal(result.details.profiles.length, 2);
		assert.match(result.content[0]?.text ?? "", /Reviewer \(agent_profile_review\)/);
		assert.match(result.content[0]?.text ?? "", /notes: Use for independent review\./);
		const profile = result.details.profiles[1]!.id;
		assert.equal(profile, "agent_profile_review");
		assert.ok(result.content[0]?.text.includes(JSON.stringify({ profile })));
		await tool(registeredTools(), "subagent_run")("call", { prompt: "task", profile }, undefined, undefined, fakeContext());
		assert.equal(daemon.calls.at(-1)?.args.provider, "pi/nikoapi/gpt-5.6-sol");
	});
});

test("reports an empty profile list", async () => {
	const daemon = makeDaemon();
	daemon.respond = (call) => (call.name === "list_profiles" ? ok({ profiles: [] }) : toolError(`unexpected ${call.name}`));
	await withFakeDaemon(daemon, async () => {
		const result = await tool(registeredTools(), "subagent_presets")("call", {}, undefined, undefined, fakeContext()) as { content: Array<{ text: string }> };
		assert.match(result.content[0]?.text ?? "", /No agent profiles are configured/);
	});
});
