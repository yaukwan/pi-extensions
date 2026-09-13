import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PaseoBackgroundTerminalService } from "./index.ts";

/**
 * End-to-end service test against a fake Paseo daemon: real HTTP JSON-RPC over
 * the MCP envelope (SSE), real `sh run.sh` spawns, real side-channel files.
 * Only the PTY is simulated — group SIGINT/SIGHUP reproduces the live-terminal
 * behavior verified against daemon 0.8.0.
 *
 * Run: node --experimental-transform-types service.integration.ts
 */

interface FakeTerminal {
	id: string;
	name: string;
	cwd: string;
	pending: string;
	screen: string[];
	child?: ChildProcess;
}

class FakeDaemon {
	terminals = new Map<string, FakeTerminal>();
	next = 1;
	private server?: Server;
	url = "";

	async start(): Promise<void> {
		this.server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
			request.on("end", () => {
				const payload = JSON.parse(body) as { id: number; method: string; params?: { name: string; arguments?: Record<string, unknown> } };
				const result = this.handleToolCall(payload.params?.name ?? "", payload.params?.arguments ?? {});
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: payload.id, result })}\n\n`);
				response.end();
			});
		});
		await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
		const address = this.server.address();
		assert.ok(address && typeof address === "object");
		this.url = `http://127.0.0.1:${address.port}/mcp/agents`;
	}

	async stop(): Promise<void> {
		for (const terminal of this.terminals.values()) this.reap(terminal, "SIGKILL");
		await new Promise<void>((resolve, reject) => this.server?.close((error) => (error ? reject(error) : resolve())));
	}

	private reaped = new Set<string>();

	private reap(terminal: FakeTerminal, signal: NodeJS.Signals): void {
		if (terminal.child?.pid && !this.reaped.has(terminal.id)) {
			this.reaped.add(terminal.id);
			try { process.kill(-terminal.child.pid, signal); } catch { /* already gone */ }
		}
	}

	private fail(name: string, message: string): Record<string, unknown> {
		return { content: [{ type: "text", text: `${name}: ${message}` }], isError: true };
	}

	private missing(terminalId: string): string {
		return `Terminal ${terminalId} not found`;
	}

	private handleToolCall(name: string, args: Record<string, unknown>): Record<string, unknown> {
		const terminalId = typeof args.terminalId === "string" ? args.terminalId : "";
		switch (name) {
			case "create_terminal": {
				const id = `term-${this.next++}`;
				this.terminals.set(id, {
					id,
					name: String(args.name ?? ""),
					cwd: String(args.cwd ?? ""),
					pending: "",
					screen: [],
				});
				return { content: [], structuredContent: { id, name: String(args.name ?? id), cwd: String(args.cwd ?? "") } };
			}
			case "list_terminals": {
				return { content: [], structuredContent: { terminals: [...this.terminals.values()].map(({ id, name: termName, cwd }) => ({ id, name: termName, cwd })) } };
			}
			case "capture_terminal": {
				const terminal = this.terminals.get(terminalId);
				if (!terminal) return this.fail(name, this.missing(terminalId));
				return { content: [], structuredContent: { terminalId, lines: terminal.screen.slice(), totalLines: terminal.screen.length } };
			}
			case "kill_terminal": {
				const terminal = this.terminals.get(terminalId);
				if (!terminal) return this.fail(name, this.missing(terminalId));
				// A real PTY kill sends SIGHUP to the foreground group; the wrapper's
				// trap may or may not win the race against teardown.
				this.reap(terminal, "SIGHUP");
				this.terminals.delete(terminalId);
				return { content: [], structuredContent: { success: true } };
			}
			case "send_terminal_keys": {
				const terminal = this.terminals.get(terminalId);
				if (!terminal) return this.fail(name, this.missing(terminalId));
				const keys = String(args.keys ?? "");
				if (args.literal === true) {
					terminal.pending = keys;
					return { content: [], structuredContent: { success: true } };
				}
				if (keys === "Enter") {
					const line = terminal.pending;
					terminal.pending = "";
					terminal.screen.push(`$ ${line}`);
					const match = /^sh '(.+)'$/.exec(line);
					if (match?.[1]) {
						terminal.child = spawn("sh", [match[1]], { cwd: terminal.cwd, detached: true, stdio: "ignore" });
					}
					return { content: [], structuredContent: { success: true } };
				}
				if (keys === "C-c") {
					this.reap(terminal, "SIGINT");
					this.reaped.delete(terminalId);
					return { content: [], structuredContent: { success: true } };
				}
				return { content: [], structuredContent: { success: true } };
			}
			default:
				return this.fail(name, `unknown tool ${name}`);
		}
	}
}

