import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extension, { PaseoBackgroundTerminalService, parentAgentId, parseCursor, taskLabel } from "./index.ts";
import { canonicalProjectRoot, listTaskRecords, loadTaskRecord, metaPath, taskSummaryText } from "./runner.ts";
import { assertExecParams, assertReadParams, assertStopParams, assertTaskId, assertWriteParams } from "./protocol.ts";
import type { PaseoTerminalClient, TerminalSummary } from "./paseo-terminal-client.ts";

class FakeTerminals implements PaseoTerminalClient {
	terminals = new Map<string, TerminalSummary>();
	keys: Array<{ terminalId: string; keys: string; literal?: boolean }> = [];
	captures = new Map<string, string[]>();
	kills: string[] = [];
	next = 1;
	listError?: Error;
	submitError?: Error;
	async createTerminal({ cwd, name }: { cwd: string; name: string }) {
		const terminal = { id: `term-${this.next++}`, cwd, name };
		this.terminals.set(terminal.id, terminal);
		return terminal;
	}
	async sendKeys(input: { terminalId: string; keys: string; literal?: boolean }) {
		if (!this.terminals.has(input.terminalId)) throw new Error(`Terminal ${input.terminalId} not found`);
		if (this.submitError) throw this.submitError;
		this.keys.push(input);
	}
	async captureTerminal({ terminalId }: { terminalId: string }) {
		if (!this.terminals.has(terminalId)) throw new Error(`Terminal ${terminalId} not found`);
		const lines = this.captures.get(terminalId) ?? [];
		return { lines, totalLines: lines.length };
	}
	async listTerminals() {
		if (this.listError) throw this.listError;
		return [...this.terminals.values()];
	}
	async killTerminal({ terminalId }: { terminalId: string }) {
		this.kills.push(terminalId);
		this.terminals.delete(terminalId);
	}
}

const context = (cwd: string) => ({ cwd, hasUI: false, isProjectTrusted: () => true }) as never;
async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const home = await mkdtemp(join(tmpdir(), "paseo-direct-"));
	const project = join(home, "project");
	await mkdir(project);
	const root = await canonicalProjectRoot(project);
	const previousAgent = process.env.PASEO_AGENT_ID;
	process.env.PASEO_AGENT_ID = "agent-test";
	t.after(async () => {
		if (previousAgent === undefined) delete process.env.PASEO_AGENT_ID;
		else process.env.PASEO_AGENT_ID = previousAgent;
		await rm(home, { recursive: true, force: true });
	});
	const fake = new FakeTerminals();
	return { home, root, fake, ctx: context(root), service: new PaseoBackgroundTerminalService(fake, home) };
}

test("exec sends the original command and Enter, persisting only metadata", async (t) => {
	const { home, root, fake, ctx, service } = await fixture(t);
	const command = "printf '%s\\n' \"a'b $(echo two)\"\nprintf '多行\\n'";
	const result = await service.exec({ command, label: "human-visible" }, ctx);
	assert.equal(result.summary.state, "open");
	assert.equal(result.summary.label, "human-visible");
	assert.deepEqual(fake.keys.map(({ keys, literal }) => [keys, literal]), [[command, true], ["Enter", undefined]]);
	const record = await loadTaskRecord(root, result.task_id, home);
	assert.deepEqual(await readdir(record.dir), ["meta.json"]);
	assert.deepEqual(Object.keys(JSON.parse(await readFile(metaPath(record.dir), "utf8"))).sort(),
		["command", "created_at", "cwd", "label", "task_id", "terminal_id"]);
	assert.equal(record.meta.command, command);
});

test("reads capture the shared terminal snapshot with line and byte bounds", async (t) => {
	const { fake, ctx, service } = await fixture(t);
	const { task_id, summary } = await service.exec({ command: "printf hello" }, ctx);
	fake.captures.set(summary.terminal_id, ["$ printf hello", "hello", "$", "", ""]);
	assert.equal(await service.read({ task_id, output_lines: 2 }, ctx), "hello\n$");
	assert.equal(await service.read({ task_id, output_lines: 2 }, ctx), "hello\n$", "reads do not consume a cursor");
	fake.captures.set(summary.terminal_id, ["x".repeat(100_000), "tail"]);
	const bounded = await service.read({ task_id }, ctx);
	assert.ok(Buffer.byteLength(bounded) < 52_000);
	assert.ok(bounded.endsWith("tail"));
	await service.stop({ task_id, mode: "terminate" }, ctx);
	await assert.rejects(service.read({ task_id }, ctx), /not found/);
});

