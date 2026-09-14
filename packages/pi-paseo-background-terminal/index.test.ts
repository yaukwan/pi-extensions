import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import paseoBackgroundTerminalExtension, {
	PaseoBackgroundTerminalService,
	execResultText,
	parentAgentId,
	parseCursor,
	taskLabel,
} from "./index.ts";
import {
	assertInsideProject,
	canonicalProjectRoot,
	generateRunSh,
	generateSubmitLine,
	listTaskRecords,
	loadTaskRecord,
	logPath,
	newTaskId,
	projectLogText,
	readStatusFile,
	shellQuote,
	statusPath,
	summarizeTask,
	taskDirectory,
	writeStatusFile,
} from "./runner.ts";
import {
	assertExecParams,
	assertReadParams,
	assertStopParams,
	assertTaskId,
	assertWriteParams,
} from "./protocol.ts";
import type { PaseoTerminalClient } from "./paseo-terminal-client.ts";

// Service-level tests own the Paseo agent context; the parentAgentId test covers the failure.
process.env.PASEO_AGENT_ID = "agent-1";

function temporaryHome(): string {
	return join(tmpdir(), `.test-paseo-bg-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

async function temporaryProject(home: string): Promise<string> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	// Resolve through the same canonicalization the service applies (macOS /var → /private/var).
	return canonicalProjectRoot(project);
}

const context = (cwd: string) => ({ cwd, hasUI: false, isProjectTrusted: () => true }) as never;

function withAgentId<T>(body: () => Promise<T>): Promise<T> {
	const previous = process.env.PASEO_AGENT_ID;
	process.env.PASEO_AGENT_ID = "agent-1";
	return body().finally(() => {
		if (previous === undefined) delete process.env.PASEO_AGENT_ID;
		else process.env.PASEO_AGENT_ID = previous;
	});
}

class FakeTerminals implements PaseoTerminalClient {
	terminals = new Map<string, { id: string; name: string; cwd: string }>();
	keys: Array<{ terminalId: string; keys: string; literal?: boolean }> = [];
	kills: string[] = [];
	captures = new Map<string, string[]>();
	next = 1;
	listError: Error | undefined;
	onSubmit: ((terminalId: string, line: string) => void) | undefined;
	onCtrlC: ((terminalId: string) => void) | undefined;
	private pendingLiteral = new Map<string, string>();

	async createTerminal(options: { cwd: string; name: string }): Promise<{ id: string; name: string; cwd: string }> {
		const id = `term-${this.next++}`;
		this.terminals.set(id, { id, name: options.name, cwd: options.cwd });
		return { id, name: options.name, cwd: options.cwd };
	}

	async sendKeys(options: { terminalId: string; keys: string; literal?: boolean }): Promise<void> {
		if (!this.terminals.has(options.terminalId)) {
			throw new Error(`paseo_tool_failed: send_terminal_keys: Terminal ${options.terminalId} not found`);
		}
		this.keys.push({ terminalId: options.terminalId, keys: options.keys, ...(options.literal ? { literal: true } : {}) });
		if (options.literal) {
			this.pendingLiteral.set(options.terminalId, options.keys);
			return;
		}
		if (options.keys === "Enter") this.onSubmit?.(options.terminalId, this.pendingLiteral.get(options.terminalId) ?? "");
		else if (options.keys === "C-c") this.onCtrlC?.(options.terminalId);
	}

	async captureTerminal(options: { terminalId: string }): Promise<{ lines: string[]; totalLines: number }> {
		if (!this.terminals.has(options.terminalId)) {
			throw new Error(`paseo_tool_failed: capture_terminal: Terminal ${options.terminalId} not found`);
		}
		const lines = this.captures.get(options.terminalId) ?? [];
		return { lines: [...lines], totalLines: lines.length };
	}

	async listTerminals(): Promise<Array<{ id: string; name: string; cwd: string }>> {
		if (this.listError) throw this.listError;
		return [...this.terminals.values()];
	}

	async killTerminal(options: { terminalId: string }): Promise<void> {
		this.kills.push(options.terminalId);
		this.terminals.delete(options.terminalId);
	}
}

async function makeService(): Promise<{ service: PaseoBackgroundTerminalService; fake: FakeTerminals; home: string; projectRoot: string }> {
	const home = temporaryHome();
	const projectRoot = await temporaryProject(home);
	const fake = new FakeTerminals();
	return { service: new PaseoBackgroundTerminalService(fake, home), fake, home, projectRoot };
}

async function cleanupHome(home: string): Promise<void> {
	await rm(home, { recursive: true, force: true });
}

async function statusExit(dir: string): Promise<number | undefined> {
	const status = await readStatusFile(dir);
	return status?.exit_code;
}

async function statusTerminated(dir: string): Promise<true | undefined> {
	return (await readStatusFile(dir))?.terminated;
}

/** Runs the generated wrapper the way a PTY would and resolves when the status file appears. */
async function runWrapper(dir: string, signal?: "SIGINT" | "SIGHUP" | "SIGTERM"): Promise<number> {
	const child = spawn("sh", [join(dir, "run.sh")], { detached: true, stdio: "ignore" });
	const exitCode = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("wrapper did not exit in time"));
		}, 10_000);
		if (signal) setTimeout(() => { try { process.kill(-child.pid!, signal); } catch { /* already gone */ } }, 300);
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("exit", (code) => { clearTimeout(timer); resolve(code ?? -1); });
	});
	return exitCode;
}

test("run.sh embeds only paths: command bytes live in cmd.sh, log mode adds env exports and redirect", () => {
	const paths = { cmdPath: "/s/t-x/cmd.sh", statusPath: "/s/t-x/status", logPath: "/s/t-x/log" };
	const run = generateRunSh(paths);
	assert.ok(run.includes("export NO_COLOR=1 TERM=dumb PAGER=cat"));
	assert.ok(run.includes(`( . ${shellQuote(paths.cmdPath)} ) <&0 > ${shellQuote(paths.logPath)} 2>&1`), "the command keeps the terminal stdin, not the /dev/null a bare async list gets");
	assert.ok(run.includes(`status=${shellQuote(paths.statusPath)}`));
	for (const trap of ["HUP", "INT", "TERM"]) assert.ok(run.includes(trap));
	const screen = generateRunSh({ cmdPath: paths.cmdPath, statusPath: paths.statusPath });
	assert.ok(!screen.includes("NO_COLOR"), "screen mode keeps the environment untouched");
	assert.ok(!screen.includes("2>&1"), "screen mode does not redirect output");
	assert.ok(screen.includes(`( . ${shellQuote(paths.cmdPath)} ) <&0 &`), "screen mode keeps the terminal stdin too");
	assert.equal(generateSubmitLine("/s/t-x/run.sh"), "sh '/s/t-x/run.sh'");
	assert.ok(shellQuote("a'b").includes(`'\\''`));
});

