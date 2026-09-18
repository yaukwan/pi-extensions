import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PaseoBackgroundTerminalService } from "./index.ts";

// Real MCP HTTP/SSE and persistent shells; pipes stand in for the daemon's PTYs.
// Interactive job-control behavior is verified separately by live.probe.ts.
const terminals = new Map<string, { id: string; name: string; cwd: string; pending: string; screen: string; child: ChildProcess }>();
const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
const children: ChildProcess[] = [];
let next = 1;
const server = createServer((request, response) => {
	let body = "";
	request.on("data", (chunk) => { body += chunk; });
	request.on("end", () => {
		const payload = JSON.parse(body);
		const { name, arguments: args } = payload.params;
		calls.push({ name, args });
		let result: Record<string, unknown>;
		try {
			let data: unknown;
			if (name === "create_terminal") {
				const id = `term-${next++}`;
				const child = spawn("sh", [], { cwd: args.cwd, stdio: "pipe" });
				children.push(child);
				const terminal = { id, name: args.name, cwd: args.cwd, pending: "", screen: "", child };
				terminals.set(id, terminal);
				child.stdout!.on("data", (chunk) => { terminal.screen += chunk; });
				child.stderr!.on("data", (chunk) => { terminal.screen += chunk; });
				child.on("exit", () => terminals.delete(id));
				data = { id, name: args.name, cwd: args.cwd };
			} else if (name === "list_terminals") {
				data = { terminals: [...terminals.values()].map(({ id, name, cwd }) => ({ id, name, cwd })) };
			} else {
				const terminal = terminals.get(args.terminalId);
				if (!terminal) throw new Error(`Terminal ${args.terminalId} not found`);
				if (name === "capture_terminal") {
					const lines = terminal.screen.split("\n");
					data = { lines, totalLines: lines.length };
				} else if (name === "send_terminal_keys") {
					if (args.literal) terminal.pending += args.keys;
					else if (args.keys === "Enter") {
						terminal.screen += `$ ${terminal.pending}\n`;
						terminal.child.stdin!.write(terminal.pending + "\n");
						terminal.pending = "";
					}
					data = { success: true };
				} else if (name === "kill_terminal") {
					terminal.child.kill("SIGKILL");
					terminals.delete(terminal.id);
					data = { success: true };
				} else throw new Error(`Unknown tool ${name}`);
			}
			result = { content: [], structuredContent: data };
		} catch (error) {
			result = { isError: true, content: [{ type: "text", text: String(error) }] };
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: payload.id, result })}\n\n`);
	});
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const home = await mkdtemp(join(tmpdir(), "paseo-direct-http-"));
const previousUrl = process.env.PASEO_MCP_URL;
const previousAgent = process.env.PASEO_AGENT_ID;
process.env.PASEO_MCP_URL = `http://127.0.0.1:${address.port}/mcp/agents`;
process.env.PASEO_AGENT_ID = "agent-integration";
const ctx = { cwd: home, hasUI: false, isProjectTrusted: () => true } as never;
const service = new PaseoBackgroundTerminalService(undefined, home);
async function expectOutput(task_id: string, pattern: RegExp) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const text = await service.read({ task_id }, ctx);
		if (pattern.test(text)) return text;
		await delay(25);
	}
	throw new Error(`Output did not match ${pattern}`);
}
try {
	const command = "export SHARED='one'; printf 'hello-%s\\n' world; printf 'error-%s\\n' visible >&2";
	const first = await service.exec({ command }, ctx);
	await expectOutput(first.task_id, /^hello-world$/m);
	await expectOutput(first.task_id, /^error-visible$/m);
	const submit = calls.find((call) => call.name === "send_terminal_keys");
	assert.equal(submit?.args.keys, command);
	assert.equal(submit?.args.literal, true);
	assert.equal((await service.list({}, ctx)).tasks[0]?.state, "open");

	const second = await service.exec({ command: "printf 'shared-%s\\n' \"$SHARED\"", session: first.task_id }, ctx);
	assert.equal(second.summary.terminal_id, first.summary.terminal_id);
	await expectOutput(first.task_id, /^shared-one$/m);
	const multiline = await service.exec({ command: "VALUE=multi\nprintf '%s-%s\\n' \"$VALUE\" line", session: first.task_id }, ctx);
	await expectOutput(multiline.task_id, /^multi-line$/m);
	await service.write({ task_id: first.task_id, input: "printf 'write-%s\\n' works" }, ctx);
	await expectOutput(first.task_id, /^write-works$/m);
	assert.ok(calls.some((call) => call.name === "capture_terminal" && call.args.scrollback === true));

	await service.stop({ task_id: first.task_id, mode: "terminate" }, ctx);
	assert.ok((await service.list({}, ctx)).tasks.every((task) => task.state === "closed"));
	await assert.rejects(service.read({ task_id: first.task_id }, ctx), /not found/);
	assert.equal((await service.cleanup(ctx, true)).removed, 3);
	console.log("service integration passed: direct input, stdout/stderr capture, multiline input, persistent shell, write, termination");
} finally {
	if (previousUrl === undefined) delete process.env.PASEO_MCP_URL; else process.env.PASEO_MCP_URL = previousUrl;
	if (previousAgent === undefined) delete process.env.PASEO_AGENT_ID; else process.env.PASEO_AGENT_ID = previousAgent;
	await Promise.all(children.map(async (child) => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGKILL");
		await exited;
	}));
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	await rm(home, { recursive: true, force: true });
}