test("session reuse sends input directly and rejects cwd overrides or missing terminals", async (t) => {
	const { fake, ctx, service } = await fixture(t);
	const first = await service.exec({ command: "export SHARED=one" }, ctx);
	const second = await service.exec({ command: "echo $SHARED", session: first.task_id }, ctx);
	assert.equal(second.summary.terminal_id, first.summary.terminal_id);
	assert.equal(fake.terminals.size, 1);
	assert.equal(fake.keys[2]?.keys, "echo $SHARED");
	await assert.rejects(service.exec({ command: "pwd", session: first.task_id, cwd: "." }, ctx), /cwd only applies/);
	await service.stop({ task_id: first.task_id, mode: "terminate" }, ctx);
	await assert.rejects(service.exec({ command: "true", session: first.task_id }, ctx), /session_not_found/);
	assert.ok((await service.list({}, ctx)).tasks.every((task) => task.state === "closed"));
});

test("terminal state never claims command completion and daemon errors propagate", async (t) => {
	const { fake, ctx, service } = await fixture(t);
	const result = await service.exec({ command: "false" }, ctx);
	assert.equal((await service.list({}, ctx)).tasks[0]?.state, "open");
	assert.equal("exit_code" in result.summary, false);
	const interrupted = await service.stop({ task_id: result.task_id, mode: "interrupt" }, ctx);
	assert.equal(interrupted.task.state, "open");
	assert.equal(fake.keys.at(-1)?.keys, "C-c");
	fake.listError = new Error("daemon unavailable");
	await assert.rejects(service.list({}, ctx), /daemon unavailable/);
	await assert.rejects(service.cleanup(ctx, true), /daemon unavailable/);
});

test("write reaches the foreground process and remains usable after Ctrl-C", async (t) => {
	const { fake, ctx, service } = await fixture(t);
	const { task_id } = await service.exec({ command: "read line" }, ctx);
	await service.write({ task_id, input: "hello", submit: false }, ctx);
	assert.equal(fake.keys.at(-1)?.keys, "hello");
	await service.stop({ task_id, mode: "interrupt" }, ctx);
	await service.write({ task_id, input: "echo ready" }, ctx);
	assert.equal(fake.keys.at(-1)?.keys, "Enter");
	await service.stop({ task_id, mode: "terminate" }, ctx);
	await assert.rejects(service.write({ task_id, input: "too late" }, ctx), /terminal_closed/);
	const stopped = await service.stop({ task_id, mode: "interrupt" }, ctx);
	assert.equal(stopped.accepted, false);
	assert.equal(stopped.reason, "terminal_closed");
});

test("closed-terminal cleanup preserves all open human sessions", async (t) => {
	const { fake, ctx, service } = await fixture(t);
	const closed = await service.exec({ command: "true" }, ctx);
	const kept = await service.exec({ command: "true" }, ctx);
	await service.stop({ task_id: closed.task_id, mode: "terminate" }, ctx);
	assert.deepEqual(await service.cleanup(ctx, false), { eligible: 1, removed: 0 });
	assert.deepEqual(await service.cleanup(ctx, true), { eligible: 1, removed: 1 });
	assert.equal((await service.list({}, ctx)).tasks[0]?.task_id, kept.task_id);
	assert.deepEqual(fake.kills, [closed.summary.terminal_id]);
});

test("all open terminals count toward the cap, and reuse needs no new slot", async (t) => {
	const { ctx, service } = await fixture(t);
	const first = await service.exec({ command: "true" }, ctx);
	for (let index = 1; index < 16; index++) await service.exec({ command: "true" }, ctx);
	await assert.rejects(service.exec({ command: "true" }, ctx), /too_many_active_sessions/);
	await service.exec({ command: "true", session: first.task_id }, ctx);
	await service.stop({ task_id: first.task_id, mode: "terminate" }, ctx);
	await service.exec({ command: "true" }, ctx);
});

