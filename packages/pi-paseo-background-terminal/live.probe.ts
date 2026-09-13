import assert from "node:assert/strict";
import { PaseoBackgroundTerminalService } from "./index.ts";
import { paseoTerminals } from "./paseo-terminal-client.ts";

const service = new PaseoBackgroundTerminalService();
const ctx = { cwd: process.cwd(), hasUI: false, isProjectTrusted: () => true } as never;
const agent = process.env.PASEO_AGENT_ID!;

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

// 5. daemon-side disappearance: orphaned, never a silent lie
const abandoned = await service.exec({ command: "sleep 60", label: "live orphan" }, ctx);
const abandonedTask = (await service.list({ task_id: abandoned.task_id }, ctx)).tasks[0];
assert.ok(abandonedTask, "abandoned task must be listed");
await paseoTerminals.killTerminal({ terminalId: abandonedTask.terminal_id, callerAgentId: agent });
const orphanCheck = await service.list({ task_id: abandoned.task_id }, ctx);
assert.equal(orphanCheck.tasks[0]?.state, "orphaned");
console.log("5 orphan detection ok");

// 6. terminate releases the session terminal
const lingering = await service.exec({ command: "sleep 60", label: "live terminate" }, ctx);
const terminated = await service.stop({ task_id: lingering.task_id, mode: "terminate" }, ctx);
assert.ok(terminated.accepted && terminated.task.state === "exited");
assert.ok(!(await paseoTerminals.listTerminals({ all: true, callerAgentId: agent })).some((terminal) => terminal.id === lingering.summary.terminal_id));
console.log("6 terminate ok");

// 7. cleanup removes finished records (and their idle terminals)
const cleaned = await service.cleanup(ctx, true);
assert.ok(cleaned.removed >= 5, JSON.stringify(cleaned));
const remaining = await service.list({}, ctx);
assert.equal(remaining.tasks.length, 0);
console.log("7 cleanup ok:", cleaned.removed, "records removed");
console.log("LIVE VERIFICATION PASSED");