test("generated wrapper records exact output and the real exit code", async () => {
	const home = temporaryHome();
	const projectRoot = await temporaryProject(home);
	const service = new PaseoBackgroundTerminalService(new FakeTerminals(), home);
	const { task_id, summary } = await service.exec({ command: "echo hello; echo oops >&2; exit 3", output: "log" }, context(projectRoot));
	assert.equal(summary.state, "running");
	const record = await loadTaskRecord(projectRoot, task_id, home);
	// The wrapper's own exit code is 0 after a clean record; the task's exit code lives in the status file.
	assert.equal(await runWrapper(record.dir), 0);
	assert.equal((await statusExit(record.dir)), 3);
	const log = await readFile(logPath(record.dir), "utf8");
	assert.ok(log.includes("hello") && log.includes("oops"));
	await cleanupHome(home);
});

test("wrapper passes quotes and command substitution through cmd.sh verbatim", async () => {
	const home = temporaryHome();
	const projectRoot = await temporaryProject(home);
	const service = new PaseoBackgroundTerminalService(new FakeTerminals(), home);
	const { task_id } = await service.exec({ command: "printf '%s\\n' \"a'b $(echo two)\"", output: "log" }, context(projectRoot));
	const record = await loadTaskRecord(projectRoot, task_id, home);
	await runWrapper(record.dir);
	const log = await readFile(logPath(record.dir), "utf8");
	assert.equal(log.trim(), `a'b two`);
	await cleanupHome(home);
});

