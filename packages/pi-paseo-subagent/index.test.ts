import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piPaseoSubagentExtension, {
	buildInitialPrompt,
	parseChildren,
	parseProfiles,
	parseSubagentTitle,
	providerSelector,
	sessionKey,
	splitProviderModel,
	subagentTiming,
	subagentTitle,
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
		title: "scout: auth-review",
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
		title: "scout: auth-review",
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
	state: { children: Array<Record<string, unknown>>; activity: string };
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
				childRow({ id: OTHER_CHILD_ID, title: "worker: parser", status: "running", requiresAttention: false, attentionReason: null }),
				childRow({ id: FOREIGN_ID, title: "scout: someone else", labels: { "paseo.parent-agent-id": "another-parent" } }),
			],
			activity: "Showing all 2 activities\n\n[User] review the diff\ntwo real bugs found",
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
				if (agentId === OTHER_CHILD_ID) return ok({ status: "running", snapshot: childSnapshot({ id: OTHER_CHILD_ID, title: "worker: parser", status: "running", requiresAttention: false, attentionReason: undefined }) });
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
	promptGuidelines?: string[];
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

test("round-trips the role and name encoded in the agent title", () => {
	assert.equal(subagentTitle("reviewer", "diff pass"), "reviewer: diff pass");
	assert.equal(subagentTitle("scout"), "scout: task");
	assert.deepEqual(parseSubagentTitle("scout: fix: the parser"), { role: "scout", name: "fix: the parser" });
	assert.deepEqual(parseSubagentTitle("hand-written agent"), { name: "hand-written agent" });
});

test("derives a stable session key", () => {
	assert.equal(sessionKey(fakeContext()), "session-1");
	assert.equal(sessionKey(fakeContext({ sessionManager: { getSessionId: () => undefined, getSessionFile: () => "/tmp/sessions/a.jsonl" } })), "-tmp-sessions-a.jsonl");
});

test("carries the delegated role into the child prompt", () => {
	const prompt = buildInitialPrompt("Inspect the parser", "scout");
	assert.ok(prompt.includes("Role: scout."));
	assert.ok(prompt.includes("read-only"));
	assert.ok(prompt.includes("Task:\nInspect the parser"));
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
		role: "scout",
		status: "idle",
		provider: "pi/h/deepseek-flash",
		model: "h/deepseek-flash",
		requiresAttention: true,
		attentionReason: "finished",
	});
	assert.throws(() => parseChildren({}, PARENT_ID), /paseo_invalid_output/);
});

test("notes permission and timeout waits", () => {
	assert.match(waitNote({ subagent_id: "a", name: "x", status: "running", provider: "pi", attentionReason: "permission" }, 1000, false), /paseo permit allow/);
	assert.match(waitNote({ subagent_id: "a", name: "x", status: "running", provider: "pi" }, 1000, true), /still running after 1000ms/);
	assert.equal(waitNote({ subagent_id: "a", name: "x", status: "idle", provider: "pi" }, 1000, false), "");
});

// --- tools ------------------------------------------------------------------

test("registers the six subagent tools", () => {
	const tools = registeredTools();
	assert.deepEqual(tools.map((entry) => entry.name), [
		"subagent_run",
		"subagent_list",
		"subagent_read",
		"subagent_wait",
		"subagent_stop",
		"subagent_presets",
	]);
	const runParams = tools.find((entry) => entry.name === "subagent_run")?.parameters?.properties;
	assert.ok(runParams && "profile" in runParams && "thinking" in runParams);
	assert.ok(runParams && !("cwd" in runParams) && !("model_preset" in runParams));
	const runTool = tools.find((entry) => entry.name === "subagent_run");
	assert.match(runTool?.promptGuidelines?.join(" ") ?? "", /omit both profile and provider/);
	assert.match(runTool?.promptGuidelines?.join(" ") ?? "", /Never pass profile and provider together/);
	assert.match(JSON.stringify(runParams?.profile), /mutually exclusive with provider/);
	assert.match(JSON.stringify(runParams?.provider), /mutually exclusive with profile/);
});

test("inherits provider, model, and thinking from the calling agent", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		const result = await tool(registeredTools(), "subagent_run")("call", { prompt: "review the diff", role: "reviewer", name: "diff pass" }, undefined, undefined, fakeContext()) as {
			content: Array<{ text: string }>;
			details: { subagent_id: string; guidance?: string };
		};
		assert.equal(result.content[0]?.text, CHILD_ID);
		assert.equal(result.details.subagent_id, CHILD_ID);
		assert.match(result.details.guidance ?? "", /notified/);
		assert.deepEqual(toolNames(daemon.calls).slice(0, 3), ["get_agent_status", "list_agents", "create_agent"]);
		const created = daemon.calls[2];
		assert.deepEqual(created?.args, {
			title: "reviewer: diff pass",
			provider: "pi/h/deepseek-flash",
			labels: { "pi-paseo-subagent": "session-1" },
			settings: { thinkingOptionId: "xhigh" },
			initialPrompt: buildInitialPrompt("review the diff", "reviewer"),
			notifyOnFinish: true,
		});
		assert.equal(created?.callerAgentId, PARENT_ID);
	});
});

