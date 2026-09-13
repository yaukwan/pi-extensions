import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";

/**
 * Side-channel protocol: the Paseo terminal only ever receives `sh <run.sh>`.
 * Completion, exit code, and output live in files under the task directory, so
 * the task state is derived on read instead of maintained by a watcher.
 */

export type TaskOutput = "log" | "screen";
export type TaskStatus = "running" | "exited" | "orphaned";

export interface TaskMeta {
	task_id: string;
	terminal_id: string;
	label: string;
	command: string;
	cwd: string;
	output: TaskOutput;
	created_at: string;
	/** Byte cursor into the log file for "new since last read" semantics. */
	read_offset: number;
	error?: string;
}

export interface TaskSummary {
	task_id: string;
	label: string;
	state: TaskStatus;
	exit_code?: number;
	terminated?: boolean;
	output: TaskOutput;
	terminal_id: string;
	command: string;
	cwd: string;
	created_at: string;
	log_path?: string;
	error?: string;
}

/** Status file grammar: decimal exit code, "terminated" (stop), or "error" (submit failed). */
export interface StatusFile {
	exit_code?: number;
	terminated?: true;
	error?: true;
}

const READ_WINDOW_BYTES = 512 * 1024;
const LOG_ENV_EXPORTS = "export NO_COLOR=1 TERM=dumb PAGER=cat GIT_PAGER=cat GH_PAGER=cat COLORTERM=";

export function stateDirectory(home = homedir()): string {
	return join(home, ".pi", "pi-paseo-background-terminal");
}

export function projectDirectory(projectRoot: string, home = homedir()): string {
	const key = createHash("sha256").update(projectRoot).digest("hex");
	return join(stateDirectory(home), key);
}

function tasksRoot(projectRoot: string, home = homedir()): string {
	return join(projectDirectory(projectRoot, home), "tasks");
}

export function taskDirectory(projectRoot: string, id: string, home = homedir()): string {
	return join(tasksRoot(projectRoot, home), id);
}

export function metaPath(dir: string): string {
	return join(dir, "meta.json");
}

export function statusPath(dir: string): string {
	return join(dir, "status");
}

export function logPath(dir: string): string {
	return join(dir, "log");
}

/** resolve + realpath with a fallback when the path does not exist yet. */
export async function canonicalProjectRoot(cwd: string, basePath?: string): Promise<string> {
	const absolute = resolve(basePath ?? process.cwd(), cwd);
	try {
		return await realpath(absolute);
	} catch {
		return absolute;
	}
}

/** Throws when the target escapes the project root. Returns the canonical cwd. */
export function assertInsideProject(projectRoot: string, target: string): string {
	if (target !== projectRoot && !target.startsWith(`${projectRoot}${sep}`)) {
		throw new Error(`invalid_arguments: cwd must stay inside ${projectRoot}`);
	}
	return target;
}

export function newTaskId(): string {
	return `t-${randomBytes(5).toString("hex")}`;
}