test("a stray ) inside the command cannot escape the subshell and still records a status", async () => {
	const home = temporaryHome();
	const projectRoot = await temporaryProject(home);
	const service = new PaseoBackgroundTerminalService(new FakeTerminals(), home);
	const { task_id } = await service.exec({ command: "echo before\n)\necho after", output: "log" }, context(projectRoot));
	const record = await loadTaskRecord(projectRoot, task_id, home);
	assert.equal(await runWrapper(record.dir), 0);
	assert.equal((await statusExit(record.dir)), 1);
	const log = await readFile(logPath(record.dir), "utf8");
	assert.ok(log.includes("before"));
	assert.ok(log.includes("syntax error"), "the sourced file reports its own parse error");
	await cleanupHome(home);
});

test("group SIGINT emulates Ctrl-C and the trap records 130 within the stop window", async () => {
	const home = temporaryHome();
	const projectRoot = await temporaryProject(home);
	const service = new PaseoBackgroundTerminalService(new FakeTerminals(), home);
	const { task_id } = await service.exec({ command: "echo started; sleep 30", output: "log" }, context(projectRoot));
	const record = await loadTaskRecord(projectRoot, task_id, home);
	const exitCode = await runWrapper(record.dir, "SIGINT");
	assert.equal(exitCode, 130);
	assert.equal((await statusExit(record.dir)), 130);
	await cleanupHome(home);
});

test("status file grammar accepts exit codes, terminated, and error; junk and absence are unknown", async () => {
	const home = temporaryHome();
	const projectRoot = await temporaryProject(home);
	const service = new PaseoBackgroundTerminalService(new FakeTerminals(), home);
	const { task_id } = await service.exec({ command: "true" }, context(projectRoot));
	const record = await loadTaskRecord(projectRoot, task_id, home);
	assert.equal(await readStatusFile(record.dir), undefined);
	for (const [raw, expected] of [
		["0", { exit_code: 0 }],
		["137\n", { exit_code: 137 }],
		["terminated", { terminated: true }],
		["error", { error: true }],
	] as const) {
		await writeStatusFile(record.dir, raw);
		assert.deepEqual(await readStatusFile(record.dir), expected, raw);
	}
	await writeFile(statusPath(record.dir), "garbage");
	assert.equal(await readStatusFile(record.dir), undefined);
	await cleanupHome(home);
});

test("log reads advance a byte cursor, jump to the tail on window overflow, and never rewind", async () => {
	const home = temporaryHome();
	const projectRoot = await temporaryProject(home);
	const service = new PaseoBackgroundTerminalService(new FakeTerminals(), home);
	const { task_id } = await service.exec({ command: "true", output: "log" }, context(projectRoot));
	const record = await loadTaskRecord(projectRoot, task_id, home);

	await writeFile(logPath(record.dir), "first\nsecond\n");
	const first = await service.read({ task_id }, context(projectRoot));
	assert.equal(first, "first\nsecond\n");
	// Second read consumes nothing new.
	assert.equal(await service.read({ task_id }, context(projectRoot)), "");
	assert.equal((await loadTaskRecord(projectRoot, task_id, home)).meta.read_offset, 13);

	// A burst larger than the window drops the head and lands the cursor on the tail.
	const big = `x`.repeat(600 * 1024);
	await writeFile(logPath(record.dir), `${big}\nnew tail\n`);
	const overflow = await service.read({ task_id, output_lines: 5 }, context(projectRoot));
	assert.ok(overflow.includes("[older output dropped by the read window]"));
	assert.ok(overflow.includes("new tail"));
	assert.ok(!overflow.includes(big), "the dropped head is not re-delivered");
	assert.ok((await loadTaskRecord(projectRoot, task_id, home)).meta.read_offset >= 600 * 1024);

	// range "all" re-reads the bounded tail.
	const all = await service.read({ task_id, range: "all" }, context(projectRoot));
	assert.ok(all.includes("new tail"));
	await cleanupHome(home);
});

test("screen-mode reads render the captured terminal and trim padding", async () => {
	const home = temporaryHome();
	const projectRoot = await temporaryProject(home);
	const fake = new FakeTerminals();
	const service = new PaseoBackgroundTerminalService(fake, home);
	const { task_id } = await service.exec({ command: "vim" }, context(projectRoot));
	const record = await loadTaskRecord(projectRoot, task_id, home);
	fake.captures.set(record.meta.terminal_id, ["$ vim", "screen body", "", "", ""]);
	assert.equal(await service.read({ task_id }, context(projectRoot)), "$ vim\nscreen body");
	await cleanupHome(home);
});

