export type BackgroundExecParams = {
	command: string;
	cwd?: string;
	label?: string;
	session?: string;
};

export type BackgroundListParams = {
	task_id?: string;
	cursor?: string;
	limit?: number;
};

export type BackgroundReadParams = {
	task_id: string;
	output_lines?: number;
};

export type BackgroundWriteParams = {
	task_id: string;
	input: string;
	submit?: boolean;
};

export type BackgroundStopParams = {
	task_id: string;
	mode: "interrupt" | "terminate";
};

export const MAX_TASK_ID_LENGTH = 128;
export const MAX_CURSOR_LENGTH = 512;
export const MAX_CWD_LENGTH = 4096;
export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_LABEL_LENGTH = 80;
export const MAX_OUTPUT_LINES = 2000;
export const MAX_LIST_LIMIT = 100;

function assertUtf8Bytes(value: string, maximum: number, name: string): void {
	if (Buffer.byteLength(value, "utf8") > maximum) {
		throw new Error(`invalid_arguments: ${name} must be at most ${maximum} UTF-8 bytes.`);
	}
}

export function assertTaskId(value: string): void {
	if (typeof value !== "string" || !/^t-[a-zA-Z0-9_-]+$/.test(value) || value.length > MAX_TASK_ID_LENGTH) {
		throw new Error("invalid_arguments: task_id must be an opaque t- identifier returned by background_exec.");
	}
}

function assertKeys(params: object, keys: string[]): void {
	if (Object.keys(params).some((key) => !keys.includes(key))) {
		throw new Error(`invalid_arguments: supported parameters are ${keys.join(", ")}. Reload the extension's tool definitions.`);
	}
}

export function assertCursor(value: string | undefined): void {
	if (value !== undefined && (typeof value !== "string" || value.length > MAX_CURSOR_LENGTH)) {
		throw new Error(`invalid_arguments: cursor must be at most ${MAX_CURSOR_LENGTH} characters.`);
	}
}

export function assertExecParams(params: BackgroundExecParams): void {
	assertKeys(params, ["command", "cwd", "label", "session"]);
	if (typeof params.command !== "string" || !params.command.trim()) throw new Error("invalid_arguments: command must not be empty.");
	assertUtf8Bytes(params.command, MAX_PAYLOAD_BYTES, "command");
	if (/[\x00-\x08\x0b-\x1f\x7f]/.test(params.command)) {
		throw new Error("invalid_arguments: command must not contain terminal control characters; use background_write or background_stop for terminal input.");
	}
	if (params.cwd !== undefined && (typeof params.cwd !== "string" || params.cwd.length > MAX_CWD_LENGTH)) {
		throw new Error(`invalid_arguments: cwd must be at most ${MAX_CWD_LENGTH} characters.`);
	}
	if (params.label !== undefined && (typeof params.label !== "string" || !params.label.trim() || params.label.length > MAX_LABEL_LENGTH)) {
		throw new Error(`invalid_arguments: label must be 1-${MAX_LABEL_LENGTH} characters.`);
	}
	if (params.session !== undefined) assertTaskId(params.session);
	if (params.session !== undefined && params.cwd !== undefined) {
		throw new Error("invalid_arguments: cwd only applies to a new terminal. Use cd in the command to change an existing session's directory.");
	}
}

export function assertReadParams(params: BackgroundReadParams): void {
	assertKeys(params, ["task_id", "output_lines"]);
	assertTaskId(params.task_id);
	if (params.output_lines !== undefined && (!Number.isInteger(params.output_lines) || params.output_lines < 1 || params.output_lines > MAX_OUTPUT_LINES)) {
		throw new Error(`invalid_arguments: output_lines must be 1-${MAX_OUTPUT_LINES}.`);
	}
}

export function assertWriteParams(params: BackgroundWriteParams): void {
	assertKeys(params, ["task_id", "input", "submit"]);
	assertTaskId(params.task_id);
	if (typeof params.input !== "string") throw new Error("invalid_arguments: input must be a string.");
	assertUtf8Bytes(params.input, MAX_PAYLOAD_BYTES, "input");
	if (params.submit !== undefined && typeof params.submit !== "boolean") throw new Error("invalid_arguments: submit must be a boolean.");
}

export function assertStopParams(params: BackgroundStopParams): void {
	assertKeys(params, ["task_id", "mode"]);
	assertTaskId(params.task_id);
	if (params.mode !== "interrupt" && params.mode !== "terminate") {
		throw new Error(`invalid_arguments: mode must be "interrupt" or "terminate".`);
	}
}
