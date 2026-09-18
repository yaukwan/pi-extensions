import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PaseoBackgroundTerminalService } from "./index.ts";

// Run inside a Paseo agent. Only terminals and records created by this probe are cleaned.
const home = await mkdtemp(join(tmpdir(), "paseo-direct-live-"));
const service = new PaseoBackgroundTerminalService(undefined, home);
const ctx = { cwd: process.cwd(), hasUI: false, isProjectTrusted: () => true } as never;
const tasks: string[] = [];
async function start(command: string, session?: string) {
	const result = await service.exec({ command, session, label: "direct terminal probe" }, ctx);
	tasks.push(result.task_id);
	return result;
}
async function expectOutput(task_id: string, pattern: RegExp) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const text = await service.read({ task_id, output_lines: 200 }, ctx);
		if (pattern.test(text)) return text;
		await delay(100);
	}
	throw new Error(`Terminal output did not match ${pattern}`);
}
try {
	const first = await start("export PASEO_PROBE_VALUE=shared; printf 'visible-%s\\n' direct");
	await expectOutput(first.task_id, /^visible-direct\r?$/m);
	const second = await start("printf 'state-%s\\n' \"$PASEO_PROBE_VALUE\"", first.task_id);
	assert.equal(second.summary.terminal_id, first.summary.terminal_id);
	await expectOutput(second.task_id, /^state-shared\r?$/m);

	const multi = await start("PASEO_PROBE_MULTI=multiple\nprintf 'lines-%s\\n' \"$PASEO_PROBE_MULTI\"", first.task_id);
	await expectOutput(multi.task_id, /^lines-multiple\r?$/m);

	const input = await start("printf 'input-%s\\n' ready; read -r reply; printf 'received-%s\\n' \"$reply\"");
	await expectOutput(input.task_id, /^input-ready\r?$/m);
	await service.write({ task_id: input.task_id, input: "hello" }, ctx);
	await expectOutput(input.task_id, /^received-hello\r?$/m);

	const sleeper = await start("printf 'sleep-%s\\n' ready; sleep 60");
	await expectOutput(sleeper.task_id, /^sleep-ready\r?$/m);
	const interrupted = await service.stop({ task_id: sleeper.task_id, mode: "interrupt" }, ctx);
	assert.equal(interrupted.task.state, "open");
	await delay(300);
	await start("printf 'after-%s\\n' interrupt", sleeper.task_id);
	await expectOutput(sleeper.task_id, /^after-interrupt\r?$/m);

	await service.stop({ task_id: first.task_id, mode: "terminate" }, ctx);
	assert.equal((await service.list({ task_id: second.task_id }, ctx)).tasks[0]?.state, "closed");
	console.log("LIVE VERIFICATION PASSED: original command, visible output, multiline input, persistent shell, stdin, Ctrl-C, termination");
} finally {
	const failures: unknown[] = [];
	for (const task_id of tasks) {
		try { await service.stop({ task_id, mode: "terminate" }, ctx); }
		catch (error) { failures.push(error); }
	}
	if (failures.length) throw new AggregateError(failures, `Probe cleanup failed; records retained in ${home}`);
	await rm(home, { recursive: true, force: true });
}