test("exec creates a named session, submits only the run.sh line, and honors wait_ms", async () => {
	await withAgentId(async () => {
		const { service, fake, home, projectRoot } = await makeService();
		try {
			fake.onSubmit = (terminalId, line) => {
				assert.ok(line.startsWith("sh '"), line);
				assert.ok(!line.includes("echo"), "command bytes must not be typed into the terminal");
				const dir = dirname(line.slice("sh '".length, -1));
				void writeStatusFile(dir, "0");
				assert.equal(fake.terminals.get(terminalId)?.name, "build now");
				assert.equal(fake.terminals.get(terminalId)?.cwd, projectRoot);
			};
			const { task_id, summary } = await service.exec({ command: "make", label: "build now", wait_ms: 5_000 }, context(projectRoot));
			assert.ok(task_id.startsWith("t-"));
			assert.equal(summary.state, "exited");
			assert.equal(summary.exit_code, 0);
			const submits = fake.keys.filter((key) => key.literal);
			assert.equal(submits.length, 1);
			assert.deepEqual(fake.keys.filter((key) => !key.literal), [{ terminalId: submits[0]?.terminalId, keys: "Enter" }]);
		} finally {
			await cleanupHome(home);
		}
	});
});

test("exec reuses a session by task id and refuses dead ones", async () => {
	await withAgentId(async () => {
		const { service, fake, home, projectRoot } = await makeService();
		try {
			const first = await service.exec({ command: "cd /tmp" }, context(projectRoot));
			const second = await service.exec({ command: "pwd", session: first.task_id }, context(projectRoot));
			assert.equal(fake.terminals.size, 1, "no second terminal for a reused session");
			const secondRecord = await loadTaskRecord(projectRoot, second.task_id, home);
			const firstRecord = await loadTaskRecord(projectRoot, first.task_id, home);
			assert.equal(secondRecord.meta.terminal_id, firstRecord.meta.terminal_id);
			fake.terminals.delete(firstRecord.meta.terminal_id);
			await assert.rejects(
				service.exec({ command: "pwd", session: first.task_id }, context(projectRoot)),
				/session_not_found/,
			);
		} finally {
			await cleanupHome(home);
		}
	});
});

test("exec caps active sessions and reclaims slots of exited tasks", async () => {
	await withAgentId(async () => {
		const { service, home, projectRoot } = await makeService();
		try {
			const first = await service.exec({ command: "true" }, context(projectRoot));
			const record = await loadTaskRecord(projectRoot, first.task_id, home);
			// One live session; 16 would be needed to hit the cap.
			for (let index = 1; index < 16; index += 1) await service.exec({ command: "true" }, context(projectRoot));
			await assert.rejects(service.exec({ command: "true" }, context(projectRoot)), /too_many_active_sessions/);
			await writeStatusFile(record.dir, "0");
			const reclaimed = await service.exec({ command: "true" }, context(projectRoot));
			assert.ok(reclaimed.task_id.startsWith("t-"));
		} finally {
			await cleanupHome(home);
		}
	});
});

test("exec cleans up the record and the fresh terminal when the submit fails", async () => {
	await withAgentId(async () => {
		const { service, fake, home, projectRoot } = await makeService();
		try {
			fake.onSubmit = () => {
				throw new Error("paseo_tool_failed: send_terminal_keys: Terminal term-1 not found");
			};
			await assert.rejects(service.exec({ command: "make" }, context(projectRoot)), /not found/);
			assert.deepEqual(await listTaskRecords(projectRoot, home), []);
		} finally {
			await cleanupHome(home);
		}
	});
});

