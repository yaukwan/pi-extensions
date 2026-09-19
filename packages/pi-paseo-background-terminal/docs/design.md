# Direct Paseo terminal design

This extension exposes Paseo's terminal capabilities through five `background_*` tools. Its purpose is human–agent collaboration in the same visible console. The tools are non-blocking by design: an agent that needs a command's result before its next step should use the blocking bash tool instead of idling on a background terminal.

## Execution and output

```text
background_exec(command)
  -> create_terminal(cwd, name), or reuse a recorded terminal
  -> send_terminal_keys(command, literal: true)
  -> send_terminal_keys("Enter")

background_read(task_id)
  -> capture_terminal(terminalId, scrollback: true, stripAnsi: true)

background_write(task_id, input)
  -> send_terminal_keys(input, literal: true), optionally Enter

background_stop(task_id)
  -> send_terminal_keys("C-c"), or kill_terminal(terminalId)
```

The submitted command is the terminal input. No `sh run.sh`, sourced command file, shell trap, output redirection, or injected completion marker is added. Shell quoting, multiline commands, directory changes, exports, and history belong to the terminal's default interactive shell.

A new terminal starts at the validated `cwd`. A reused terminal retains its current directory and environment; `cwd` with `session` is rejected rather than ignored. Sending another command to a busy session may feed its foreground process. The extension has no queue or shell-readiness detector.

## State and ownership

A submission is an immutable `meta.json` record containing `task_id`, `terminal_id`, `label`, `command`, `cwd`, and `created_at`. Records live under the existing per-project state directory. IDs are validated before path resolution. Trust and initial-directory checks run before terminal creation.

`background_list` combines records with `list_terminals`:

| State | Meaning |
| --- | --- |
| `open` | Paseo currently lists the terminal. The shell may be idle or busy. |
| `closed` | Paseo no longer lists the terminal. |

A daemon error remains an error. The extension does not guess command state from a prompt, quiet output, elapsed time, or terminal presence. Sending Ctrl-C means only that input was accepted. There is no per-command exit code or completion wait in the current public terminal APIs.

The 16-terminal cap counts distinct open tracked terminal IDs, including idle shells. Several submissions can share a terminal. Termination closes that terminal for all of them. Cleanup deletes only records whose terminals are already closed and never closes open human sessions.

## Output semantics

Capture returns rendered lines, including prompts, wrapping, and the shared session's history. Reads are snapshots and can repeat content. Paseo owns the scrollback retention limit; the extension additionally bounds the returned tail by line count and byte size. Output is not retained locally after terminal closure. Missing terminals and transport errors are handled according to the daemon response; callers can query terminal presence through `background_list`.

## Migration from wrapper execution

The public `output`, `wait_ms`, and `range` parameters are removed and rejected. `TaskSummary` no longer exposes log mode, log paths, exit codes, or wrapper termination flags. Runtime state is now terminal `open` / `closed`, not command `running` / `exited` / `orphaned`.

Old files are left untouched until explicit closed-record cleanup. Required metadata fields still identify old terminals; extra historical fields have no behavioral meaning. Old `log`, `status`, `cmd.sh`, and `run.sh` files are not read or regenerated. This does not retrofit commands already running under old wrappers. Update the installed extension, refresh its tool catalog, and submit a new command to use direct execution.

## Verification

- Unit tests check original command delivery, metadata-only persistence, capture bounds, session reuse, input, interrupt semantics, shared-terminal closure, cleanup, pagination, failure handling, and removed-parameter rejection.
- `service.integration.ts` exercises the real HTTP/SSE MCP client with persistent shell processes. Pipes replace the PTY, so this is not a job-control test.
- `live.probe.ts` checks a real Paseo terminal: visible command output, persistent exports, multiline input, foreground `read`, Ctrl-C recovery, and closure. It owns isolated local records and cleans up only terminals it created.

## API evidence

- [Paseo SDK terminal reference](https://paseo.sh/docs/sdk/reference#clientterminals): input methods send without execution acknowledgement; capture returns rendered terminal lines; terminal handles provide create/list/write/sendKeys/capture/kill.
- [Paseo MCP terminals](https://paseo.sh/docs/mcp#terminals): `create_terminal`, `list_terminals`, `capture_terminal`, `send_terminal_keys`, `kill_terminal`.

The current MCP adapter already exposes these operations. A new SDK dependency or second output system is unnecessary for direct console collaboration.