async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs = 10_000, message = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function run(): Promise<void> {
	const daemon = new FakeDaemon();
	await daemon.start();
	const home = await mkdtemp(join(tmpdir(), "paseo-bg-integration-"));
	const projectRoot = await mkdtemp(join(tmpdir(), "paseo-bg-project-"));
	const previousUrl = process.env.PASEO_MCP_URL;
	const previousAgent = process.env.PASEO_AGENT_ID;
	process.env.PASEO_MCP_URL = daemon.url;
	process.env.PASEO_AGENT_ID = "agent-integration";
	const context = { cwd: projectRoot, hasUI: false, isProjectTrusted: () => true } as never;
	const service = new PaseoBackgroundTerminalService(undefined, home);

	try {
		// 1. Log-mode task: exact bytes, real exit code, clean screen.
		const hello = await service.exec({ command: "echo hello-from-task; exit 7" }, context);
		assert.match(hello.summary.state, /running/);
		await waitUntil(async () => (await service.list({ task_id: hello.task_id }, context)).tasks[0]?.state === "exited", 10_000, "task to exit");
		const exited = (await service.list({ task_id: hello.task_id }, context)).tasks[0];
		assert.equal(exited?.exit_code, 7);
		assert.ok(exited?.log_path);
		const output = await service.read({ task_id: hello.task_id, range: "all" }, context);
		assert.equal(output.trim(), "hello-from-task");
		const screen = daemon.terminals.get(exited?.terminal_id ?? "");
		assert.ok(screen?.screen.every((line) => !line.includes("hello-from-task")), "command output never touches the screen in log mode");

		// 2. wait_ms returns the exit code in the exec call itself.
		const quick = await service.exec({ command: "printf quick", wait_ms: 5_000 }, context);
		assert.equal(quick.summary.state, "exited");
		assert.equal(quick.summary.exit_code, 0);
		assert.match(execText(quick.task_id, quick.summary), /exited exit=0/);

		// 3. Session reuse: one terminal, two tasks.
		const first = await service.exec({ command: "true" }, context);
		const second = await service.exec({ command: "true", session: first.task_id }, context);
		const [firstSummary, secondSummary] = await Promise.all([
			(await service.list({ task_id: first.task_id }, context)).tasks[0],
			(await service.list({ task_id: second.task_id }, context)).tasks[0],
		]);
		assert.equal(firstSummary?.terminal_id, secondSummary?.terminal_id);

		// 4. Screen mode keeps output on the terminal.
		const shown = await service.exec({ command: "echo visible-on-screen", output: "screen", wait_ms: 5_000 }, context);
		assert.equal(shown.summary.state, "exited");
		const screenRead = await service.read({ task_id: shown.task_id }, context);
		assert.ok(screenRead.includes("sh '"), "screen mode renders captured terminal lines");

		// 5. Interrupt: group SIGINT reproduces Ctrl-C and the trap records 130.
		const sleeper = await service.exec({ command: "echo before-stop; sleep 30" }, context);
		await waitUntil(async () => (await service.read({ task_id: sleeper.task_id, wait_ms: 0 }, context)).includes("before-stop"), 10_000, "task output to appear");
		const interrupted = await service.stop({ task_id: sleeper.task_id, mode: "interrupt" }, context);
		assert.ok(interrupted.accepted);
		await waitUntil(async () => {
			const task = (await service.list({ task_id: sleeper.task_id }, context)).tasks[0];
			return task?.state === "exited" && task.exit_code === 130;
		}, 10_000, "interrupt to record exit 130");

		// 6. Terminate: the PTY dies; either the HUP trap lands (129) or the fallback writes terminated.
		const lingering = await service.exec({ command: "sleep 30" }, context);
		const terminated = await service.stop({ task_id: lingering.task_id, mode: "terminate" }, context);
		await waitUntil(async () => (await service.list({ task_id: lingering.task_id }, context)).tasks[0]?.state === "exited", 10_000, "termination to settle");
		const settled = (await service.list({ task_id: lingering.task_id }, context)).tasks[0];
		assert.ok(settled && (settled.terminated === true || settled.exit_code === 129), `expected terminated or 129, got ${JSON.stringify(settled)}`);
		assert.ok(terminated.accepted);

		// 7. Orphan: the daemon removes the terminal behind the service's back.
		const abandoned = await service.exec({ command: "sleep 30" }, context);
		const abandonedTerminal = (await service.list({ task_id: abandoned.task_id }, context)).tasks[0]?.terminal_id ?? "";
		daemon.terminals.get(abandonedTerminal)?.child?.kill("SIGKILL");
		daemon.terminals.delete(abandonedTerminal);
		await waitUntil(async () => (await service.list({ task_id: abandoned.task_id }, context)).tasks[0]?.state === "orphaned", 10_000, "task to orphan");

		// 8. Writes reach the live session; finished tasks refuse them.
		const interactive = await service.exec({ command: "sleep 30" }, context);
		await service.write({ task_id: interactive.task_id, input: "typed-input", submit: false }, context);
		const stoppedInt = await service.stop({ task_id: interactive.task_id, mode: "interrupt" }, context);
		assert.ok(stoppedInt.accepted);
		await assert.rejects(
			service.write({ task_id: interactive.task_id, input: "too late" }, context),
			/task_not_running/,
		);

		console.log("service integration passed");
	} finally {
		if (previousUrl === undefined) delete process.env.PASEO_MCP_URL; else process.env.PASEO_MCP_URL = previousUrl;
		if (previousAgent === undefined) delete process.env.PASEO_AGENT_ID; else process.env.PASEO_AGENT_ID = previousAgent;
		await daemon.stop();
		await rm(home, { recursive: true, force: true });
		await rm(projectRoot, { recursive: true, force: true });
	}
}

function execText(taskId: string, summary: { state: string; exit_code?: number; terminated?: boolean }): string {
	// Mirrors the tool's content projection without importing the private helper.
	if (summary.state !== "exited") return taskId;
	return `${taskId} exited${summary.exit_code === undefined ? "" : ` exit=${summary.exit_code}`}${summary.terminated ? " terminated" : ""}`;
}

await run();