test("list derives running, exited, and orphaned states; a down daemon leaves running alone", async () => {
	await withAgentId(async () => {
		const { service, fake, home, projectRoot } = await makeService();
		try {
			const exited = await service.exec({ command: "true" }, context(projectRoot));
			await writeStatusFile((await loadTaskRecord(projectRoot, exited.task_id, home)).dir, "0");
			const running = await service.exec({ command: "true" }, context(projectRoot));
			const orphan = await service.exec({ command: "true" }, context(projectRoot));
			const orphanRecord = await loadTaskRecord(projectRoot, orphan.task_id, home);
			fake.terminals.delete(orphanRecord.meta.terminal_id);

			const listed = await service.list({}, context(projectRoot));
			const byId = new Map(listed.tasks.map((task) => [task.task_id, task]));
			assert.equal(byId.get(exited.task_id)?.state, "exited");
			assert.equal(byId.get(exited.task_id)?.exit_code, 0);
			assert.equal(byId.get(running.task_id)?.state, "running");
			assert.equal(byId.get(orphan.task_id)?.state, "orphaned");

			fake.listError = new Error("paseo_unavailable: connection refused");
			const degraded = await service.list({}, context(projectRoot));
			assert.equal(degraded.tasks.find((task) => task.task_id === running.task_id)?.state, "running");

			fake.listError = undefined;
			const single = await service.list({ task_id: exited.task_id }, context(projectRoot));
			assert.deepEqual(single.tasks.map((task) => task.task_id), [exited.task_id]);
		} finally {
			await cleanupHome(home);
		}
	});
});

test("list pages with a keyset cursor over (created_at, task_id)", async () => {
	await withAgentId(async () => {
		const { service, home, projectRoot } = await makeService();
		try {
			const ids: string[] = [];
			for (let index = 0; index < 3; index += 1) {
				const result = await service.exec({ command: "true" }, context(projectRoot));
				const record = await loadTaskRecord(projectRoot, result.task_id, home);
				await writeStatusFile(record.dir, "0");
				ids.push(result.task_id);
			}
			const page1 = await service.list({ limit: 2 }, context(projectRoot));
			assert.equal(page1.tasks.length, 2);
			assert.ok(page1.next_cursor);
			const page2 = await service.list({ limit: 2, cursor: page1.next_cursor }, context(projectRoot));
			const seen = [...page1.tasks, ...page2.tasks].map((task) => task.task_id);
			assert.equal(new Set(seen).size, 3, "pages must not overlap or skip");
			await assert.rejects(service.list({ cursor: "!!!" }, context(projectRoot)), /cursor is invalid/);
		} finally {
			await cleanupHome(home);
		}
	});
});

test("write feeds the session terminal and refuses finished or orphaned tasks", async () => {
	await withAgentId(async () => {
		const { service, fake, home, projectRoot } = await makeService();
		try {
			const task = await service.exec({ command: "cat" }, context(projectRoot));
			const record = await loadTaskRecord(projectRoot, task.task_id, home);
			await service.write({ task_id: task.task_id, input: "answer", submit: false }, context(projectRoot));
			assert.deepEqual(fake.keys.at(-1), { terminalId: record.meta.terminal_id, keys: "answer", literal: true })
			await service.write({ task_id: task.task_id, input: "go" }, context(projectRoot));
			assert.deepEqual(fake.keys.at(-1), { terminalId: record.meta.terminal_id, keys: "Enter" })

			await writeStatusFile(record.dir, "0");
			await assert.rejects(
				service.write({ task_id: task.task_id, input: "x" }, context(projectRoot)),
				/task_not_running.*finished/,
			);
			await rm(statusPath(record.dir));
			fake.terminals.delete(record.meta.terminal_id);
			await assert.rejects(
				service.write({ task_id: task.task_id, input: "x" }, context(projectRoot)),
				/task_not_running.*orphaned/,
			);
		} finally {
			await cleanupHome(home);
		}
	});
});

test("interrupt waits for the trap exit code; terminate falls back to terminated", async () => {
	await withAgentId(async () => {
		const { service, fake, home, projectRoot } = await makeService();
		try {
			const interrupt = await service.exec({ command: "sleep 30" }, context(projectRoot));
			const interruptRecord = await loadTaskRecord(projectRoot, interrupt.task_id, home);
			fake.onCtrlC = (terminalId) => {
				if (terminalId === interruptRecord.meta.terminal_id) void writeStatusFile(interruptRecord.dir, "130");
			};
			const stopped = await service.stop({ task_id: interrupt.task_id, mode: "interrupt" }, context(projectRoot));
			assert.ok(stopped.accepted);
			assert.equal(stopped.task.exit_code, 130);
			assert.ok(fake.keys.some((key) => key.keys === "C-c"));

			const terminate = await service.exec({ command: "sleep 30" }, context(projectRoot));
			const terminateRecord = await loadTaskRecord(projectRoot, terminate.task_id, home);
			const terminated = await service.stop({ task_id: terminate.task_id, mode: "terminate" }, context(projectRoot));
			assert.ok(fake.kills.includes(terminateRecord.meta.terminal_id));
			assert.equal(terminated.task.state, "exited");
			assert.equal(terminated.task.terminated, true);
			assert.equal(terminated.task.exit_code, undefined);

			const hup = await service.exec({ command: "sleep 30" }, context(projectRoot));
			const hupRecord = await loadTaskRecord(projectRoot, hup.task_id, home);
			await service.stop({ task_id: hup.task_id, mode: "terminate" }, context(projectRoot));
			assert.equal((await statusTerminated(hupRecord.dir)), true);
		} finally {
			await cleanupHome(home);
		}
	});
});