/** Single-quote shell escaping for generated submit lines and wrapper paths. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function generateRunSh(paths: { cmdPath: string; statusPath: string; logPath?: string }): string {
	// The command text lives in cmd.sh and is sourced inside a subshell, so no
	// user bytes are ever embedded here: no quoting hazards, no breakouts.
	// `& wait` is the POSIX trap-safe wait idiom: a trapped signal interrupts the
	// wait immediately (a plain foreground wait may defer the trap until the
	// child exits, which costs seconds for a hung command).
	const redirect = paths.logPath ? `> ${shellQuote(paths.logPath)} 2>&1` : "";
	return [
		"#!/bin/sh",
		`status=${shellQuote(paths.statusPath)}`,
		...(paths.logPath ? [LOG_ENV_EXPORTS] : []),
		'child=""',
		'trap \'printf %s 129 > "$status"; [ -n "$child" ] && kill "$child" 2>/dev/null; exit 129\' HUP',
		'trap \'printf %s 130 > "$status"; [ -n "$child" ] && kill "$child" 2>/dev/null; exit 130\' INT',
		'trap \'printf %s 143 > "$status"; [ -n "$child" ] && kill "$child" 2>/dev/null; exit 143\' TERM',
		`( . ${shellQuote(paths.cmdPath)} ) ${redirect} &`.trimEnd(),
		'child=$!',
		'wait "$child"',
		'printf \'%s\' "$?" > "$status"',
		"",
	].join("\n");
}

export function generateSubmitLine(runShPath: string): string {
	return `sh ${shellQuote(runShPath)}`;
}

export async function createTaskRecord(
	projectRoot: string,
	meta: TaskMeta,
	home = homedir(),
): Promise<string> {
	const dir = taskDirectory(projectRoot, meta.task_id, home);
	// ponytail: no lock file — one Pi session per project is the assumption; concurrent
	// sessions would race only on meta.read_offset (worst case: a short read).
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await writeFile(metaPath(dir), JSON.stringify(meta, null, "\t") + "\n", { mode: 0o600 });
	await writeFile(join(dir, "cmd.sh"), meta.command, { mode: 0o600 });
	await writeFile(join(dir, "run.sh"), generateRunSh({
		cmdPath: join(dir, "cmd.sh"),
		statusPath: statusPath(dir),
		logPath: meta.output === "log" ? logPath(dir) : undefined,
	}), { mode: 0o700 });
	return dir;
}

function isTaskMeta(value: unknown): value is TaskMeta {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const meta = value as Record<string, unknown>;
	return typeof meta.task_id === "string"
		&& typeof meta.terminal_id === "string"
		&& typeof meta.label === "string"
		&& typeof meta.command === "string"
		&& typeof meta.cwd === "string"
		&& (meta.output === "log" || meta.output === "screen")
		&& typeof meta.created_at === "string"
		&& typeof meta.read_offset === "number";
}

export async function readTaskMeta(dir: string): Promise<TaskMeta | undefined> {
	// ponytail: malformed or half-written records are skipped in listings instead of
	// failing every call; promote to a hard error if state corruption ever matters.
	try {
		const parsed: unknown = JSON.parse(await readFile(metaPath(dir), "utf8"));
		return isTaskMeta(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export async function writeTaskMeta(dir: string, meta: TaskMeta): Promise<void> {
	await writeFile(metaPath(dir), JSON.stringify(meta, null, "\t") + "\n", { mode: 0o600 });
}

export async function readStatusFile(dir: string): Promise<StatusFile | undefined> {
	let raw: string;
	try {
		raw = (await readFile(statusPath(dir), "utf8")).trim();
	} catch {
		return undefined;
	}
	if (/^-?\d+$/.test(raw)) return { exit_code: Number.parseInt(raw, 10) };
	if (raw === "terminated") return { terminated: true };
	if (raw === "error") return { error: true };
	return undefined;
}

export async function writeStatusFile(dir: string, value: string): Promise<void> {
	await writeFile(statusPath(dir), `${value}\n`, { mode: 0o600 });
}

export interface TaskRecordView {
	meta: TaskMeta;
	dir: string;
}

export async function listTaskRecords(projectRoot: string, home = homedir()): Promise<TaskRecordView[]> {
	let entries: string[];
	try {
		entries = await readdir(tasksRoot(projectRoot, home));
	} catch {
		return [];
	}
	const records: TaskRecordView[] = [];
	for (const entry of entries) {
		const dir = join(tasksRoot(projectRoot, home), entry);
		const meta = await readTaskMeta(dir);
		if (meta) records.push({ meta, dir });
	}
	return records.sort((left, right) =>
		right.meta.created_at.localeCompare(left.meta.created_at) || right.meta.task_id.localeCompare(left.meta.task_id),
	);
}

export async function loadTaskRecord(projectRoot: string, id: string, home = homedir()): Promise<TaskRecordView> {
	const dir = taskDirectory(projectRoot, id, home);
	const meta = await readTaskMeta(dir);
	if (!meta || meta.task_id !== id) {
		throw new Error(`task_not_found: Background task ${id} was not found. Use background_list.`);
	}
	return { meta, dir };
}

export async function summarizeTask(view: TaskRecordView, terminalAlive?: boolean): Promise<TaskSummary> {
	const { meta } = view;
	const status = await readStatusFile(view.dir);
	let state: TaskStatus = "running";
	let exit_code: number | undefined;
	let terminated: boolean | undefined;
	if (status) {
		state = "exited";
		exit_code = status.exit_code;
		terminated = status.terminated;
	} else if (terminalAlive === false) {
		state = "orphaned";
	}
	return {
		task_id: meta.task_id,
		label: meta.label,
		state,
		...(exit_code !== undefined ? { exit_code } : {}),
		...(terminated ? { terminated: true } : {}),
		output: meta.output,
		terminal_id: meta.terminal_id,
		command: meta.command,
		cwd: meta.cwd,
		created_at: meta.created_at,
		...(meta.output === "log" ? { log_path: logPath(view.dir) } : {}),
		...(meta.error ? { error: meta.error } : {}),
	};
}

export function taskSummaryText(task: TaskSummary): string {
	const exit = task.exit_code === undefined ? "" : ` exit=${task.exit_code}`;
	const terminated = task.terminated ? " terminated" : "";
	return `${task.task_id} [${task.state}] ${task.label}${exit}${terminated}`;
}

/**
 * Reads a bounded window of the log file. When the requested window cannot hold
 * everything new, the cursor jumps to the file end (head dropped, tail kept) so a
 * slow reader never creates an unbounded gap.
 */
export async function readLogSlice(
	path: string,
	offset: number,
	range: "new" | "all",
): Promise<{ text: string; nextOffset: number; windowTruncated: boolean }> {
	let size: number;
	try {
		size = (await stat(path)).size;
	} catch {
		return { text: "", nextOffset: offset, windowTruncated: false };
	}
	let start: number;
	let end: number;
	let windowTruncated = false;
	if (range === "all") {
		start = Math.max(0, size - READ_WINDOW_BYTES);
		end = size;
	} else {
		start = Math.min(Math.max(offset, 0), size);
		end = Math.min(size, start + READ_WINDOW_BYTES);
		// A burst larger than the window drops the head and lands the cursor on the
		// tail of what is new, so a slow reader never creates an unbounded gap.
		windowTruncated = size - start > READ_WINDOW_BYTES;
		if (windowTruncated) {
			start = size - READ_WINDOW_BYTES;
			end = size;
		}
	}
	if (start >= end) return { text: "", nextOffset: Math.min(offset, size), windowTruncated: false };
	const handle = await open(path, "r");
	try {
		const length = end - start;
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, start);
		// A UTF-8 sequence split at the window boundary decodes to U+FFFD; byte-accurate
		// carry-over is not worth the bookkeeping.
		return { text: buffer.toString("utf8"), nextOffset: end, windowTruncated };
	} finally {
		await handle.close();
	}
}

export function projectLogText(text: string, maxLines?: number, maxBytes?: number) {
	return truncateTail(text, {
		maxLines: maxLines ?? DEFAULT_MAX_LINES,
		maxBytes: maxBytes ?? DEFAULT_MAX_BYTES,
	});
}

export async function removeTaskRecord(projectRoot: string, id: string, home = homedir()): Promise<void> {
	await rm(taskDirectory(projectRoot, id, home), { recursive: true, force: true });
}
