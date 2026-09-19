# pi-paseo-background-terminal

A Pi extension for direct commands in persistent [Paseo](https://paseo.sh) terminals that humans and agents can observe and control together.

## Install

```bash
pi install npm:pi-paseo-background-terminal
```

Requires a Pi session running inside a Paseo agent (`PASEO_AGENT_ID` is set by the daemon) and a reachable Paseo MCP endpoint.

## How it works

- `background_exec` sends the original command through `send_terminal_keys` with `literal: true`, then presses Enter. The command itself appears in the Paseo console.
- Commands execute in the terminal's default shell. Colors, interactive programs, shell history, `cd`, and `export` retain normal terminal behavior.
- `background_read` captures rendered terminal scrollback through Paseo. Humans see the same terminal in the app and can type into it directly.
- A task ID identifies a submission and its terminal. Local storage contains only `meta.json` under `~/.pi/pi-paseo-background-terminal/<project-hash>/tasks/<task_id>/`. No generated scripts, output logs, status files, or completion markers are created.
- Use these terminals for interactive programs and work meant to run while the agent does other things. A command whose result the next step needs belongs in the blocking bash tool: `background_*` tools never wait and never report exit codes.
- `open` / `closed` describe terminal presence. They do not describe whether a command is running, waiting for input, or finished. Paseo's terminal tools do not report per-command exit codes or completion.

## Tools

| Tool | Purpose |
| --- | --- |
| `background_exec` | `{command, cwd?, label?, session?}`. Type a command and return a `task_id` after sending input. `cwd` applies only when creating a terminal. |
| `background_list` | `{task_id?, cursor?, limit?}`. List submissions with terminal state (`open` / `closed`). Daemon errors propagate. |
| `background_read` | `{task_id, output_lines?}`. Capture recent rendered lines, including command echoes, prompts, and shared session history. |
| `background_write` | `{task_id, input, submit?}`. Send input to the foreground program or shell; `submit: false` skips Enter. |
| `background_stop` | `{task_id, mode}`. `interrupt` sends Ctrl-C without claiming completion; `terminate` closes the shared terminal. |

Example:

```json
{
  "command": "bun run check:all",
  "label": "check:all"
}
```

Use `session=<task_id>` only after observing that its shell is ready. Input goes to whichever program currently owns the terminal; there is no task queue. To change the directory of an existing session, send `cd` in the command. Metadata `cwd` records the requested starting directory for new terminals and the project context for reused submissions; it does not track later shell directory changes.

The `/bg` command provides the same controls:

```text
/bg list
/bg read <task_id>
/bg write <task_id> <input>
/bg interrupt <task_id>
/bg terminate <task_id>
/bg clean --confirm
```

Cleanup removes records only for terminals that are already closed. Open terminals remain available for human collaboration, even after their commands finish.

## Limits and migration

- At most 16 tracked open terminals per project. Close or reuse a terminal to free a slot. Commands and writes are limited to 64 KB; commands accept tabs and newlines but reject terminal control characters.
- Captures are snapshots, bounded by Paseo's scrollback and up to 2000 lines / approximately 50 KB per tool response. They are not raw stdout/stderr or incremental per-command output. Closing a terminal removes access to its capture.
- Ctrl-C is input delivery, not proof that a command stopped. Programs may ignore it. `terminate` closes the terminal for every submission sharing it.
- Removed parameters: `output`, `wait_ms`, and `range`. Stale calls reject these parameters instead of silently changing behavior. Refresh the installed extension and its tool definitions before making new calls.
- Removed result fields: `output`, `log_path`, `exit_code`, and `terminated`. The previous `running` / `exited` / `orphaned` states are replaced by terminal `open` / `closed`.
- Existing records and generated files are not automatically rewritten or deleted. Their terminal identifiers can still be used while those terminals exist, but old logs and status files are no longer read. An already-running wrapper keeps its original behavior; use a new submission for direct execution. Retain any old logs you need before explicitly cleaning closed records.

## Development

```bash
node --test --experimental-transform-types index.test.ts
node --experimental-transform-types service.integration.ts
node --experimental-transform-types live.probe.ts
```

The integration test uses real HTTP MCP calls and persistent shells with pipes. The live probe verifies actual Paseo PTY behavior and cleans up only its own terminals and records.

Design notes: [`docs/design.md`](docs/design.md).

## License

[MIT](LICENSE)
