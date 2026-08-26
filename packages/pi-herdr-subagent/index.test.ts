import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piHerdrSubagentExtension, { buildSubagentCommand, isSubagentLabel, resolveConfiguredModel, resolveSubagentModel, ROLE_TOOLS } from "./index.ts";
import { backgroundTerminalService } from "pi-herdr-background-terminal";

test("builds a quoted child pi command with role tools", () => {
	const command = buildSubagentCommand({
		prompt: "Inspect O'Reilly's parser",
		role: "scout",
		model: "anthropic/claude-sonnet",
		thinking: "high",
	});
	expect(command).toContain("--no-extensions");
	expect(command).toContain(`'${ROLE_TOOLS.scout.join(",")}'`);
	expect(command).toContain("'anthropic/claude-sonnet'");
	expect(command).toContain("O'\\''Reilly");
	expect(command).toContain("--thinking");
});

test("recognizes only the subagent label namespace", () => {
	expect(isSubagentLabel("subagent:scout:task")).toBeTrue();
	expect(isSubagentLabel("dev-server")).toBeFalse();
});

test("inherits the parent model when no preset is selected", async () => {
	const ctx = {
		cwd: "/tmp/project",
		model: { provider: "parent-provider", id: "parent-model" },
		thinkingLevel: "high",
		modelRegistry: { find: () => undefined },
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined },
	} as never;
	expect(await resolveSubagentModel({ prompt: "task", thinking: "low" }, ctx)).toEqual({ model: "parent-provider/parent-model", thinking: "low" });
});

test("loads global and project presets and lets explicit thinking win", async () => {
	const agentDir = join(tmpdir(), `pi-herdr-subagent-${process.pid}-${Date.now()}`);
	const project = join(agentDir, "project");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await mkdir(join(project, ".pi"), { recursive: true });
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ "pi-herdr-subagent": { presets: {
			fast: { model: "provider/fast", thinking: "low" },
			balanced: { model: "provider/balanced", thinking: "medium" },
		} } }));
		await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ "pi-herdr-subagent": { presets: {
			fast: { model: "provider/project-fast" },
		} } }));
		const ctx = {
			cwd: project,
			model: { provider: "parent-provider", id: "parent-model" },
			thinkingLevel: "high",
			modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined },
		} as never;
		expect(await resolveSubagentModel({ prompt: "task", model_preset: "fast", thinking: "max" }, ctx)).toEqual({ model: "provider/project-fast", thinking: "max" });
		expect(await resolveSubagentModel({ prompt: "task", model_preset: "balanced" }, ctx)).toEqual({ model: "provider/balanced", thinking: "medium" });
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("rejects a configured model that is absent from the catalog", () => {
	const ctx = { modelRegistry: { find: () => undefined } } as never;
	expect(() => resolveConfiguredModel("provider/missing", ctx, "preset")).toThrow("unknown model provider/missing");
});

test("lists only subagents registered by the current session", async () => {
	const tools: Array<{ name: string; execute?: (...args: unknown[]) => Promise<unknown> }> = [];
	piHerdrSubagentExtension({
		registerTool: (tool: unknown) => tools.push(tool as typeof tools[number]),
		registerCommand: () => undefined,
		on: () => undefined,
	} as never);
	const run = tools.find((tool) => tool.name === "subagent_run")?.execute;
	const list = tools.find((tool) => tool.name === "subagent_list")?.execute;
	if (!run || !list) throw new Error("subagent tools were not registered");
	const originalExec = backgroundTerminalService.exec;
	const originalList = backgroundTerminalService.list;
	backgroundTerminalService.exec = async () => ({ task_id: "bt_session_1" });
	backgroundTerminalService.list = async (params) => ({
		tasks: params.task_id === "bt_session_1" ? [{ task_id: "bt_session_1", label: "subagent:scout:task", state: "running", updated_at: "2026-01-01T00:00:00.000Z" }] : [],
	});
	const context = (sessionId: string) => ({
		cwd: "/tmp/project",
		model: { provider: "provider", id: "model" },
		thinkingLevel: "high",
		modelRegistry: { find: () => ({}) },
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
	}) as never;
	try {
		await run("call", { prompt: "task" }, undefined, undefined, context("session-1"));
		expect((await list("call", {}, undefined, undefined, context("session-1")) as { details: { tasks: unknown[] } }).details.tasks).toHaveLength(1);
		expect((await list("call", {}, undefined, undefined, context("session-2")) as { details: { tasks: unknown[] } }).details.tasks).toHaveLength(0);
	} finally {
		backgroundTerminalService.exec = originalExec;
		backgroundTerminalService.list = originalList;
	}
});

