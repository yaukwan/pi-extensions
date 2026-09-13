import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { PaseoBackgroundTerminalService } from "./index.ts";
import { paseoTerminals } from "./paseo-terminal-client.ts";

const service = new PaseoBackgroundTerminalService();
const ctx = { cwd: process.cwd(), hasUI: false, isProjectTrusted: () => true } as never;
const agent = process.env.PASEO_AGENT_ID!;

const processAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Waits for the task directory's `sleeper.pid` written by the command itself. */
async function readCommandPid(path: string): Promise<number> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const pid = Number.parseInt(await readFile(path, "utf8").catch(() => ""), 10) || 0;
		if (pid > 0) return pid;
		await delay(50);
	}
	throw new Error(`the command never reported its pid (${path})`);
}

// 1. log mode: exact bytes, real exit code, wait_ms reports completion in-call
const job = await service.exec({ command: "echo live-$(date +%s); exit 5", label: "live log", wait_ms: 15_000 }, ctx);
assert.equal(job.summary.state, "exited");
assert.equal(job.summary.exit_code, 5);
const jobOutput = await service.read({ task_id: job.task_id, range: "all" }, ctx);
assert.match(jobOutput, /^live-\d+$/m);
console.log("1 log mode ok:", jobOutput.trim(), "exit=5");

// 2. session reuse: two queued jobs on one terminal
const a = await service.exec({ command: "true", label: "live session", wait_ms: 15_000 }, ctx);
const b = await service.exec({ command: "false", session: a.task_id, wait_ms: 15_000 }, ctx);
const [sa, sb] = await Promise.all([
	service.list({ task_id: a.task_id }, ctx),
	service.list({ task_id: b.task_id }, ctx),
]);
assert.equal(sa.tasks[0]?.terminal_id, sb.tasks[0]?.terminal_id);
assert.equal(sb.tasks[0]?.exit_code, 1);
console.log("2 session reuse ok:", sa.tasks[0]?.terminal_id);

// 3. screen mode: output stays on the terminal and reads back through capture
const shown = await service.exec({ command: "echo visible-live-9x", label: "live screen", output: "screen", wait_ms: 15_000 }, ctx);
assert.equal(shown.summary.state, "exited");
assert.match(await service.read({ task_id: shown.task_id }, ctx), /visible-live-9x/);
console.log("3 screen mode ok");

// 4. interrupt on a real PTY: trap records 130 (or the stop fallback records terminated)
const sleeper = await service.exec({ command: "sleep 60", label: "live interrupt" }, ctx);
await service.read({ task_id: sleeper.task_id, wait_ms: 1_000 }, ctx);
const interrupted = await service.stop({ task_id: sleeper.task_id, mode: "interrupt" }, ctx);
assert.ok(interrupted.accepted);
assert.ok(interrupted.task.exit_code === 130 || interrupted.task.terminated === true, JSON.stringify(interrupted.task));
console.log("4 interrupt ok:", interrupted.task.exit_code === 130 ? "trap 130" : "terminated fallback");

// 5. interrupt after startup: the daemon signals only the wrapper, so its trap must take
// the whole process group down (a plain `kill "$child"` orphans the command's descendants)
const groupPidFile = "/tmp/pi-paseo-bg-live-sleeper.pid";
await rm(groupPidFile, { force: true });
const groupTask = await service.exec({ command: `sleep 300 & echo $! > ${groupPidFile}; wait`, label: "live group kill" }, ctx);
const groupCommandPid = await readCommandPid(groupPidFile);
const groupStop = await service.stop({ task_id: groupTask.task_id, mode: "interrupt" }, ctx);
assert.equal(groupStop.task.exit_code, 130, JSON.stringify(groupStop.task));
for (let attempt = 0; attempt < 100 && processAlive(groupCommandPid); attempt += 1) await delay(50);
assert.ok(!processAlive(groupCommandPid), `sleep ${groupCommandPid} survived the interrupt`);
const afterInterrupt = await service.exec({ command: "echo shell-alive", session: groupTask.task_id, wait_ms: 15_000 }, ctx);
assert.equal(afterInterrupt.summary.exit_code, 0, "the group kill must spare the session shell");
console.log("5 group interrupt ok: trap 130, command pid gone, session shell alive");

// 6. stdin reaches the command: background_write feeds the foreground process, not the session shell
const stdinTask = await service.exec({ command: 'read -r line; echo "got:[$line]"', label: "live stdin" }, ctx);
await delay(1_000);
await service.write({ task_id: stdinTask.task_id, input: "hello-live" }, ctx);
const stdinOutput = await service.read({ task_id: stdinTask.task_id, wait_ms: 10_000, range: "all" }, ctx);
assert.match(stdinOutput, /got:\[hello-live\]/);
assert.ok(!/got:\[\]/.test(stdinOutput), "the command must not see /dev/null");
console.log("6 stdin ok:", stdinOutput.trim().split("\n").at(-1));

// 7. daemon-side disappearance: orphaned, never a silent lie
const abandoned = await service.exec({ command: "sleep 60", label: "live orphan" }, ctx);
const abandonedTask = (await service.list({ task_id: abandoned.task_id }, ctx)).tasks[0];
assert.ok(abandonedTask, "abandoned task must be listed");
await paseoTerminals.killTerminal({ terminalId: abandonedTask.terminal_id, callerAgentId: agent });
const orphanCheck = await service.list({ task_id: abandoned.task_id }, ctx);
assert.equal(orphanCheck.tasks[0]?.state, "orphaned");
console.log("7 orphan detection ok");

// 8. terminate releases the session terminal
const lingering = await service.exec({ command: "sleep 60", label: "live terminate" }, ctx);
const terminated = await service.stop({ task_id: lingering.task_id, mode: "terminate" }, ctx);
assert.ok(terminated.accepted && terminated.task.state === "exited");
assert.ok(!(await paseoTerminals.listTerminals({ all: true, callerAgentId: agent })).some((terminal) => terminal.id === lingering.summary.terminal_id));
console.log("8 terminate ok");

// 9. cleanup removes finished records (and their idle terminals)
const cleaned = await service.cleanup(ctx, true);
assert.ok(cleaned.removed >= 7, JSON.stringify(cleaned));
const remaining = await service.list({}, ctx);
assert.equal(remaining.tasks.length, 0);
console.log("9 cleanup ok:", cleaned.removed, "records removed");
console.log("LIVE VERIFICATION PASSED");