test("interrupt of a wrapper that died before its traps installed still reports terminated", async () => {
	await withAgentId(async () => {
		const { service, home, projectRoot } = await makeService();
		try {
			// fake.onCtrlC unset: no status ever appears, the live terminal stays listed.
			const racy = await service.exec({ command: "sleep 30" }, context(projectRoot));
			const stopped = await service.stop({ task_id: racy.task_id, mode: "interrupt" }, context(projectRoot));
			assert.ok(stopped.accepted);
			assert.equal(stopped.task.state, "exited");
			assert.equal(stopped.task.terminated, true);
		} finally {
			await cleanupHome(home);
		}
	});
});

test("cleanup counts and removes finished records and releases their terminals", async () => {
	await withAgentId(async () => {
		const { service, fake, home, projectRoot } = await makeService();
		try {
			const done = await service.exec({ command: "true" }, context(projectRoot));
			await writeStatusFile((await loadTaskRecord(projectRoot, done.task_id, home)).dir, "0");
			const live = await service.exec({ command: "true" }, context(projectRoot));
			const orphaned = await service.exec({ command: "true" }, context(projectRoot));
			const orphanRecord = await loadTaskRecord(projectRoot, orphaned.task_id, home);
			fake.terminals.delete(orphanRecord.meta.terminal_id);
			// 1 finished + 1 orphan whose terminal is gone are eligible; the live session is not.
			assert.deepEqual(await service.cleanup(context(projectRoot), false), { eligible: 2, removed: 0 });
			const result = await service.cleanup(context(projectRoot), true);
			assert.equal(result.removed, 2);
			assert.equal(await loadTaskRecord(projectRoot, done.task_id, home).catch(() => "gone"), "gone");
			assert.equal(await loadTaskRecord(projectRoot, orphaned.task_id, home).catch(() => "gone"), "gone");
			assert.ok(fake.terminals.has((await loadTaskRecord(projectRoot, live.task_id, home)).meta.terminal_id), "live sessions are kept");
		} finally {
			await cleanupHome(home);
		}
	});
});

test("state helpers: cwd confinement, malformed records, missing tasks, id and label rules", async () => {
	assert.throws(() => assertInsideProject("/tmp/proj", "/tmp/proj-other/x"), /inside/);
	assert.throws(() => assertInsideProject("/tmp/proj", "/tmp"), /inside/);
	assert.equal(assertInsideProject("/tmp/proj", "/tmp/proj/sub"), "/tmp/proj/sub");

	const home = temporaryHome();
	const projectRoot = await temporaryProject(home);
	try {
		const dir = taskDirectory(projectRoot, "t-broken", home);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(join(dir, "meta.json"), "{ not json");
		assert.deepEqual(await listTaskRecords(projectRoot, home), [], "malformed records are skipped, not fatal");
		await assert.rejects(loadTaskRecord(projectRoot, "t-missing", home), /task_not_found/);

		const ids = new Set(Array.from({ length: 20 }, () => newTaskId()));
		assert.equal(ids.size, 20);
		assert.equal(taskLabel("dev server", "cmd"), "dev server");
		assert.equal(taskLabel(undefined, "pnpm test\nsecond"), "pnpm test");
		assert.equal(taskLabel(undefined, "x".repeat(200)).length, 80);
	} finally {
		await cleanupHome(home);
	}
});