test("uses a paseo profile without inspecting the parent", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		await tool(registeredTools(), "subagent_run")("call", { prompt: "task", profile: "reviewer" }, undefined, undefined, fakeContext());
		assert.deepEqual(toolNames(daemon.calls), ["list_profiles", "list_agents", "create_agent"]);
		assert.equal(daemon.calls[2]?.args.provider, "pi/nikoapi/gpt-5.6-sol");
		assert.deepEqual(daemon.calls[2]?.args.settings, { thinkingOptionId: "high" });
	});
});

test("lets an explicit provider and thinking override win", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		await tool(registeredTools(), "subagent_run")("call", { prompt: "task", provider: "opencode", thinking: "low" }, undefined, undefined, fakeContext());
		assert.equal(daemon.calls[1]?.args.provider, "opencode");
		assert.deepEqual(daemon.calls[1]?.args.settings, { thinkingOptionId: "low" });
	});
});

test("rejects ambiguous or unknown profile selections", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		const run = tool(registeredTools(), "subagent_run");
		await assert.rejects(() => run("call", { prompt: "task", profile: "Reviewer", provider: "pi" }, undefined, undefined, fakeContext()), /invalid_arguments: pass either provider or profile/);
		await assert.rejects(() => run("call", { prompt: "task", profile: "nope" }, undefined, undefined, fakeContext()), /profile_not_found: nope/);
	});
});

test("caps concurrently active subagents", async () => {
	const daemon = makeDaemon();
	daemon.state.children = Array.from({ length: 8 }, (_, index) => childRow({ id: `child-${index}`, status: "running", requiresAttention: false, attentionReason: null }));
	await withFakeDaemon(daemon, async () => {
		await assert.rejects(
			() => tool(registeredTools(), "subagent_run")("call", { prompt: "task" }, undefined, undefined, fakeContext()),
			/too_many_active_subagents/,
		);
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
		assert.match(result.content[0]?.text ?? "", new RegExp(`${CHILD_ID} \\[idle\\] scout auth-review attention=finished`));
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
		assert.match(result.content[0]?.text ?? "", new RegExp(`${CHILD_ID} \\[closed\\] scout auth-review attention=finished archived`));
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

test("waits for every child and reports their transcripts", async () => {
	const daemon = makeDaemon();
	await withFakeDaemon(daemon, async () => {
		const result = await tool(registeredTools(), "subagent_wait")("call", { subagent_ids: [CHILD_ID, OTHER_CHILD_ID], wait_ms: 200 }, undefined, undefined, fakeContext()) as {
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

test("reads no transcript for an archived child during a wait", async () => {
	const daemon = makeDaemon();
	daemon.state.children = [
		childRow({ status: "closed", archivedAt: "2026-09-13T04:13:12.000Z" }),
		childRow({ id: OTHER_CHILD_ID, title: "worker: parser", status: "running", requiresAttention: false, attentionReason: null }),
	];
	await withFakeDaemon(daemon, async () => {
		const result = await tool(registeredTools(), "subagent_wait")("call", { subagent_ids: [CHILD_ID, OTHER_CHILD_ID], wait_ms: 200 }, undefined, undefined, fakeContext()) as { content: Array<{ text: string }> };
		// The archived child is skipped, so `get_agent_activity` only reaches the running one.
		assert.deepEqual(daemon.calls.filter((call) => call.name === "get_agent_activity").map((call) => call.args.agentId), [OTHER_CHILD_ID]);
		assert.match(result.content[0]?.text ?? "", /archived: this subagent was removed from the track/);
		assert.match(result.content[0]?.text ?? "", /two real bugs found/);
	});
});

test("returns as soon as any child settles in any mode", async () => {
	const daemon = makeDaemon();
	const runningChild = childRow({ id: OTHER_CHILD_ID, title: "worker: parser", status: "running", requiresAttention: false, attentionReason: null });
	daemon.state.children = [
		childRow({ id: CHILD_ID, status: "running", requiresAttention: false, attentionReason: null }),
		runningChild,
	];
	await withFakeDaemon(daemon, async () => {
		const wait = tool(registeredTools(), "subagent_wait");
		await assert.rejects(() => wait("call", { subagent_ids: [CHILD_ID, CHILD_ID], wait_ms: 100 }, undefined, undefined, fakeContext()), /invalid_arguments: subagent_ids must not contain duplicates/);

		// The second child is still running, but `any` should not wait for the first one to settle twice.
		daemon.state.children[1] = childRow({ id: OTHER_CHILD_ID, title: "worker: parser", status: "idle", requiresAttention: false, attentionReason: null });
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
			details: { profiles: unknown[] };
		};
		assert.equal(result.details.profiles.length, 2);
		assert.match(result.content[0]?.text ?? "", /Reviewer \(agent_profile_review\)/);
		assert.match(result.content[0]?.text ?? "", /notes: Use for independent review\./);
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