test("submission failures clean new records and terminals but preserve reused terminals", async (t) => {
	const { home, root, fake, ctx, service } = await fixture(t);
	fake.submitError = new Error("send failed");
	await assert.rejects(service.exec({ command: "true" }, ctx), /send failed/);
	assert.equal(fake.terminals.size, 0);
	assert.equal((await listTaskRecords(root, home)).length, 0);
	fake.submitError = undefined;
	const first = await service.exec({ command: "true" }, ctx);
	fake.submitError = new Error("send failed");
	await assert.rejects(service.exec({ command: "true", session: first.task_id }, ctx), /send failed/);
	assert.equal(fake.terminals.size, 1);
	assert.equal((await listTaskRecords(root, home)).length, 1);
});

test("pagination returns every submission once", async (t) => {
	const { ctx, service } = await fixture(t);
	for (let index = 0; index < 5; index++) await service.exec({ command: `echo ${index}` }, ctx);
	const ids: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await service.list({ limit: 2, cursor }, ctx);
		ids.push(...page.tasks.map((task) => task.task_id));
		cursor = page.next_cursor;
	} while (cursor);
	assert.equal(new Set(ids).size, 5);
	assert.throws(() => parseCursor("!!!"), /cursor is invalid/);
});

test("legacy files are untouched and never used for output or command state", async (t) => {
	const { home, root, fake, ctx, service } = await fixture(t);
	const { task_id, summary } = await service.exec({ command: "true" }, ctx);
	const record = await loadTaskRecord(root, task_id, home);
	await writeFile(metaPath(record.dir), JSON.stringify({ ...record.meta, output: "log", read_offset: 42 }));
	await writeFile(join(record.dir, "log"), "old hidden output");
	await writeFile(join(record.dir, "status"), "0");
	fake.captures.set(summary.terminal_id, ["visible output"]);
	assert.equal(await service.read({ task_id }, ctx), "visible output");
	assert.equal((await service.list({}, ctx)).tasks[0]?.state, "open");
	assert.equal(await readFile(join(record.dir, "log"), "utf8"), "old hidden output");
});

test("validation rejects stale options, control input, unsafe ids and untrusted cwd", async (t) => {
	const { fake, ctx, service, root } = await fixture(t);
	for (const option of [{ output: "log" }, { output: "screen" }, { wait_ms: 10 }]) {
		assert.throws(() => assertExecParams({ command: "true", ...option } as never), /supported parameters/);
	}
	assert.throws(() => assertReadParams({ task_id: "t-a", range: "all" } as never), /supported parameters/);
	for (const command of ["", " \n", "echo hi\u001b[200~", "a\0b"]) assert.throws(() => assertExecParams({ command }), /invalid_arguments/);
	assert.throws(() => assertExecParams({ command: "中".repeat(30_000) }), /UTF-8 bytes/);
	for (const id of ["../other", "t-../../other", "", "x".repeat(129)]) assert.throws(() => assertTaskId(id), /invalid_arguments/);
	for (const output_lines of [0, 2001, NaN, 1.5]) assert.throws(() => assertReadParams({ task_id: "t-a", output_lines }), /output_lines/);
	assert.throws(() => assertWriteParams({ task_id: "t-a", input: "x", submit: "yes" } as never), /submit/);
	assert.throws(() => assertStopParams({ task_id: "t-a", mode: "kill" } as never), /mode/);
	await assert.rejects(service.exec({ command: "true", cwd: ".." }, ctx), /cwd must stay/);
	await assert.rejects(service.exec({ command: "true" }, { cwd: root, isProjectTrusted: () => false } as never), /not trusted/);
	assert.equal(fake.terminals.size, 0);
	assert.throws(() => parentAgentId({}), /paseo_agent_context_missing/);
	assert.equal(taskLabel(undefined, "echo first\necho second"), "echo first");
});

test("tool schemas expose direct terminal operations without old log or wait options", () => {
	const tools: any[] = [];
	const commands: string[] = [];
	extension({ registerTool: (tool: unknown) => tools.push(tool), registerCommand: (name: string) => commands.push(name) } as never);
	assert.deepEqual(tools.map((tool) => tool.name), ["background_exec", "background_list", "background_read", "background_write", "background_stop"]);
	assert.deepEqual(commands, ["bg"]);
	assert.deepEqual(Object.keys(tools[0].parameters.properties), ["command", "cwd", "label", "session"]);
	assert.deepEqual(Object.keys(tools[2].parameters.properties), ["task_id", "output_lines"]);
	assert.equal(tools[0].parameters.additionalProperties, false);
	assert.match(taskSummaryText({ task_id: "t-a", label: "x", state: "open" } as never), /terminal open/);
});