test("parameter bounds and cursor parsing reject bad input with invalid_arguments", () => {
	assert.throws(() => assertExecParams({ command: " " }), /command must not be empty/);
	assert.throws(() => assertExecParams({ command: "x".repeat(64 * 1024 + 1) }), /UTF-8 bytes/);
	assert.throws(() => assertExecParams({ command: "x", output: "both" as never }), /output must be/);
	assert.throws(() => assertExecParams({ command: "x", wait_ms: 301_000 }), /wait_ms/);
	assert.throws(() => assertReadParams({ task_id: "t-1", output_lines: 0 }), /output_lines/);
	assert.throws(() => assertReadParams({ task_id: "t-1", range: "tail" as never }), /range must be/);
	assert.throws(() => assertStopParams({ task_id: "t-1", mode: "kill" as never }), /mode must be/);
	assert.throws(() => assertTaskId("x".repeat(129)), /task_id/);
	assert.throws(() => assertWriteParams({ task_id: "t-1", input: "x".repeat(64 * 1024 + 1) }), /UTF-8 bytes/);
	const cursor = parseCursor(Buffer.from(JSON.stringify({ createdAt: "a", taskId: "b" })).toString("base64url"));
	assert.deepEqual(cursor, { createdAt: "a", taskId: "b" });
	assert.throws(() => parseCursor("!!!"), /cursor is invalid/);
});

test("summarizeTask maps the three states and exposes the log path only for log mode", async () => {
	const home = temporaryHome();
	const projectRoot = await temporaryProject(home);
	try {
		const service = new PaseoBackgroundTerminalService(new FakeTerminals(), home);
		const logTask = await service.exec({ command: "true", output: "log" }, context(projectRoot));
		const logRecord = await loadTaskRecord(projectRoot, logTask.task_id, home);
		const running = await summarizeTask(logRecord);
		assert.equal(running.state, "running");
		assert.ok(running.log_path);
		await writeStatusFile(logRecord.dir, "143");
		const exited = await summarizeTask(logRecord);
		assert.deepEqual([exited.state, exited.exit_code], ["exited", 143]);

		const screenTask = await service.exec({ command: "htop", output: "screen" }, context(projectRoot));
		const screenRecord = await loadTaskRecord(projectRoot, screenTask.task_id, home);
		const screenSummary = await summarizeTask(screenRecord, false);
		assert.equal(screenSummary.state, "orphaned");
		assert.equal(screenSummary.log_path, undefined);
		assert.ok(screenSummary.terminal_id);
	} finally {
		await cleanupHome(home);
	}
});

test("parentAgentId requires the Paseo agent context", () => {
	assert.throws(() => parentAgentId({}), /paseo_agent_context_missing/);
	assert.equal(parentAgentId({ PASEO_AGENT_ID: " agent-9 " }), "agent-9");
});

test("projectLogText bounds lines and bytes from the tail", () => {
	const projection = projectLogText(Array.from({ length: 30 }, (_, index) => `line-${index}`).join("\n"), 10);
	assert.ok(projection.truncated);
	assert.ok(projection.content.startsWith("line-20"));
	assert.ok(!projection.content.includes("line-10\nline-11"));
});

