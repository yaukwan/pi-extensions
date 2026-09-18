import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Records identify terminal submissions; command lifecycle belongs to the shell. */
export type TaskStatus = "open" | "closed";

export interface TaskMeta {
	task_id: string;
	terminal_id: string;
	label: string;
	command: string;
	cwd: string;
	created_at: string;
}

export interface TaskSummary {
	task_id: string;
	label: string;
	state: TaskStatus;
	terminal_id: string;
	command: string;
	cwd: string;
	created_at: string;
}

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

export async function createTaskRecord(
	projectRoot: string,
	meta: TaskMeta,
	home = homedir(),
): Promise<string> {
	const dir = taskDirectory(projectRoot, meta.task_id, home);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await writeFile(metaPath(dir), JSON.stringify(meta, null, "\t") + "\n", { mode: 0o600 });
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
		&& typeof meta.created_at === "string";
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

export function summarizeTask({ meta }: TaskRecordView, terminalAlive: boolean): TaskSummary {
	return {
		task_id: meta.task_id,
		label: meta.label,
		state: terminalAlive ? "open" : "closed",
		terminal_id: meta.terminal_id,
		command: meta.command,
		cwd: meta.cwd,
		created_at: meta.created_at,
	};
}

export function taskSummaryText(task: TaskSummary): string {
	return `${task.task_id} [terminal ${task.state}] ${task.label}`;
}

export async function removeTaskRecord(projectRoot: string, id: string, home = homedir()): Promise<void> {
	await rm(taskDirectory(projectRoot, id, home), { recursive: true, force: true });
}