test("marks bounded subagent output as truncated", async () => {
	const tools: Array<{ name: string; execute?: (...args: unknown[]) => Promise<unknown> }> = [];
	piHerdrSubagentExtension({
		registerTool: (tool: unknown) => tools.push(tool as typeof tools[number]),
		registerCommand: () => undefined,
		on: () => undefined,
	} as never);
	const read = tools.find((tool) => tool.name === "subagent_read")?.execute;
	const run = tools.find((tool) => tool.name === "subagent_run")?.execute;
	if (!read || !run) throw new Error("subagent tools were not registered");
	const originalExec = backgroundTerminalService.exec;
	const originalList = backgroundTerminalService.list;
	const originalRead = backgroundTerminalService.read;
	backgroundTerminalService.exec = async () => ({ task_id: "bt_read_1" });
	backgroundTerminalService.list = async () => ({ tasks: [{
		task_id: "bt_read_1", label: "subagent:scout:task", state: "exited", exit_code: 0,
		updated_at: "2026-01-01T00:00:00.000Z", output_truncated: true,
	}] });
	backgroundTerminalService.read = async () => "tail output";
	const context = {
		cwd: "/tmp/project",
		model: undefined,
		thinkingLevel: "high",
		modelRegistry: { find: () => ({}) },
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "session-read", getSessionFile: () => undefined },
	} as never;
	try {
		await run("call", { prompt: "task" }, undefined, undefined, context);
		const result = await read("call", { subagent_id: "bt_read_1" }, undefined, undefined, context) as { content: Array<{ text: string }>; details: { output_truncated: boolean } };
		expect(result.details.output_truncated).toBeTrue();
		expect(result.content[0]?.text).toContain("output truncated");
	} finally {
		backgroundTerminalService.exec = originalExec;
		backgroundTerminalService.list = originalList;
		backgroundTerminalService.read = originalRead;
	}
});

test("waits for any subagent and returns every requested task", async () => {
	const tools: Array<{ name: string; execute?: (...args: unknown[]) => Promise<unknown> }> = [];
	piHerdrSubagentExtension({
		registerTool: (tool: unknown) => tools.push(tool as typeof tools[number]),
		registerCommand: () => undefined,
		on: () => undefined,
	} as never);
	const run = tools.find((tool) => tool.name === "subagent_run")?.execute;
	const wait = tools.find((tool) => tool.name === "subagent_wait")?.execute;
	if (!run || !wait) throw new Error("subagent wait tools were not registered");
	const originalExec = backgroundTerminalService.exec;
	const originalList = backgroundTerminalService.list;
	const originalRead = backgroundTerminalService.read;
	let nextId = 0;
	const states = new Map<string, "running" | "exited">();
	backgroundTerminalService.exec = async () => {
		const task_id = `bt_wait_${++nextId}`;
		states.set(task_id, "running");
		return { task_id };
	};
	backgroundTerminalService.list = async (params) => {
		const tasks = [...states.entries()]
			.filter(([task_id]) => params.task_id === undefined || params.task_id === task_id)
			.map(([task_id, state]) => ({ task_id, label: "subagent:scout:task", state, updated_at: "2026-01-01T00:00:00.000Z" }));
		return { tasks };
	};
	backgroundTerminalService.read = async (params) => {
		if (params.wait_ms && params.wait_ms > 0 && params.task_id === "bt_wait_1") states.set(params.task_id, "exited");
		return `output-${params.task_id}`;
	};
	const context = {
		cwd: "/tmp/project",
		model: undefined,
		thinkingLevel: "high",
		modelRegistry: { find: () => ({}) },
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "session-wait-any", getSessionFile: () => undefined },
	} as never;
	try {
		await run("call", { prompt: "first" }, undefined, undefined, context);
		await run("call", { prompt: "second" }, undefined, undefined, context);
		const result = await wait("call", { subagent_ids: ["bt_wait_1", "bt_wait_2"], mode: "any", wait_ms: 1000 }, undefined, undefined, context) as { content: Array<{ text: string }>; details: { timed_out: boolean; tasks: unknown[] } };
		expect(result.details.timed_out).toBeFalse();
		expect(result.details.tasks).toHaveLength(2);
		expect(result.content[0]?.text).toContain("bt_wait_1 [exited]");
		expect(result.content[0]?.text).toContain("bt_wait_2 [running]");
	} finally {
		backgroundTerminalService.exec = originalExec;
		backgroundTerminalService.list = originalList;
		backgroundTerminalService.read = originalRead;
	}
});

test("registers the five asynchronous lifecycle tools", () => {
	const tools: Array<{ name: string; parameters?: { properties?: Record<string, unknown> } }> = [];
	piHerdrSubagentExtension({
		registerTool: (tool: unknown) => tools.push(tool as typeof tools[number]),
		registerCommand: () => undefined,
		on: () => undefined,
	} as never);
	expect(tools.map((tool) => tool.name)).toEqual([
		"subagent_run",
		"subagent_list",
		"subagent_read",
		"subagent_wait",
		"subagent_stop",
	]);
	expect(tools.find((tool) => tool.name === "subagent_run")?.parameters?.properties).toHaveProperty("model_preset");
	expect(tools.find((tool) => tool.name === "subagent_run")?.parameters?.properties).not.toHaveProperty("model");
});