test("a signal to the wrapper alone still records the trap exit code immediately", async () => {
	const home = temporaryHome();
	const projectRoot = await temporaryProject(home);
	const service = new PaseoBackgroundTerminalService(new FakeTerminals(), home);
	const { task_id } = await service.exec({ command: "sleep 30" }, context(projectRoot));
	const record = await loadTaskRecord(projectRoot, task_id, home);
	// No PTY and no group kill: only the wrapper process is signaled, the hardest case.
	// detached mirrors the PTY (the wrapper owns its process group); without it the
	// wrapper's group kill would take the test runner down.
	const child = spawn("sh", [join(record.dir, "run.sh")], { detached: true, stdio: "ignore" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	const started = Date.now();
	child.kill("SIGINT");
	await new Promise((resolve) => child.once("exit", resolve));
	assert.ok(Date.now() - started < 500, "the trap fires immediately, not when the child times out");
	assert.equal((await statusExit(record.dir)), 130);
	await cleanupHome(home);
});

const processAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("a signal to the wrapper alone kills the command and its descendants, not only the wrapper", async () => {
	const home = temporaryHome();
	const projectRoot = await temporaryProject(home);
	const service = new PaseoBackgroundTerminalService(new FakeTerminals(), home);
	const pidFile = join(projectRoot, "sleeper.pid");
	const { task_id } = await service.exec({ command: `sleep 30 & echo $! > ${shellQuote(pidFile)}; wait` }, context(projectRoot));
	const record = await loadTaskRecord(projectRoot, task_id, home);
	const child = spawn("sh", [join(record.dir, "run.sh")], { detached: true, stdio: "ignore" });
	let commandPid = 0;
	for (let attempt = 0; attempt < 100 && !commandPid; attempt += 1) {
		commandPid = Number.parseInt(await readFile(pidFile, "utf8").catch(() => ""), 10) || 0;
		if (!commandPid) await delay(50);
	}
	assert.ok(commandPid > 0, "the command never reported its pid");
	child.kill("SIGINT");
	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	assert.equal((await statusExit(record.dir)), 130);
	// The daemon signals only the wrapper, so the wrapper has to take its group down.
	assert.deepEqual([exit.code, exit.signal], [130, null], "the wrapper survives its own group signal and exits 130");
	const deadline = Date.now() + 5_000;
	while (processAlive(commandPid) && Date.now() < deadline) await delay(50);
	assert.ok(!processAlive(commandPid), `sleep pid ${commandPid} survived the interrupt`);
	await cleanupHome(home);
});

test("a command reading stdin gets the terminal input instead of /dev/null", async () => {
	const home = temporaryHome();
	const projectRoot = await temporaryProject(home);
	const service = new PaseoBackgroundTerminalService(new FakeTerminals(), home);
	const { task_id } = await service.exec({ command: 'read -r line; echo "got:[$line]"', output: "log" }, context(projectRoot));
	const record = await loadTaskRecord(projectRoot, task_id, home);
	// The daemon hands the wrapper the PTY as stdin; a pipe stands in for it offline.
	const child = spawn("sh", [join(record.dir, "run.sh")], { stdio: ["pipe", "ignore", "ignore"] });
	child.stdin?.end("hello\n");
	await new Promise((resolve) => child.once("exit", resolve));
	assert.equal((await readFile(logPath(record.dir), "utf8")).trim(), "got:[hello]");
	await cleanupHome(home);
});

test("execResultText reports completion only", () => {
	const base = { task_id: "t-1", label: "x", output: "log" as const, terminal_id: "w", command: "c", cwd: "/p", created_at: "2026-01-01T00:00:00.000Z" };
	assert.equal(execResultText("t-1", { ...base, state: "running" }), "t-1");
	assert.equal(execResultText("t-1", { ...base, state: "exited", exit_code: 0 }), "t-1 exited exit=0");
	assert.equal(execResultText("t-1", { ...base, state: "exited", terminated: true }), "t-1 exited terminated");
});

test("extension registers exactly the five public background tools and the /bg command", async () => {
	const tools: Array<{ name: string; parameters: { properties?: Record<string, unknown> }; execute?: (...args: unknown[]) => Promise<unknown> }> = [];
	const commands: string[] = [];
	paseoBackgroundTerminalExtension({
		registerTool: (tool: unknown) => tools.push(tool as typeof tools[number]),
		registerCommand: (name: string) => commands.push(name),
		on: () => undefined,
	} as never);
	assert.deepEqual(tools.map((tool) => tool.name), ["background_exec", "background_list", "background_read", "background_write", "background_stop"]);
	assert.deepEqual(commands, ["bg"]);
	const exec = tools.find((tool) => tool.name === "background_exec")?.parameters.properties;
	assert.ok(exec && "session" in exec && "output" in exec && "wait_ms" in exec);
	const read = tools.find((tool) => tool.name === "background_read")?.parameters.properties;
	assert.ok(read && "range" in read && !("cursor" in read));

	const originalRead = PaseoBackgroundTerminalService.prototype.read;
	PaseoBackgroundTerminalService.prototype.read = async () => "console only";
	try {
		const execute = tools.find((tool) => tool.name === "background_read")?.execute;
		assert.deepEqual(await execute?.("call", { task_id: "t-1" }, undefined, undefined, {}), {
			content: [{ type: "text", text: "console only" }],
			details: undefined,
		});
	} finally {
		PaseoBackgroundTerminalService.prototype.read = originalRead;
	}
});
